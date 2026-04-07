import * as vscode from 'vscode';
import * as https from 'https';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';
import { preferredModel, maxTokens, includeSchemaContext } from '../utils/config';

export interface CopilotResponse {
    text: string;
    model: string;
}

export interface ModelInfo {
    id: string;
    name: string;
    family: string;
}

interface CopilotTokenCache {
    token: string;
    expiresAt: number; // milliseconds
}

const COPILOT_HOSTNAME = 'api.githubcopilot.com';
const GITHUB_API_HOSTNAME = 'api.github.com';
const GITHUB_AUTH_PROVIDER = 'github';
const GITHUB_SCOPES = ['read:user'];
const USER_AGENT = 'ADS-Copilot-Integration/0.1.0';

/**
 * Thin wrapper around the GitHub Copilot REST API.
 * Obtains a short-lived Copilot API token by exchanging the user's GitHub
 * OAuth token, then calls the OpenAI-compatible completions endpoint at
 * https://api.githubcopilot.com/chat/completions.
 *
 * This implementation works with Azure Data Studio (VS Code 1.82) which does
 * not include the vscode.lm Language Model API (added in VS Code 1.85).
 */
export class LmService {
    private _tokenCache: CopilotTokenCache | undefined;

    constructor(private readonly connectionManager: ConnectionManager) {}

    /** Returns true when a Copilot API token can be successfully obtained. */
    async isAvailable(): Promise<boolean> {
        try {
            await this._getCopilotToken();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * List available Copilot language models.
     * Falls back to a hardcoded list when the /models endpoint is unreachable.
     */
    async listModels(): Promise<ModelInfo[]> {
        try {
            const token = await this._getCopilotToken();
            const raw = await this._httpsGet(COPILOT_HOSTNAME, '/models', token);
            const parsed = JSON.parse(raw) as {
                data?: Array<{ id: string; name?: string; version?: string }>;
            };
            const data = parsed.data ?? [];
            if (data.length === 0) {
                return this._defaultModels();
            }
            return data.map(m => ({
                id: m.id,
                name: m.name ?? m.id,
                family: m.id.split('-').slice(0, 2).join('-')
            }));
        } catch (err) {
            logger.warn('Could not load language models from Copilot API', err);
            return this._defaultModels();
        }
    }

    private _defaultModels(): ModelInfo[] {
        return [
            { id: 'gpt-4o',         name: 'GPT-4o',         family: 'gpt-4o' },
            { id: 'gpt-4o-mini',    name: 'GPT-4o Mini',    family: 'gpt-4o' },
            { id: 'gpt-4',          name: 'GPT-4',          family: 'gpt-4' },
            { id: 'gpt-3.5-turbo',  name: 'GPT-3.5 Turbo',  family: 'gpt-3.5' }
        ];
    }

    // ── Token management ─────────────────────────────────────────────────────

    /** Return a valid Copilot API token, refreshing if necessary. */
    private async _getCopilotToken(): Promise<string> {
        const now = Date.now();
        if (this._tokenCache && this._tokenCache.expiresAt > now + 60_000) {
            return this._tokenCache.token;
        }

        const session = await vscode.authentication.getSession(
            GITHUB_AUTH_PROVIDER,
            GITHUB_SCOPES,
            { createIfNone: false }
        );

        if (!session) {
            throw new Error(
                'Not signed in to GitHub. Please sign in via the Copilot side panel to use AI features.'
            );
        }

        const cache = await this._exchangeForCopilotToken(session.accessToken);
        this._tokenCache = cache;
        return cache.token;
    }

    /**
     * Exchange a GitHub OAuth access token for a short-lived GitHub Copilot
     * API token via the internal token endpoint.
     */
    private _exchangeForCopilotToken(githubToken: string): Promise<CopilotTokenCache> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: GITHUB_API_HOSTNAME,
                path: '/copilot_internal/v2/token',
                method: 'GET',
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json'
                }
            };

