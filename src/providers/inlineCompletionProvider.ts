import * as vscode from 'vscode';
import { LmService } from '../managers/lmService';
import { logger } from '../utils/logger';
import { inlineCompletionsEnabled } from '../utils/config';

/**
 * Provides Copilot-powered inline SQL completions (ghost text).
 * Registered for SQL-family languages via vscode.InlineCompletionItemProvider.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    /** Minimum characters of SQL before attempting a completion. */
    private static readonly MIN_PREFIX_LENGTH = 6;

    /** Debounce delay in milliseconds to avoid firing on every keystroke. */
    private static readonly DEBOUNCE_MS = 500;

    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly lmService: LmService) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null> {
        if (!inlineCompletionsEnabled()) {
            return null;
        }

        // Build the text before and after the cursor
        const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const suffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));

        // Don't trigger if the prefix is too short
        if (prefix.trim().length < InlineCompletionProvider.MIN_PREFIX_LENGTH) {
            return null;
        }

        // Don't trigger mid-word (wait for whitespace/newline)
        const charBeforeCursor = prefix.length > 0 ? prefix[prefix.length - 1] : '';
        if (/\w/.test(charBeforeCursor)) {
            return null;
        }

        return new Promise<vscode.InlineCompletionList | null>((resolve) => {
            if (this._debounceTimer) {
                clearTimeout(this._debounceTimer);
            }

            this._debounceTimer = setTimeout(async () => {
                if (token.isCancellationRequested) {
                    resolve(null);
                    return;
                }

                try {
                    const completion = await this.lmService.inlineComplete(prefix, suffix, token);
                    if (!completion || token.isCancellationRequested) {
                        resolve(null);
                        return;
                    }

                    const item = new vscode.InlineCompletionItem(
                        completion,
                        new vscode.Range(position, position)
                    );

                    resolve(new vscode.InlineCompletionList([item]));
                } catch (err) {
                    if (!(err instanceof vscode.CancellationError)) {
                        logger.warn('InlineCompletionProvider error', err);
                    }
                    resolve(null);
                }
            }, InlineCompletionProvider.DEBOUNCE_MS);
        });
    }
}
