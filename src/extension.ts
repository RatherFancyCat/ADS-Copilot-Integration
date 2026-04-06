import * as vscode from 'vscode';
import { logger, initLogger, setLogLevel, logLevelFromString } from './utils/logger';
import { logLevel, isEnabled, inlineCompletionsEnabled } from './utils/config';
import { ConnectionManager } from './managers/connectionManager';
import { LmService } from './managers/lmService';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { SqlCodeLensProvider } from './providers/codeLensProvider';
import { registerChatParticipant } from './providers/chatParticipant';
import { ChatPanel } from './ui/chatPanel';

const SQL_LANGUAGES = ['sql', 'pgsql', 'mysql'];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ── Logging ────────────────────────────────────────────────────────────────
    const outputChannel = vscode.window.createOutputChannel('GitHub Copilot for ADS');
    context.subscriptions.push(outputChannel);
    initLogger(outputChannel);
    setLogLevel(logLevelFromString(logLevel()));
    logger.info('GitHub Copilot for ADS extension activating…');

    // ── Core services ──────────────────────────────────────────────────────────
    const connectionManager = new ConnectionManager();
    context.subscriptions.push(connectionManager);

    const lmService = new LmService(connectionManager);

    // ── Inline completions ─────────────────────────────────────────────────────
    if (inlineCompletionsEnabled()) {
        const inlineProvider = new InlineCompletionProvider(lmService);
        SQL_LANGUAGES.forEach(lang => {
            context.subscriptions.push(
                vscode.languages.registerInlineCompletionItemProvider(
                    { language: lang },
                    inlineProvider
                )
            );
        });
        logger.info('Inline completion provider registered for SQL languages');
    }

    // ── CodeLens ───────────────────────────────────────────────────────────────
    const codeLensProvider = new SqlCodeLensProvider(lmService);
    context.subscriptions.push(codeLensProvider);
    SQL_LANGUAGES.forEach(lang => {
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ language: lang }, codeLensProvider)
        );
    });
    logger.info('CodeLens provider registered for SQL languages');

    // ── Chat participant (requires Copilot Chat ≥ 0.12 / VS Code 1.85+) ───────
    const chatParticipantDisposable = registerChatParticipant(context, lmService, connectionManager);
    context.subscriptions.push(chatParticipantDisposable);

    // ── Commands ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ads-copilot.openChat', () => {
            ChatPanel.createOrShow(context.extensionUri, lmService, connectionManager);
        }),

        vscode.commands.registerCommand('ads-copilot.explainQuery', async (sqlArg?: string) => {
            const sql = sqlArg ?? getSelectionOrDocument();
            if (!sql) {
                vscode.window.showWarningMessage('Select a SQL query first.');
                return;
            }
            await runWithProgress('Explaining query…', async (token) => {
                const response = await lmService.explainQuery(sql, token);
                showResultPanel(context.extensionUri, 'Query Explanation', response.text, response.model);
            });
        }),

        vscode.commands.registerCommand('ads-copilot.generateQuery', async () => {
            const description = await vscode.window.showInputBox({
                prompt: 'Describe the SQL query you want to generate',
                placeHolder: 'e.g. "list all orders placed in the last 7 days with customer name"'
            });
            if (!description) {
                return;
            }
            await runWithProgress('Generating SQL…', async (token) => {
                const response = await lmService.generateQuery(description, token);
                insertOrShowSql(response.text, response.model);
            });
        }),

        vscode.commands.registerCommand('ads-copilot.fixQuery', async (sqlArg?: string) => {
            const sql = sqlArg ?? getSelectionOrDocument();
            if (!sql) {
                vscode.window.showWarningMessage('Select a SQL query to fix first.');
                return;
            }
            const errorMsg = await vscode.window.showInputBox({
                prompt: 'Paste the error message (optional – press Enter to skip)',
                placeHolder: 'e.g. "Incorrect syntax near \'WHERE\'"'
            }) ?? '';
            await runWithProgress('Fixing SQL…', async (token) => {
                const response = await lmService.fixQuery(sql, errorMsg, token);
                insertOrShowSql(response.text, response.model);
            });
        }),

        vscode.commands.registerCommand('ads-copilot.optimizeQuery', async (sqlArg?: string) => {
            const sql = sqlArg ?? getSelectionOrDocument();
            if (!sql) {
                vscode.window.showWarningMessage('Select a SQL query to optimise first.');
                return;
            }
            await runWithProgress('Optimising query…', async (token) => {
                const response = await lmService.optimizeQuery(sql, token);
                showResultPanel(context.extensionUri, 'Query Optimisation', response.text, response.model);
            });
        })
    );

    // ── Status-bar item ────────────────────────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.text = '$(sparkle) Copilot';
    statusBarItem.tooltip = 'GitHub Copilot for Azure Data Studio';
    statusBarItem.command = 'ads-copilot.openChat';
    context.subscriptions.push(statusBarItem);

    // Show status bar only for SQL files
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && SQL_LANGUAGES.includes(editor.document.languageId)) {
                statusBarItem.show();
            } else {
                statusBarItem.hide();
            }
        })
    );

    // Initial visibility
    if (vscode.window.activeTextEditor &&
        SQL_LANGUAGES.includes(vscode.window.activeTextEditor.document.languageId)) {
        statusBarItem.show();
    }

    // ── Configuration change handling ──────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ads-copilot.logLevel')) {
                setLogLevel(logLevelFromString(logLevel()));
                logger.info('Log level updated');
            }
        })
    );

    // ── LM availability check (non-blocking) ───────────────────────────────────
    lmService.isAvailable().then(available => {
        if (!available) {
            logger.warn(
                'GitHub Copilot language model not available. ' +
                'Install the "GitHub Copilot Chat" extension and sign in to enable AI features.'
            );
        } else {
            logger.info('Language model available – AI features enabled');
        }
    }).catch(() => { /* ignore */ });

    logger.info('GitHub Copilot for ADS extension activated');
    vscode.commands.executeCommand('setContext', 'ads-copilot.active', true);
}

