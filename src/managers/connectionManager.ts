import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface SchemaInfo {
    databaseName: string;
    tables: TableInfo[];
}

export interface TableInfo {
    schema: string;
    name: string;
    columns: ColumnInfo[];
}

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    isPrimaryKey: boolean;
}

export interface ConnectionInfo {
    connectionId: string;
    serverName: string;
    databaseName: string;
    userName: string | undefined;
    authenticationType: string;
}

/**
 * Manages Azure Data Studio connection context and schema metadata.
 * Uses the `azdata` API when available (running inside ADS), and degrades
 * gracefully when the API is absent (e.g. during unit tests in plain VS Code).
 */
export class ConnectionManager implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private _currentConnection: ConnectionInfo | undefined;
    private _schemaCache: Map<string, SchemaInfo> = new Map();

    // azdata is loaded lazily so the extension works without it.
    private get _azdata(): typeof import('azdata') | undefined {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require('azdata') as typeof import('azdata');
        } catch {
            return undefined;
        }
    }

    constructor() {
        this._registerListeners();
    }

    private _registerListeners(): void {
        const azdata = this._azdata;
        if (!azdata) {
            logger.debug('azdata module not available – running outside ADS');
            return;
        }

        try {
            // The connection change event name varies between ADS versions;
            // use a dynamic lookup so the extension degrades gracefully.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const conn = azdata.connection as any;
            const eventFn: ((cb: (c: { connectionId: string } | undefined) => Promise<void>) => vscode.Disposable) | undefined =
                conn.onDidChangeActiveConnection ?? conn.onConnectionChanged;
            if (typeof eventFn === 'function') {
                const disposable = eventFn(async (connection) => {
                    if (connection) {
                        await this._updateCurrentConnection(connection.connectionId);
                    } else {
                        this._currentConnection = undefined;
                    }
                });
                this._disposables.push(disposable);
            }
        } catch (err) {
            logger.warn('Could not register ADS connection listener', err);
        }
    }

    /** Return the currently active ADS connection, or undefined. */
    async getCurrentConnection(): Promise<ConnectionInfo | undefined> {
        const azdata = this._azdata;
        if (!azdata) {
            return undefined;
        }
        try {
            const conn = await azdata.connection.getCurrentConnection();
            if (!conn) {
                return undefined;
            }
            if (!this._currentConnection || this._currentConnection.connectionId !== conn.connectionId) {
                await this._updateCurrentConnection(conn.connectionId);
            }
            return this._currentConnection;
        } catch (err) {
            logger.warn('Failed to get current ADS connection', err);
            return undefined;
        }
    }

    private async _updateCurrentConnection(connectionId: string): Promise<void> {
        const azdata = this._azdata;
        if (!azdata) {
            return;
        }
        try {
            const credentials = await azdata.connection.getCredentials(connectionId);
            this._currentConnection = {
                connectionId,
                serverName:         credentials['server']         ?? 'unknown',
                databaseName:       credentials['database']       ?? 'unknown',
                userName:           credentials['user']           as string | undefined,
                authenticationType: credentials['authenticationType'] ?? 'unknown'
            };
            // Evict stale cache for this connection
            this._schemaCache.delete(connectionId);
            logger.info(`Active connection updated: ${this._currentConnection.serverName} / ${this._currentConnection.databaseName}`);
        } catch (err) {
            logger.warn('Failed to retrieve connection credentials', err);
        }
    }

    /**
     * Fetch schema metadata (tables + columns) for the current connection.
     * Results are cached per connection until the connection changes.
     */
    async getSchemaInfo(): Promise<SchemaInfo | undefined> {
        const conn = await this.getCurrentConnection();
        if (!conn) {
            return undefined;
        }

        if (this._schemaCache.has(conn.connectionId)) {
            return this._schemaCache.get(conn.connectionId);
        }

        const azdata = this._azdata;
        if (!azdata) {
            return undefined;
        }

        try {
            const provider = await azdata.dataprotocol.getProvider<import('azdata').MetadataProvider>(
                conn.connectionId,
                azdata.DataProviderType.MetadataProvider
            );

            const tables: TableInfo[] = [];

            if (provider) {
                const ownerUri = await azdata.connection.getUriForConnection(conn.connectionId);
                const metadata = await provider.getMetadata(ownerUri);

                for (const obj of (metadata.objectMetadata ?? [])) {
                    if (obj.metadataType === azdata.MetadataType.Table ||
                        obj.metadataType === azdata.MetadataType.View) {
                        tables.push({
                            schema:  obj.schema ?? 'dbo',
                            name:    obj.name,
                            columns: []
                        });
                    }
                }
            }

            const schemaInfo: SchemaInfo = {
                databaseName: conn.databaseName,
                tables
            };
            this._schemaCache.set(conn.connectionId, schemaInfo);
            return schemaInfo;
        } catch (err) {
            logger.warn('Failed to fetch schema metadata', err);
            return undefined;
        }
    }

    /**
     * Build a compact, human-readable schema summary string suitable for
     * injecting into a Copilot prompt as context.
     */
    async buildSchemaContext(): Promise<string> {
        const schema = await this.getSchemaInfo();
        if (!schema || schema.tables.length === 0) {
            return '';
        }

        const MAX_TABLES = 30;
        const summary = schema.tables
            .slice(0, MAX_TABLES)
            .map(t => {
                const cols = t.columns.length > 0
                    ? ` (${t.columns.map(c => `${c.name} ${c.dataType}`).join(', ')})`
                    : '';
                return `${t.schema}.${t.name}${cols}`;
            })
            .join('\n');

        const truncated = schema.tables.length > MAX_TABLES
            ? `\n... and ${schema.tables.length - MAX_TABLES} more tables`
            : '';

        return `Database: ${schema.databaseName}\nTables:\n${summary}${truncated}`;
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
