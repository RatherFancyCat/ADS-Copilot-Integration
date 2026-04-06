import * as vscode from 'vscode';

/**
 * Wraps VS Code configuration access for the ads-copilot namespace.
 */
export function getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration('ads-copilot').get<T>(key, defaultValue);
}

export function isEnabled(): boolean {
    return getConfig<boolean>('enable', true);
}

export function inlineCompletionsEnabled(): boolean {
    return isEnabled() && getConfig<boolean>('inlineCompletions', true);
}

export function includeSchemaContext(): boolean {
    return getConfig<boolean>('includeSchemaContext', true);
}

export function codeLensEnabled(): boolean {
    return getConfig<boolean>('codeLens', true);
}

export function preferredModel(): string {
    return getConfig<string>('model', 'gpt-4o');
}

export function maxTokens(): number {
    return getConfig<number>('maxTokens', 1024);
}

export function logLevel(): string {
    return getConfig<string>('logLevel', 'info');
}