export function deactivate(): void {
    logger.info('GitHub Copilot for ADS extension deactivated');
    vscode.commands.executeCommand('setContext', 'ads-copilot.active', false);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSelectionOrDocument(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return '';
    }
    if (!editor.selection.isEmpty) {
        return editor.document.getText(editor.selection).trim();
    }
    return editor.document.getText().trim();
}

async function runWithProgress(
    title: string,
    task: (token: vscode.CancellationToken) => Promise<void>
): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: true
        },
        async (_progress, token) => {
            try {
                await task(token);
            } catch (err) {
                if (err instanceof vscode.CancellationError) {
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                logger.error('Command failed', err);
                vscode.window.showErrorMessage(`Copilot: ${message}`);
            }
        }
    );
}

/** Insert SQL at the cursor position; if no editor open, show in a webview. */
function insertOrShowSql(sql: string, model: string): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && SQL_LANGUAGES.includes(editor.document.languageId)) {
        editor.edit(eb => {
            eb.replace(editor.selection.isEmpty
                ? new vscode.Range(editor.selection.active, editor.selection.active)
                : editor.selection,
                sql
            );
        });
        vscode.window.setStatusBarMessage(`$(sparkle) Copilot inserted SQL (${model})`, 4000);
    } else {
        showResultPanel(undefined, 'Generated SQL', sql, model);
    }
}

/** Show a result in a simple read-only document. */
function showResultPanel(
    _extensionUri: vscode.Uri | undefined,
    title: string,
    content: string,
    model: string
): void {
    vscode.workspace.openTextDocument({
        language: 'markdown',
        content: `# ${title}\n\n${content}\n\n---\n*Powered by ${model}*`
    }).then(doc => {
        vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
            preserveFocus: false
        });
    });
}
