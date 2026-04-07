import * as vscode from 'vscode';
import { ConnectionManager } from '../managers/connectionManager';
import { logger } from '../utils/logger';
import { preferredModel, maxTokens, includeSchemaContext } from '../utils/config';

export interface CopilotResponse {
    text: string;
    model: string;
}

/**
 * Thin wrapper around the VS Code Language Model API (vscode.lm).
 * Available from VS Code 1.85 / GitHub Copilot Chat ≥ 0.12.
 */
export class LmService {
    constructor(private readonly connectionManager: ConnectionManager) {}

    /** Returns true when the vscode.lm API is available and at least one model is accessible. */
    async isAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
            return models.length > 0;
        } catch {
            try {
                const models = await vscode.lm.selectChatModels();
                return models.length > 0;
            } catch {
                return false;
            }
        }
    }

    /**
     * Select the best available language model, preferring the one configured
     * in settings (ads-copilot.model).
     */
    private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
        const preferred = preferredModel();
        // Try preferred family first, then fall back to any available model
        for (const family of [preferred, 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo', undefined]) {
            try {
                const models = family
                    ? await vscode.lm.selectChatModels({ family })
                    : await vscode.lm.selectChatModels();
                if (models.length > 0) {
                    return models[0];
                }
            } catch {
                // try next
            }
        }
        return undefined;
    }

    /**
     * Select a specific model by ID (as returned by vscode.lm.selectChatModels).
     * Falls back to the default selection when the requested model is unavailable.
     */
    private async selectModelById(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
        try {
            const models = await vscode.lm.selectChatModels({ id: modelId });
            if (models.length > 0) {
                return models[0];
            }
        } catch {
            // fall through to default selection
        }
        return this.selectModel();
    }

    /**
     * Build the system prompt, optionally including schema context from the
     * active ADS database connection.
     */
    private async buildSystemPrompt(includeSchema: boolean): Promise<string> {
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

    /**
     * Send a chat request to the language model and collect the full streamed response.
     * An optional `modelId` overrides the default model selection.
     */
    async chat(
        userMessage: string,
        token: vscode.CancellationToken,
        includeSchema = true,
        modelId?: string
    ): Promise<CopilotResponse> {
        const model = modelId
            ? await this.selectModelById(modelId)
            : await this.selectModel();
        if (!model) {
            throw new Error(
                'No GitHub Copilot language model is available. ' +
                'Please install the GitHub Copilot Chat extension and sign in.'
            );
        }

        const systemPrompt = await this.buildSystemPrompt(includeSchema);
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userMessage)
        ];

        logger.debug(`Sending request to model "${model.id}"`, { messageLength: userMessage.length });

        const response = await model.sendRequest(messages, {}, token);

        let text = '';
        for await (const chunk of response.text) {
            text += chunk;
        }

        logger.debug(`Received response (${text.length} chars) from model "${model.id}"`);
        return { text: text.trim(), model: model.id };
    }

    /**
     * Explain what a SQL query does in plain English.
     */
    async explainQuery(sql: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Explain what the following SQL query does in clear, concise language:\n\n\`\`\`sql\n${sql}\n\`\`\``,
            token
        );
    }

    /**
     * Generate a SQL query from a natural-language description.
     */
    async generateQuery(description: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Generate a SQL query that: ${description}\n\nRespond with only the SQL query, no explanation.`,
            token
        );
    }

    /**
     * Suggest fixes for SQL errors.
     */
    async fixQuery(sql: string, errorMessage: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        const errorSection = errorMessage
            ? `\n\nError message:\n${errorMessage}`
            : '';
        return this.chat(
            `Fix the following SQL query so it runs without errors.${errorSection}\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nRespond with only the corrected SQL query.`,
            token
        );
    }

    /**
     * Suggest performance optimisations for a SQL query.
     */
    async optimizeQuery(sql: string, token: vscode.CancellationToken): Promise<CopilotResponse> {
        return this.chat(
            `Review the following SQL query for performance issues and suggest optimisations. ` +
            `List specific improvements and provide an optimised version if applicable.\n\n\`\`\`sql\n${sql}\n\`\`\``,
            token
        );
    }

    /**
     * Generate an inline completion for a partial SQL statement.
     * Returns a concise completion (the continuation of the partial SQL).
     */
    async inlineComplete(
        prefix: string,
        suffix: string,
        token: vscode.CancellationToken
    ): Promise<string> {
        const model = await this.selectModel();
        if (!model) {
            return '';
        }

        const systemPrompt = await this.buildSystemPrompt(true);
        const prompt =
            `${systemPrompt}\n\n` +
            `Complete the following SQL. ` +
            `Return ONLY the completion text — do not repeat the prefix, do not add markdown fences.\n\n` +
            `Prefix:\n${prefix}\n\nSuffix (what comes after the cursor):\n${suffix || '(nothing)'}`;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];

        try {
            const response = await model.sendRequest(
                messages,
                { },
                token
            );

            let completion = '';
            for await (const chunk of response.text) {
                completion += chunk;
            }
            return completion.trim();
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                return '';
            }
            logger.warn('Inline completion request failed', err);
            return '';
        }
    }
}
