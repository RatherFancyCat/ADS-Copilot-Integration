import * as vscode from 'vscode';
import * as path from 'path';
import { LmService } from '../managers/lmService';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';

interface ChatMessage {
    role: 'user' | 'assistant' | 'error';
    content: string;
}

/**
 * Provides a standalone chat WebView panel as a fallback when the GitHub
 * Copilot Chat extension is not installed.  It renders a simple chat UI
 * backed by the VS Code Language Model API.
 */
export class ChatPanel implements vscode.Disposable {
    public static readonly VIEW_TYPE = 'ads-copilot-chat-panel';
    private static _instance: ChatPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _history: ChatMessage[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        private readonly _lmService: LmService,
        private readonly _connectionManager: ConnectionManager
    ) {
        this._panel = panel;
        this._panel.webview.html = this._buildHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            null,
            this._disposables
        );
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        lmService: LmService,
        connectionManager: ConnectionManager
    ): ChatPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel._instance) {
            ChatPanel._instance._panel.reveal(column);
            return ChatPanel._instance;
        }

        const panel = vscode.window.createWebviewPanel(
            ChatPanel.VIEW_TYPE,
            'Copilot Chat',
            column ?? vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ChatPanel._instance = new ChatPanel(panel, extensionUri, lmService, connectionManager);
        return ChatPanel._instance;
    }

    private async _handleMessage(message: { type: string; text?: string }): Promise<void> {
        switch (message.type) {
            case 'userMessage': {
                const userText = message.text?.trim() ?? '';
                if (!userText) {
                    return;
                }
                await this._processUserMessage(userText);
                break;
            }
            case 'clearHistory': {
                this._history = [];
                this._panel.webview.postMessage({ type: 'cleared' });
                break;
            }
            case 'ready': {
                // WebView has loaded — push any existing history
                for (const msg of this._history) {
                    this._panel.webview.postMessage({ type: 'message', message: msg });
                }
                break;
            }
        }
    }

    private async _processUserMessage(text: string): Promise<void> {
        const userMsg: ChatMessage = { role: 'user', content: text };
        this._history.push(userMsg);
        this._panel.webview.postMessage({ type: 'message', message: userMsg });
        this._panel.webview.postMessage({ type: 'thinking' });

        const cts = new vscode.CancellationTokenSource();
        try {
            const response = await this._lmService.chat(text, cts.token);
            const assistantMsg: ChatMessage = { role: 'assistant', content: response.text };
            this._history.push(assistantMsg);
            this._panel.webview.postMessage({ type: 'message', message: assistantMsg });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('ChatPanel LM error', err);
            const errorMsg: ChatMessage = { role: 'error', content: msg };
            this._history.push(errorMsg);
            this._panel.webview.postMessage({ type: 'message', message: errorMsg });
        } finally {
            cts.dispose();
            this._panel.webview.postMessage({ type: 'doneThinking' });
        }
    }

    private _buildHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Copilot Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --user-bubble: var(--vscode-badge-background);
      --assistant-bubble: var(--vscode-editorWidget-background);
      --error-fg: var(--vscode-errorForeground);
      --border: var(--vscode-panel-border);
      --font: var(--vscode-font-family);
      --code-bg: var(--vscode-textCodeBlock-background);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font, sans-serif);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    #header {
      padding: 10px 14px;
      font-weight: 600;
      font-size: 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bubble {
      padding: 10px 14px;
      border-radius: 8px;
      max-width: 88%;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user {
      background: var(--user-bubble);
      align-self: flex-end;
    }
    .bubble.assistant {
      background: var(--assistant-bubble);
      align-self: flex-start;
    }
    .bubble.error {
      color: var(--error-fg);
      background: var(--assistant-bubble);
      align-self: flex-start;
      border-left: 3px solid var(--error-fg);
    }
    .thinking {
      display: flex;
      gap: 4px;
      align-self: flex-start;
      padding: 8px;
    }
    .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--fg);
      opacity: 0.4;
      animation: bounce 1.2s infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40%            { transform: translateY(-6px); opacity: 1; }
    }
    code { background: var(--code-bg); padding: 2px 4px; border-radius: 3px; font-size: 12px; }
    pre  { background: var(--code-bg); padding: 10px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    #input-area {
      border-top: 1px solid var(--border);
      padding: 10px;
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    #input {
      flex: 1;
      min-height: 36px;
      max-height: 120px;
      resize: none;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, transparent);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder); }
    #send {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
    }
    #send:hover { background: var(--btn-hover); }
    #send:disabled { opacity: 0.5; cursor: not-allowed; }
    #clear {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      margin-left: auto;
    }
    #clear:hover { background: var(--assistant-bubble); }
    #empty-state {
      margin: auto;
      text-align: center;
      opacity: 0.5;
      max-width: 260px;
    }
    #empty-state p { margin-top: 8px; font-size: 12px; }
  </style>
</head>
<body>
  <div id="header">
    <span>✨</span>
    <span>Copilot Chat</span>
    <button id="clear">Clear</button>
  </div>
  <div id="messages">
    <div id="empty-state">
      <div style="font-size:24px">✨</div>
      <strong>GitHub Copilot for ADS</strong>
      <p>Ask anything about SQL, or use <code>/explain</code>, <code>/generate</code>, <code>/fix</code>, <code>/optimize</code>.</p>
    </div>
  </div>
  <div id="input-area">
    <textarea id="input" placeholder="Ask Copilot about SQL…" rows="1"></textarea>
    <button id="send">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl    = document.getElementById('input');
    const sendBtn    = document.getElementById('send');
    const clearBtn   = document.getElementById('clear');
    const emptyState = document.getElementById('empty-state');
    let thinkingEl   = null;

    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatContent(raw) {
      // Very simple markdown: code fences, inline code
      let html = escapeHtml(raw);
      html = html.replace(/\`\`\`(?:sql|\\w*)\\n([\\s\\S]*?)\\n\`\`\`/g, '<pre><code>$1</code></pre>');
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      return html;
    }

    function appendMessage(msg) {
      if (emptyState) { emptyState.style.display = 'none'; }
      const el = document.createElement('div');
      el.className = 'bubble ' + msg.role;
      el.innerHTML = formatContent(msg.content);
      messagesEl.appendChild(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function showThinking() {
      if (thinkingEl) { return; }
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking';
      thinkingEl.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
      messagesEl.appendChild(thinkingEl);
      thinkingEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
      sendBtn.disabled = true;
    }

    function hideThinking() {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      sendBtn.disabled = false;
    }

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) { return; }
      inputEl.value = '';
      inputEl.style.height = 'auto';
      vscode.postMessage({ type: 'userMessage', text });
    }

    sendBtn.addEventListener('click', sendMessage);
    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearHistory' });
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      switch (data.type) {
        case 'message':    appendMessage(data.message); break;
        case 'thinking':   showThinking(); break;
        case 'doneThinking': hideThinking(); break;
        case 'cleared':
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          emptyState.style.display = '';
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }

    dispose(): void {
        ChatPanel._instance = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
