import * as vscode from 'vscode';
import { LmService } from '../managers/lmService';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';

/**
 * Registers a GitHub Copilot Chat participant via the vscode.chat API.
 *
 * The vscode.chat namespace was introduced in VS Code 1.86 and is not present
 * in Azure Data Studio (VS Code 1.82), so this function always returns a no-op
 * disposable in ADS. All chat functionality is provided through the side panel
 * WebView instead.
 */
export function registerChatParticipant(
    _context: vscode.ExtensionContext,
    _lmService: LmService,
    _connectionManager: ConnectionManager
): vscode.Disposable {
    logger.info('vscode.chat API not available in this host – chat participant not registered');
    return { dispose: () => undefined };
}
