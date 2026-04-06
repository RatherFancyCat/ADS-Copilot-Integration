import * as vscode from 'vscode';

export enum LogLevel {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3
}

const LEVEL_NAMES: Record<LogLevel, string> = {
    [LogLevel.Error]: 'ERROR',
    [LogLevel.Warn]:  'WARN',
    [LogLevel.Info]:  'INFO',
    [LogLevel.Debug]: 'DEBUG'
};

let outputChannel: vscode.OutputChannel | undefined;
let currentLevel: LogLevel = LogLevel.Info;

export function initLogger(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

function log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level > currentLevel || !outputChannel) {
        return;
    }
    const timestamp = new Date().toISOString();
    const extra = args.length > 0
        ? ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        : '';
    outputChannel.appendLine(`[${timestamp}] [${LEVEL_NAMES[level]}] ${message}${extra}`);
}

export const logger = {
    error(message: string, ...args: unknown[]): void { log(LogLevel.Error, message, ...args); },
    warn(message:  string, ...args: unknown[]): void { log(LogLevel.Warn,  message, ...args); },
    info(message:  string, ...args: unknown[]): void { log(LogLevel.Info,  message, ...args); },
    debug(message: string, ...args: unknown[]): void { log(LogLevel.Debug, message, ...args); }
};

export function logLevelFromString(value: string): LogLevel {
    switch (value.toLowerCase()) {
        case 'error': return LogLevel.Error;
        case 'warn':  return LogLevel.Warn;
        case 'debug': return LogLevel.Debug;
        default:      return LogLevel.Info;
    }
}
