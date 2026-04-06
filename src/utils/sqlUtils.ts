/**
 * SQL utility helpers used by multiple providers.
 */

/** Remove SQL line comments (--) and block comments (/* *\/) from a string. */
export function stripComments(sql: string): string {
    // Remove block comments
    let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
    // Remove line comments
    result = result.replace(/--[^\n]*/g, '');
    return result.trim();
}

/**
 * Extract the SQL statement that contains the given 0-based offset.
 * Statements are delimited by semicolons.
 */
export function extractStatementAtOffset(sql: string, offset: number): string {
    const statements = splitStatements(sql);
    let pos = 0;
    for (const stmt of statements) {
        const end = pos + stmt.length;
        if (offset >= pos && offset <= end) {
            return stmt.trim();
        }
        pos = end + 1; // +1 for the semicolon delimiter
    }
    return sql.trim();
}

/** Split a SQL script into individual statements (split on semicolons). */
export function splitStatements(sql: string): string[] {
    return sql
        .split(/;/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/**
 * Detect the primary SQL operation of a statement.
 * Returns one of: SELECT | INSERT | UPDATE | DELETE | CREATE | ALTER | DROP | EXEC | UNKNOWN
 */
export function detectOperation(sql: string): string {
    const cleaned = stripComments(sql).trim().toUpperCase();
    const operations = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'EXEC', 'EXECUTE', 'MERGE', 'WITH'];
    for (const op of operations) {
        if (cleaned.startsWith(op)) {
            return op === 'EXECUTE' ? 'EXEC' : op;
        }
    }
    return 'UNKNOWN';
}

/**
 * Extract table names referenced in a simple SELECT/FROM clause.
 * This is a heuristic and does not handle all edge cases.
 */
export function extractTableNames(sql: string): string[] {
    const cleaned = stripComments(sql);
    const fromRegex = /\bFROM\b\s+([\w\.\[\]"` ]+?)(?:\s+(?:WHERE|JOIN|GROUP|ORDER|HAVING|LIMIT|UNION|$))/gi;
    const joinRegex = /\b(?:JOIN)\b\s+([\w\.\[\]"` ]+?)(?:\s+(?:ON|WHERE|JOIN|GROUP|ORDER|$))/gi;

    const tables: Set<string> = new Set();
    let match: RegExpExecArray | null;

    while ((match = fromRegex.exec(cleaned)) !== null) {
        parseTableList(match[1], tables);
    }
    while ((match = joinRegex.exec(cleaned)) !== null) {
        parseTableList(match[1], tables);
    }

    return Array.from(tables);
}

function parseTableList(raw: string, out: Set<string>): void {
    raw.split(',').forEach(part => {
        // Take only the table name (first token), strip aliases
        const name = part.trim().split(/\s+/)[0];
        if (name) {
            out.add(name.replace(/[\[\]"`]/g, ''));
        }
    });
}

/** Returns true if the string looks like it might be part of a SQL keyword. */
export function isSqlKeyword(word: string): boolean {
    const keywords = new Set([
        'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
        'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
        'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
        'ALTER', 'DROP', 'INDEX', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER',
        'BEGIN', 'END', 'TRANSACTION', 'COMMIT', 'ROLLBACK', 'WITH', 'CTE',
        'CASE', 'WHEN', 'THEN', 'ELSE', 'TOP', 'DISTINCT', 'COUNT', 'SUM', 'AVG',
        'MIN', 'MAX', 'COALESCE', 'ISNULL', 'CAST', 'CONVERT', 'DATEADD', 'DATEDIFF'
    ]);
    return keywords.has(word.toUpperCase());
}

/** Truncate a string to maxLen characters, appending "..." if truncated. */
export function truncate(value: string, maxLen: number): string {
    if (value.length <= maxLen) {
        return value;
    }
    return value.slice(0, maxLen) + '...';
}
