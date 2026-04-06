import * as vscode from 'vscode';
import { LmService } from '../managers/lmService';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';
import { truncate } from '../utils/sqlUtils';

const PARTICIPANT_ID = 'ads-copilot.sql';

/**
 * Registers a GitHub Copilot Chat participant (@sql) that handles SQL-specific
 * commands and general SQL questions in the Copilot Chat panel.
 *
 * Available slash commands:
 *   /explain   – explain the selected or provided SQL
 *   /generate  – generate SQL from a description
 *   /fix       – fix a broken query
 *   /optimize  – suggest performance improvements
 *   /schema    – show the active database schema
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    lmService: LmService,
    connectionManager: ConnectionManager
): vscode.Disposable {
    // Guard: vscode.chat API requires VS Code 1.85+
    if (!vscode.chat) {
        logger.warn('vscode.chat API not available – chat participant not registered');
        return { dispose: () => undefined };
    }

    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        async (request, _context, stream, token) => {
            const command = request.command;
            const userText = request.prompt.trim();

            try {
                switch (command) {
                    case 'explain':
                        await handleExplain(userText, lmService, stream, token);
                        break;
                    case 'generate':
                        await handleGenerate(userText, lmService, stream, token);
                        break;
                    case 'fix':
                        await handleFix(userText, lmService, stream, token);
                        break;
                    case 'optimize':
                        await handleOptimize(userText, lmService, stream, token);
                        break;
                    case 'schema':
                        await handleSchema(connectionManager, stream);
                        break;
                    default:
                        // No slash command — treat as a general SQL question
                        await handleGeneral(userText, lmService, stream, token);
                }
            } catch (err) {
                if (err instanceof vscode.CancellationError) {
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                logger.error('Chat participant error', err);
                stream.markdown(`❌ **Error:** ${message}`);
            }
        }
    );

    participant.iconPath = new vscode.ThemeIcon('sparkle');
    participant.followupProvider = {
        provideFollowups(_result, _context, _token) {
            return [
                { prompt: '/explain', label: 'Explain this query', command: 'explain' },
                { prompt: '/optimize', label: 'Optimise this query', command: 'optimize' }
            ];
        }
    };

    logger.info('Copilot chat participant registered');
    return participant;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleExplain(
    prompt: string,
    lmService: LmService,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const sql = extractSql(prompt) || getEditorSelection();
    if (!sql) {
        stream.markdown('Please provide a SQL query to explain, or select one in the editor.');
        return;
    }
    stream.markdown('Analysing your query…\n\n');
    const response = await lmService.explainQuery(sql, token);
    stream.markdown(response.text);
    stream.markdown(`\n\n*Powered by ${response.model}*`);
}

async function handleGenerate(
    prompt: string,
    lmService: LmService,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    if (!prompt) {
        stream.markdown('Please describe the query you want to generate. For example:\n`/generate list all customers who made a purchase in the last 30 days`');
        return;
    }
    stream.markdown('Generating SQL…\n\n');
    const response = await lmService.generateQuery(prompt, token);
    stream.markdown('```sql\n' + response.text + '\n```');
    stream.markdown(`\n\n*Powered by ${response.model}*`);
}

async function handleFix(
    prompt: string,
    lmService: LmService,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const sql = extractSql(prompt) || getEditorSelection();
    if (!sql) {
        stream.markdown('Please provide the broken SQL query to fix, or select it in the editor.');
        return;
    }
    stream.markdown('Examining your query for errors…\n\n');
    const response = await lmService.fixQuery(sql, '', token);
    stream.markdown('```sql\n' + response.text + '\n```');
    stream.markdown(`\n\n*Powered by ${response.model}*`);
}

async function handleOptimize(
    prompt: string,
    lmService: LmService,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const sql = extractSql(prompt) || getEditorSelection();
    if (!sql) {
        stream.markdown('Please provide a SQL query to optimise, or select one in the editor.');
        return;
    }
    stream.markdown('Reviewing your query for performance improvements…\n\n');
    const response = await lmService.optimizeQuery(sql, token);
    stream.markdown(response.text);
    stream.markdown(`\n\n*Powered by ${response.model}*`);
}

async function handleSchema(
    connectionManager: ConnectionManager,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const schema = await connectionManager.getSchemaInfo();
    if (!schema) {
        stream.markdown('No active database connection found. Connect to a database in Azure Data Studio first.');
        return;
    }
    if (schema.tables.length === 0) {
        stream.markdown(`Connected to **${schema.databaseName}** but no tables were found.`);
        return;
    }
    const tableList = schema.tables
        .slice(0, 50)
        .map(t => `- \`${t.schema}.${t.name}\``)
        .join('\n');
    const more = schema.tables.length > 50 ? `\n*… and ${schema.tables.length - 50} more*` : '';
    stream.markdown(`## Schema: ${schema.databaseName}\n\n${tableList}${more}`);
}

async function handleGeneral(
    prompt: string,
    lmService: LmService,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    if (!prompt) {
        stream.markdown(
            'Hi! I\'m your SQL Copilot for Azure Data Studio. I can help you:\n\n' +
            '- **/explain** – Explain what a SQL query does\n' +
            '- **/generate** – Generate SQL from a description\n' +
            '- **/fix** – Fix errors in a SQL query\n' +
            '- **/optimize** – Suggest performance improvements\n' +
            '- **/schema** – Show the active database schema\n\n' +
            'Or just ask me anything about SQL!'
        );
        return;
    }
    const response = await lmService.chat(prompt, token);
    stream.markdown(response.text);
    stream.markdown(`\n\n*Powered by ${response.model}*`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract SQL from a fenced code block in the prompt, if present. */
function extractSql(text: string): string {
    const match = text.match(/```sql\n([\s\S]+?)\n```/i);
    if (match) {
        return match[1].trim();
    }
    // Also accept bare SQL (starts with a keyword)
    const trimmed = text.trim();
    const sqlKeywords = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|EXEC|MERGE)\b/i;
    if (sqlKeywords.test(trimmed)) {
        return trimmed;
    }
    return '';
}

/** Get the currently selected text in the active editor. */
function getEditorSelection(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        return '';
    }
    return editor.document.getText(editor.selection).trim();
}
