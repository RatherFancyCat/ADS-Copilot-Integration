import * as vscode from 'vscode';
import { LmService, ModelInfo, CopilotResponse } from '../managers/lmService';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';
import { basename } from '../utils/sqlUtils';

const GITHUB_AUTH_PROVIDER = 'github';
const GITHUB_SCOPES = ['read:user'];

interface ChatMessage {
    role: 'user' | 'assistant' | 'error';
    content: string;
}

/**
 * WebviewViewProvider that powers the Copilot side panel in the activity bar.
 * Handles GitHub authentication, model discovery, and conversational chat.
 */
export class SidePanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly VIEW_ID = 'ads-copilot-chat';

    private _view?: vscode.WebviewView;
    private _session: vscode.AuthenticationSession | undefined;
    private _history: ChatMessage[] = [];
    private _selectedModelId: string | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _lmService: LmService,
        private readonly _connectionManager: ConnectionManager
    ) {
        // Re-initialize whenever the user's GitHub session changes
        this._disposables.push(
            vscode.authentication.onDidChangeSessions(async (e: vscode.AuthenticationSessionsChangeEvent) => {
                if (e.provider.id === GITHUB_AUTH_PROVIDER) {
                    await this._refreshAuth();
                }
            })
        );
    }

    // ── WebviewViewProvider ──────────────────────────────────────────────────

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            (msg: { type: string; text?: string; modelId?: string }) => this._handleMessage(msg),
            null,
            this._disposables
        );
    }

    // ── Message handling ─────────────────────────────────────────────────────

    private async _handleMessage(message: {
        type: string;
        text?: string;
        modelId?: string;
        mode?: 'selection' | 'document';
        code?: string;
    }): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this._initialize();
                break;
            case 'signIn':
                await this._signIn();
                break;
            case 'signOut':
                await this._signOut();
                break;
            case 'selectModel':
                this._selectedModelId = message.modelId;
                break;
            case 'userMessage':
                await this._processUserMessage(message.text ?? '');
                break;
            case 'clearHistory':
                this._history = [];
                this._postMessage({ type: 'cleared' });
                break;
            case 'requestEditorContext':
                this._handleRequestEditorContext(message.mode ?? 'selection');
                break;
            case 'insertCode':
                this._handleInsertCode(message.code ?? '');
                break;
            case 'copyCode':
                vscode.env.clipboard.writeText(message.code ?? '');
                break;
        }
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    private async _initialize(): Promise<void> {
        this._postMessage({ type: 'loading' });
        try {
            this._session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER,
                GITHUB_SCOPES,
                { createIfNone: false }
            );
        } catch (err) {
            logger.warn('Could not retrieve GitHub session on init', err);
            this._session = undefined;
        }
        await this._sendAuthState();
    }

    private async _signIn(): Promise<void> {
        try {
            this._session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER,
                GITHUB_SCOPES,
                { createIfNone: true }
            );
            await this._sendAuthState();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('GitHub sign-in failed', err);
            this._postMessage({ type: 'authError', message: msg });
        }
    }

    private async _signOut(): Promise<void> {
        this._session = undefined;
        this._history = [];
        this._postMessage({ type: 'signedOut' });
    }

    private async _refreshAuth(): Promise<void> {
        try {
            this._session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER,
                GITHUB_SCOPES,
                { createIfNone: false }
            );
        } catch {
            this._session = undefined;
        }
        await this._sendAuthState();
    }

    private async _sendAuthState(): Promise<void> {
        if (!this._session) {
            this._postMessage({ type: 'signedOut' });
            return;
        }

        const username = this._session.account.label;
        const avatarUrl = `https://github.com/${username}.png?size=32`;
        const models = await this._loadModels();

        if (!this._selectedModelId && models.length > 0) {
            this._selectedModelId = models[0].id;
        }

        this._postMessage({
            type: 'signedIn',
            user: { login: username, avatarUrl },
            models,
            selectedModelId: this._selectedModelId
        });

        // Replay conversation history
        for (const msg of this._history) {
            this._postMessage({ type: 'message', message: msg });
        }
    }

    // ── Models ───────────────────────────────────────────────────────────────

    private async _loadModels(): Promise<ModelInfo[]> {
        return this._lmService.listModels();
    }

    private async _processUserMessage(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) { return; }

        if (!this._session) {
            this._postMessage({
                type: 'message',
                message: { role: 'error', content: 'Please sign in with GitHub to use Copilot.' }
            });
            return;
        }

        if (trimmed.startsWith('/')) {
            await this._handleSlashCommand(trimmed);
            return;
        }

        const userMsg: ChatMessage = { role: 'user', content: trimmed };
        this._history.push(userMsg);
        this._postMessage({ type: 'message', message: userMsg });
        this._postMessage({ type: 'thinking' });

        const cts = new vscode.CancellationTokenSource();
        try {
            const response = await this._lmService.chat(trimmed, cts.token, true, this._selectedModelId);
            const assistantMsg: ChatMessage = { role: 'assistant', content: response.text };
            this._history.push(assistantMsg);
            this._postMessage({ type: 'message', message: assistantMsg });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('SidePanel LM error', err);
            const errorMsg: ChatMessage = { role: 'error', content: msg };
            this._history.push(errorMsg);
            this._postMessage({ type: 'message', message: errorMsg });
        } finally {
            cts.dispose();
            this._postMessage({ type: 'doneThinking' });
        }
    }

    private async _handleSlashCommand(text: string): Promise<void> {
        const spaceIdx = text.indexOf(' ');
        const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
        const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

        const userMsg: ChatMessage = { role: 'user', content: text };
        this._history.push(userMsg);
        this._postMessage({ type: 'message', message: userMsg });
        this._postMessage({ type: 'thinking' });

        const getActiveSql = (): string => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return ''; }
            return editor.selection.isEmpty
                ? editor.document.getText().trim()
                : editor.document.getText(editor.selection).trim();
        };

        const cts = new vscode.CancellationTokenSource();
        try {
            const response = await (async (): Promise<CopilotResponse> => {
                switch (cmd) {
                    case 'explain': {
                        const sql = rest || getActiveSql();
                        if (!sql) { throw new Error('No SQL to explain. Select a query in the editor, or pass SQL after /explain.'); }
                        return this._lmService.explainQuery(sql, cts.token);
                    }
                    case 'fix': {
                        const sql = rest || getActiveSql();
                        if (!sql) { throw new Error('No SQL to fix. Select a query in the editor, or pass SQL after /fix.'); }
                        return this._lmService.fixQuery(sql, '', cts.token);
                    }
                    case 'optimize':
                    case 'optimise': {
                        const sql = rest || getActiveSql();
                        if (!sql) { throw new Error('No SQL to optimise. Select a query in the editor, or pass SQL after /optimize.'); }
                        return this._lmService.optimizeQuery(sql, cts.token);
                    }
                    case 'generate': {
                        if (!rest) { throw new Error('Please describe the query after /generate — e.g. /generate list all customers from the last 30 days.'); }
                        return this._lmService.generateQuery(rest, cts.token);
                    }
                    default:
                        throw new Error(`Unknown command /${cmd}. Available: /explain, /fix, /optimize, /generate.`);
                }
            })();

            const assistantMsg: ChatMessage = { role: 'assistant', content: response.text };
            this._history.push(assistantMsg);
            this._postMessage({ type: 'message', message: assistantMsg });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('SidePanel slash command error', err);
            const errorMsg: ChatMessage = { role: 'error', content: msg };
            this._history.push(errorMsg);
            this._postMessage({ type: 'message', message: errorMsg });
        } finally {
            cts.dispose();
            this._postMessage({ type: 'doneThinking' });
        }
    }

    private _handleRequestEditorContext(mode: 'selection' | 'document'): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._postMessage({ type: 'contextError', message: 'No active editor open.' });
            return;
        }
        const sql = mode === 'selection' && !editor.selection.isEmpty
            ? editor.document.getText(editor.selection).trim()
            : editor.document.getText().trim();
        if (!sql) {
            this._postMessage({ type: 'contextError', message: 'No SQL content found in the editor.' });
            return;
        }
        const filename = basename(editor.document.fileName);
        this._postMessage({ type: 'setContext', sql, filename });
    }

    private _handleInsertCode(code: string): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage('Copilot: No active editor — code copied to clipboard.');
            return;
        }
        editor.edit(eb => {
            if (editor.selection.isEmpty) {
                eb.insert(editor.selection.active, code);
            } else {
                eb.replace(editor.selection, code);
            }
        });
        vscode.window.setStatusBarMessage('$(sparkle) Copilot code inserted', 3000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private _postMessage(message: object): void {
        this._view?.webview.postMessage(message);
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    // ── HTML ─────────────────────────────────────────────────────────────────

    private _buildHtml(webview: vscode.WebviewView['webview']): string {
        const nonce = this._getNonce();

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="${webview.cspSource}">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src https://github.com https://avatars.githubusercontent.com; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Copilot</title>
  <style>
    :root {
      --bg:              var(--vscode-editor-background);
      --fg:              var(--vscode-editor-foreground);
      --fg-muted:        var(--vscode-descriptionForeground);
      --input-bg:        var(--vscode-input-background);
      --input-fg:        var(--vscode-input-foreground);
      --input-border:    var(--vscode-input-border, transparent);
      --btn-bg:          var(--vscode-button-background);
      --btn-fg:          var(--vscode-button-foreground);
      --btn-hover:       var(--vscode-button-hoverBackground);
      --btn2-bg:         var(--vscode-button-secondaryBackground);
      --btn2-fg:         var(--vscode-button-secondaryForeground);
      --btn2-hover:      var(--vscode-button-secondaryHoverBackground);
      --user-bubble:     var(--vscode-badge-background);
      --assist-bubble:   var(--vscode-editorWidget-background);
      --error-fg:        var(--vscode-errorForeground);
      --border:          var(--vscode-panel-border, #444);
      --focus-border:    var(--vscode-focusBorder);
      --font:            var(--vscode-font-family, sans-serif);
      --code-bg:         var(--vscode-textCodeBlock-background);
      --select-bg:       var(--vscode-dropdown-background);
      --select-fg:       var(--vscode-dropdown-foreground);
      --select-border:   var(--vscode-dropdown-border, transparent);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Shared ── */
    .hidden { display: none !important; }
    button {
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      border: none;
      border-radius: 4px;
    }

    /* ── Loading view ── */
    #view-loading {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      opacity: 0.6;
    }
    .spinner {
      width: 24px; height: 24px;
      border: 3px solid var(--fg);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Sign-in view ── */
    #view-signin {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 20px;
      gap: 16px;
      text-align: center;
    }
    #view-signin .logo { font-size: 40px; }
    #view-signin h2 { font-size: 15px; font-weight: 600; }
    #view-signin p { font-size: 12px; color: var(--fg-muted); line-height: 1.5; max-width: 240px; }
    #view-signin .error-msg {
      color: var(--error-fg);
      font-size: 11px;
      max-width: 240px;
    }
    #btn-signin {
      background: var(--btn-bg);
      color: var(--btn-fg);
      padding: 8px 20px;
      font-weight: 600;
    }
    #btn-signin:hover { background: var(--btn-hover); }

    /* ── Chat view ── */
    #view-chat {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Header */
    #chat-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #user-avatar {
      width: 22px; height: 22px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }
    #user-login {
      font-weight: 600;
      font-size: 12px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #btn-signout {
      background: transparent;
      color: var(--fg-muted);
      font-size: 11px;
      padding: 2px 6px;
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    #btn-signout:hover { background: var(--assist-bubble); color: var(--fg); }

    /* Model selector */
    #model-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #model-bar label {
      font-size: 11px;
      color: var(--fg-muted);
      white-space: nowrap;
    }
    #model-select {
      flex: 1;
      background: var(--select-bg);
      color: var(--select-fg);
      border: 1px solid var(--select-border);
      border-radius: 3px;
      padding: 3px 6px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
      min-width: 0;
    }
    #model-select:focus { border-color: var(--focus-border); }
    #model-no-models {
      font-size: 11px;
      color: var(--error-fg);
    }

    /* Messages */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bubble {
      padding: 9px 12px;
      border-radius: 8px;
      max-width: 92%;
      line-height: 1.55;
      word-break: break-word;
    }
    .bubble.user {
      background: var(--user-bubble);
      align-self: flex-end;
      white-space: pre-wrap;
    }
    .bubble.assistant {
      background: var(--assist-bubble);
      align-self: flex-start;
    }
    .bubble.error {
      background: var(--assist-bubble);
      color: var(--error-fg);
      align-self: flex-start;
      border-left: 3px solid var(--error-fg);
    }
    .thinking {
      display: flex;
      gap: 4px;
      align-self: flex-start;
      padding: 8px 4px;
    }
    .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--fg-muted);
      animation: bounce 1.2s infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
      40%           { transform: translateY(-5px); opacity: 1; }
    }
    code {
      background: var(--code-bg);
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 12px;
    }
    pre {
      background: var(--code-bg);
      padding: 10px;
      border-radius: 5px;
      overflow-x: auto;
      white-space: pre;
      margin: 4px 0;
    }
    pre code { background: none; padding: 0; }
    #empty-state {
      margin: auto;
      text-align: center;
      opacity: 0.55;
      max-width: 220px;
      pointer-events: none;
    }
    #empty-state .icon { font-size: 28px; }
    #empty-state strong { display: block; margin-top: 6px; font-size: 13px; }
    #empty-state p { margin-top: 6px; font-size: 11px; line-height: 1.5; }

    /* Input area */
    #input-area {
      border-top: 1px solid var(--border);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    #input {
      width: 100%;
      min-height: 34px;
      max-height: 120px;
      resize: none;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 7px 10px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      line-height: 1.4;
    }
    #input:focus { border-color: var(--focus-border); }
    #input-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    #input-hint {
      font-size: 10px;
      color: var(--fg-muted);
      user-select: none;
    }
    #input-buttons { display: flex; gap: 6px; }
    #btn-clear {
      background: var(--btn2-bg);
      color: var(--btn2-fg);
      padding: 5px 10px;
      font-size: 11px;
    }
    #btn-clear:hover { background: var(--btn2-hover); }
    #btn-send {
      background: var(--btn-bg);
      color: var(--btn-fg);
      padding: 5px 14px;
      font-weight: 600;
    }
    #btn-send:hover { background: var(--btn-hover); }
    #btn-send:disabled, #btn-clear:disabled { opacity: 0.45; cursor: not-allowed; }

    /* ── Context bar ── */
    #context-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--vscode-editor-selectionHighlightBackground, var(--assist-bubble));
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      flex-shrink: 0;
    }
    #context-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
    #context-label strong { color: var(--fg); }
    #btn-ctx-dismiss {
      background: transparent;
      color: var(--fg-muted);
      font-size: 16px;
      line-height: 1;
      padding: 0 4px;
      border: none;
      flex-shrink: 0;
    }
    #btn-ctx-dismiss:hover { color: var(--fg); }

    /* ── Context action buttons ── */
    #input-ctx-btns { display: flex; gap: 4px; }
    .btn-ctx {
      background: transparent;
      color: var(--fg-muted);
      font-size: 11px;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 3px;
    }
    .btn-ctx:hover { background: var(--assist-bubble); color: var(--fg); }

    /* ── Quick action chips ── */
    #quick-actions {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 10px;
      pointer-events: all;
    }
    .chip {
      background: var(--btn2-bg);
      color: var(--btn2-fg);
      border: 1px solid var(--border);
      padding: 3px 10px;
      border-radius: 10px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
    }
    .chip:hover { background: var(--btn2-hover); }

    /* ── Code block with Insert/Copy actions ── */
    .code-block { margin: 4px 0; }
    .code-block pre { margin: 0; border-radius: 5px 5px 0 0; }
    .code-actions {
      display: flex;
      gap: 4px;
      padding: 3px 6px;
      background: var(--code-bg);
      border-top: 1px solid var(--border);
      border-radius: 0 0 5px 5px;
    }
    .btn-insert, .btn-copy {
      background: var(--btn2-bg);
      color: var(--btn2-fg);
      padding: 2px 8px;
      font-size: 11px;
      border: 1px solid var(--border);
      border-radius: 3px;
    }
    .btn-insert:hover, .btn-copy:hover { background: var(--btn2-hover); }
  </style>
