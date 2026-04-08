import * as vscode from 'vscode';
import { LmService } from '../managers/lmService';
import { logger } from '../utils/logger';
import { codeLensEnabled } from '../utils/config';
import { splitStatements, extractStatementAtOffset, basename } from '../utils/sqlUtils';

/**
 * Adds Copilot action lenses above SQL queries.
 * Each lens command operates on the SQL statement that the lens is anchored to.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private readonly _disposables: vscode.Disposable[] = [this._onDidChangeCodeLenses];

    constructor(private readonly _lmService: LmService) {
        // Re-compute lenses when configuration changes
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('ads-copilot')) {
                    this._onDidChangeCodeLenses.fire();
                }
            })
        );
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!codeLensEnabled()) {
            return [];
        }

        const text = document.getText();
        const lenses: vscode.CodeLens[] = [];
        const statements = splitStatements(text);

        let offset = 0;
        for (const stmt of statements) {
            // Find the statement's start position in the document
            const stmtStart = text.indexOf(stmt, offset);
            if (stmtStart === -1) {
                continue;
            }
            offset = stmtStart + stmt.length;

            const startPos = document.positionAt(stmtStart);
            const range = new vscode.Range(startPos, startPos);

            lenses.push(
                new vscode.CodeLens(range, {
                    title: '$(sparkle) Explain',
                    command: 'ads-copilot.explainQuery',
                    tooltip: 'Explain this SQL query with Copilot',
                    arguments: [stmt]
                }),
                new vscode.CodeLens(range, {
                    title: '$(rocket) Optimise',
                    command: 'ads-copilot.optimizeQuery',
                    tooltip: 'Suggest optimisations for this query',
                    arguments: [stmt]
                }),
                new vscode.CodeLens(range, {
                    title: '$(wrench) Fix',
                    command: 'ads-copilot.fixQuery',
                    tooltip: 'Fix issues in this query',
                    arguments: [stmt]
                })
            );
        }

        return lenses;
    }

    resolveCodeLens(lens: vscode.CodeLens): vscode.CodeLens {
        return lens;
    }

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