            const req = https.request(options, res => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(
                            `GitHub Copilot authentication failed (HTTP ${res.statusCode}). ` +
                            'Ensure your account has an active GitHub Copilot subscription.'
                        ));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data) as { token: string; expires_at: number };
                        resolve({ token: parsed.token, expiresAt: parsed.expires_at * 1000 });
                    } catch {
                        reject(new Error('Failed to parse Copilot token response'));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    private _httpsGet(hostname: string, path: string, bearerToken: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname,
                path,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json'
                }
            };

            const req = https.request(options, res => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk; });
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);
            req.end();
        });
    }

    private _httpsPost(
        hostname: string,
        path: string,
        bearerToken: string,
        body: object,
        token: vscode.CancellationToken
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname,
                path,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'User-Agent': USER_AGENT,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    'Accept': 'application/json'
                }
            };

            const req = https.request(options, res => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(
                            `Copilot API error (HTTP ${res.statusCode}): ${data}`
                        ));
                        return;
                    }
                    resolve(data);
                });
            });

            req.on('error', reject);

            const cancelDisposable = token.onCancellationRequested(() => {
                req.destroy(new vscode.CancellationError());
            });
            req.on('close', () => cancelDisposable.dispose());

            req.write(bodyStr);
            req.end();
        });
    }

    // ── Model selection ───────────────────────────────────────────────────────

    private _resolveModelId(modelId?: string): string {
        return modelId ?? preferredModel() ?? 'gpt-4o';
    }

    // ── System prompt ─────────────────────────────────────────────────────────

    private async _buildSystemPrompt(includeSchema: boolean): Promise<string> {
        let schemaContext = '';
        if (includeSchema && includeSchemaContext()) {
            schemaContext = await this.connectionManager.buildSchemaContext();
        }

        const schemaSection = schemaContext
            ? `\n\nActive database schema:\n${schemaContext}`
            : '';

        return (
            'You are a SQL expert assistant integrated into Azure Data Studio. ' +
            'You help users write, understand, fix, and optimise SQL queries. ' +
            'Always provide concise, accurate SQL answers. ' +
            'When generating SQL, prefer T-SQL (SQL Server) syntax unless the user specifies a different dialect. ' +
            'Format SQL with proper indentation. ' +
            'Respond only with the requested SQL or explanation — no unnecessary preamble.' +
            schemaSection
        );
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Send a chat request to the GitHub Copilot API and return the full response.
     * An optional `modelId` overrides the configured default model.
     */
    async chat(
        userMessage: string,
        token: vscode.CancellationToken,
        includeSchema = true,
        modelId?: string
    ): Promise<CopilotResponse> {
        const copilotToken = await this._getCopilotToken();
        const model = this._resolveModelId(modelId);
        const systemPrompt = await this._buildSystemPrompt(includeSchema);

        const body = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: maxTokens(),
            stream: false
        };

        logger.debug(`Sending request to model "${model}"`, { messageLength: userMessage.length });

        const raw = await this._httpsPost(COPILOT_HOSTNAME, '/chat/completions', copilotToken, body, token);
        const parsed = JSON.parse(raw) as {
            choices: Array<{ message: { content: string } }>;
            model: string;
        };

        if (!parsed.choices || parsed.choices.length === 0) {
            throw new Error('No response received from the Copilot API');
        }

        const text = parsed.choices[0].message.content.trim();
        logger.debug(`Received response (${text.length} chars) from model "${parsed.model ?? model}"`);
        return { text, model: parsed.model ?? model };
    }

    /** Explain what a SQL query does in plain English. */
    async explainQuery(sql: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Explain what the following SQL query does in clear, concise language:\n\n\`\`\`sql\n${sql}\n\`\`\``,
            token
        );
    }

    /** Generate a SQL query from a natural-language description. */
    async generateQuery(description: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Generate a SQL query that: ${description}\n\nRespond with only the SQL query, no explanation.`,
            token
        );
    }

    /** Suggest fixes for SQL errors. */
    async fixQuery(sql: string, errorMessage: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        const errorSection = errorMessage ? `\n\nError message:\n${errorMessage}` : '';
        return this.chat(
            `Fix the following SQL query so it runs without errors.${errorSection}\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nRespond with only the corrected SQL query.`,
            token
        );
    }

    /** Suggest performance optimisations for a SQL query. */
    async optimizeQuery(sql: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Review the following SQL query for performance issues and suggest optimisations. ` +
            `List specific improvements and provide an optimised version if applicable.\n\n\`\`\`sql\n${sql}\n\`\`\``,
            token
        );
    }

    /**
     * Generate an inline completion for a partial SQL statement.
     * Returns the continuation of the partial SQL only.
     */
    async inlineComplete(
        prefix: string,
        suffix: string,
        token: vscode.CancellationToken
    ): Promise<string> {
        try {
            const copilotToken = await this._getCopilotToken();
            const model = this._resolveModelId();
            const systemPrompt = await this._buildSystemPrompt(true);

            const prompt =
                `${systemPrompt}\n\n` +
                `Complete the following SQL. ` +
                `Return ONLY the completion text — do not repeat the prefix, do not add markdown fences.\n\n` +
                `Prefix:\n${prefix}\n\nSuffix (what comes after the cursor):\n${suffix || '(nothing)'}`;

            const body = {
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 256,
                stream: false
            };

            const raw = await this._httpsPost(COPILOT_HOSTNAME, '/chat/completions', copilotToken, body, token);
            const parsed = JSON.parse(raw) as {
                choices: Array<{ message: { content: string } }>;
            };
            return parsed.choices?.[0]?.message?.content?.trim() ?? '';
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                return '';
            }
            logger.warn('Inline completion request failed', err);
            return '';
        }
    }
}