</head>
<body>

  <!-- Loading -->
  <div id="view-loading">
    <div class="spinner"></div>
    <span>Loading…</span>
  </div>

  <!-- Sign-in -->
  <div id="view-signin" class="hidden">
    <div class="logo">🤖</div>
    <h2>GitHub Copilot for ADS</h2>
    <p>Sign in with your GitHub account to start chatting with Copilot about your SQL queries.</p>
    <button id="btn-signin">Sign in with GitHub</button>
    <div id="signin-error" class="error-msg hidden"></div>
  </div>

  <!-- Chat -->
  <div id="view-chat" class="hidden">

    <div id="chat-header">
      <img id="user-avatar" src="" alt="avatar" />
      <span id="user-login"></span>
      <button id="btn-signout">Sign out</button>
    </div>

    <div id="model-bar">
      <label for="model-select">Model:</label>
      <select id="model-select"></select>
      <span id="model-no-models" class="hidden">No models available</span>
    </div>

    <div id="messages">
      <div id="empty-state">
        <div class="icon">✨</div>
        <strong>Ask Copilot</strong>
        <p>Ask anything about SQL, or use a quick action:</p>
        <div id="quick-actions">
          <button class="chip" data-cmd="/explain">/explain</button>
          <button class="chip" data-cmd="/fix">/fix</button>
          <button class="chip" data-cmd="/optimize">/optimize</button>
          <button class="chip" data-cmd="/generate ">/generate</button>
        </div>
      </div>
    </div>

    <div id="context-bar" class="hidden">
      <span id="context-label">📎 <strong id="context-filename"></strong></span>
      <button id="btn-ctx-dismiss" title="Remove attachment">×</button>
    </div>

    <div id="input-area">
      <div id="input-ctx-btns">
        <button class="btn-ctx" id="btn-use-selection" title="Attach selected SQL from the active editor">📋 Use selection</button>
        <button class="btn-ctx" id="btn-use-file" title="Attach the whole file from the active editor">📄 Use file</button>
      </div>
      <textarea id="input" placeholder="Ask Copilot about SQL…" rows="1"></textarea>
      <div id="input-actions">
        <span id="input-hint">Enter to send · Shift+Enter for new line</span>
        <div id="input-buttons">
          <button id="btn-clear">Clear</button>
          <button id="btn-send">Send</button>
        </div>
      </div>
    </div>

  </div>

  <script nonce="${nonce}">
    const vscode      = acquireVsCodeApi();
    const viewLoading = document.getElementById('view-loading');
    const viewSignin  = document.getElementById('view-signin');
    const viewChat    = document.getElementById('view-chat');

    // Sign-in view elements
    const btnSignin    = document.getElementById('btn-signin');
    const signinError  = document.getElementById('signin-error');

    // Chat view elements
    const userAvatar   = document.getElementById('user-avatar');
    const userLogin    = document.getElementById('user-login');
    const btnSignout   = document.getElementById('btn-signout');
    const modelSelect  = document.getElementById('model-select');
    const modelNone    = document.getElementById('model-no-models');
    const messagesEl   = document.getElementById('messages');
    const emptyState   = document.getElementById('empty-state');
    const inputEl      = document.getElementById('input');
    const btnSend      = document.getElementById('btn-send');
    const btnClear     = document.getElementById('btn-clear');

    let thinkingEl = null;
    let busy       = false;
    let _attachedCtx = null; // { sql: string, filename: string } | null

    // Code block registry (for Insert/Copy actions)
    let _cbIdx = 0;
    const _cbStore = {};

    // Context bar elements
    const contextBar      = document.getElementById('context-bar');
    const contextFilename = document.getElementById('context-filename');
    const btnCtxDismiss   = document.getElementById('btn-ctx-dismiss');
    const btnUseSelection = document.getElementById('btn-use-selection');
    const btnUseFile      = document.getElementById('btn-use-file');

    /* ── View switching ── */
    function showView(name) {
      viewLoading.classList.toggle('hidden', name !== 'loading');
      viewSignin.classList.toggle('hidden',  name !== 'signin');
      viewChat.classList.toggle('hidden',    name !== 'chat');
    }

    /* ── HTML helpers ── */
    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function formatContent(raw) {
      // Step 1: extract code fences before HTML-escaping (preserves raw code for Insert)
      const processed = raw.replace(/\`\`\`(?:[a-zA-Z]*)\\n([\\s\\S]*?)\\n?\`\`\`/g, function(_, code) {
        const i = _cbIdx++;
        _cbStore[i] = code;
        return '__CB' + i + '__';
      });
      // Step 2: HTML-escape the remainder
      let html = escHtml(processed);
      // Step 3: restore code blocks with Insert/Copy action buttons
      html = html.replace(/__CB(\\d+)__/g, function(_, iStr) {
        const i = parseInt(iStr, 10);
        const rawCode = _cbStore[i] !== undefined ? _cbStore[i] : '';
        return '<div class="code-block"><pre><code>' + escHtml(rawCode) + '</code></pre>' +
               '<div class="code-actions">' +
               '<button class="btn-insert" data-idx="' + i + '">\u21b5 Insert</button>' +
               '<button class="btn-copy" data-idx="' + i + '">\u2398 Copy</button>' +
               '</div></div>';
      });
      // Inline code
      html = html.replace(/\`([^\`\\n]+)\`/g, function(_, c) { return '<code>' + c + '</code>'; });
      // Bold
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, function(_, t) { return '<strong>' + t + '</strong>'; });
      // Newlines
      html = html.replace(/\\n/g, '<br>');
      return html;
    }

    /* ── Messages ── */
    function appendMessage(msg) {
      emptyState.classList.add('hidden');
      const el = document.createElement('div');
      el.className = 'bubble ' + msg.role;
      el.innerHTML = msg.role === 'user' ? escHtml(msg.content) : formatContent(msg.content);
      messagesEl.appendChild(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function showThinking() {
      if (thinkingEl) { return; }
      busy = true;
      btnSend.disabled = true;
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking';
      thinkingEl.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
      messagesEl.appendChild(thinkingEl);
      thinkingEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function hideThinking() {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      busy = false;
      btnSend.disabled = false;
    }

    /* ── Send ── */
    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || busy) { return; }
      let fullText = text;
      // Append attached SQL context (skip for slash commands)
      if (_attachedCtx && !text.startsWith('/')) {
        fullText = text + '\\n\\n\`\`\`sql\\n' + _attachedCtx.sql + '\\n\`\`\`';
      }
      _attachedCtx = null;
      contextBar.classList.add('hidden');
      inputEl.value = '';
      inputEl.style.height = 'auto';
      vscode.postMessage({ type: 'userMessage', text: fullText });
    }

    /* ── Models ── */
    function populateModels(models, selectedId) {
      modelSelect.innerHTML = '';
      if (!models || models.length === 0) {
        modelSelect.classList.add('hidden');
        modelNone.classList.remove('hidden');
        return;
      }
      modelNone.classList.add('hidden');
      modelSelect.classList.remove('hidden');
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.family || m.id;
        if (m.id === selectedId) { opt.selected = true; }
        modelSelect.appendChild(opt);
      });
    }

    /* ── Event listeners ── */
    btnSignin.addEventListener('click', () => {
      signinError.classList.add('hidden');
      vscode.postMessage({ type: 'signIn' });
    });

    btnSignout.addEventListener('click', () => {
      vscode.postMessage({ type: 'signOut' });
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectModel', modelId: modelSelect.value });
    });

    btnSend.addEventListener('click', sendMessage);
    btnClear.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearHistory' });
    });

    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    /* ── Code block Insert/Copy (event delegation) ── */
    messagesEl.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest && e.target.closest('.btn-insert, .btn-copy');
      if (!btn) { return; }
      const idx = parseInt(btn.dataset.idx, 10);
      const code = _cbStore[idx];
      if (code === undefined) { return; }
      if (btn.classList.contains('btn-insert')) {
        vscode.postMessage({ type: 'insertCode', code: code });
        btn.textContent = '\u2713 Inserted';
        setTimeout(function() { btn.innerHTML = '\u21b5 Insert'; }, 1500);
      } else {
        const doFallback = function() {
          vscode.postMessage({ type: 'copyCode', code: code });
          btn.textContent = '\u2713 Copied';
          setTimeout(function() { btn.innerHTML = '\u2398 Copy'; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function() {
            btn.textContent = '\u2713 Copied';
            setTimeout(function() { btn.innerHTML = '\u2398 Copy'; }, 1500);
          }).catch(doFallback);
        } else {
          doFallback();
        }
      }
    });

    /* ── Context attachment ── */
    btnCtxDismiss.addEventListener('click', function() {
      _attachedCtx = null;
      contextBar.classList.add('hidden');
    });

    btnUseSelection.addEventListener('click', function() {
      vscode.postMessage({ type: 'requestEditorContext', mode: 'selection' });
    });

    btnUseFile.addEventListener('click', function() {
      vscode.postMessage({ type: 'requestEditorContext', mode: 'document' });
    });

    /* ── Quick action chips ── */
    document.getElementById('quick-actions').addEventListener('click', function(e) {
      const chip = e.target.closest && e.target.closest('.chip');
      if (!chip) { return; }
      const cmd = chip.dataset.cmd || '';
      if (!cmd) { return; }
      inputEl.value = cmd;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input'));
    });

    /* ── Messages from extension ── */
    window.addEventListener('message', event => {
      const data = event.data;
      switch (data.type) {

        case 'loading':
          showView('loading');
          break;

        case 'signedOut':
          showView('signin');
          break;

        case 'signedIn':
          userLogin.textContent = data.user.login;
          userAvatar.src        = data.user.avatarUrl;
          userAvatar.alt        = data.user.login;
          populateModels(data.models, data.selectedModelId);
          showView('chat');
          break;

        case 'authError':
          signinError.textContent = data.message;
          signinError.classList.remove('hidden');
          showView('signin');
          break;

        case 'message':
          appendMessage(data.message);
          break;

        case 'thinking':
          showThinking();
          break;

        case 'doneThinking':
          hideThinking();
          break;

        case 'cleared':
          // Remove all message bubbles while keeping the emptyState element
          Array.from(messagesEl.children).forEach(child => {
            if (child !== emptyState) { messagesEl.removeChild(child); }
          });
          emptyState.classList.remove('hidden');
          break;

        case 'setContext':
          _attachedCtx = { sql: data.sql, filename: data.filename };
          contextFilename.textContent = data.filename;
          contextBar.classList.remove('hidden');
          inputEl.focus();
          break;

        case 'contextError':
          // Silently ignore; user will notice nothing happened
          break;
      }
    });

    // Signal the extension that the webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }

    /** Attach a SQL snippet as context in the side panel input for the next message. */
    addSelectionToChat(sql: string, filename: string): void {
        this._postMessage({ type: 'setContext', sql, filename });
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
