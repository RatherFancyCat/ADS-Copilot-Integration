import * as assert from 'assert';
import {
    stripComments,
    splitStatements,
    detectOperation,
    extractTableNames,
    isSqlKeyword,
    truncate,
    extractStatementAtOffset
} from '../utils/sqlUtils';

suite('sqlUtils', () => {
    // ── stripComments ────────────────────────────────────────────────────────
    suite('stripComments', () => {
        test('removes single-line comments', () => {
            const sql = 'SELECT 1 -- this is a comment\nFROM dual';
            assert.strictEqual(stripComments(sql), 'SELECT 1 \nFROM dual');
        });

        test('removes block comments', () => {
            const sql = 'SELECT /* block */ 1';
            assert.strictEqual(stripComments(sql), 'SELECT  1');
        });

        test('returns input unchanged when there are no comments', () => {
            const sql = 'SELECT id FROM users';
            assert.strictEqual(stripComments(sql), sql);
        });

        test('handles multiline block comment', () => {
            const sql = '/* line 1\nline 2 */\nSELECT 1';
            assert.strictEqual(stripComments(sql), 'SELECT 1');
        });
    });

    // ── splitStatements ──────────────────────────────────────────────────────
    suite('splitStatements', () => {
        test('splits on semicolons', () => {
            const parts = splitStatements('SELECT 1; SELECT 2; SELECT 3');
            assert.strictEqual(parts.length, 3);
            assert.strictEqual(parts[0], 'SELECT 1');
            assert.strictEqual(parts[1], 'SELECT 2');
            assert.strictEqual(parts[2], 'SELECT 3');
        });

        test('ignores empty segments', () => {
            const parts = splitStatements('SELECT 1;;SELECT 2');
            assert.strictEqual(parts.length, 2);
        });

        test('handles a single statement without a trailing semicolon', () => {
            const parts = splitStatements('SELECT * FROM users');
            assert.strictEqual(parts.length, 1);
        });
    });

    // ── detectOperation ──────────────────────────────────────────────────────
    suite('detectOperation', () => {
        const cases: [string, string][] = [
            ['SELECT id FROM t', 'SELECT'],
            ['INSERT INTO t VALUES (1)', 'INSERT'],
            ['UPDATE t SET col = 1', 'UPDATE'],
            ['DELETE FROM t WHERE id = 1', 'DELETE'],
            ['CREATE TABLE t (id INT)', 'CREATE'],
            ['ALTER TABLE t ADD col INT', 'ALTER'],
            ['DROP TABLE t', 'DROP'],
            ['EXEC sp_help', 'EXEC'],
            ['EXECUTE sp_help', 'EXEC'],
            ['WITH cte AS (SELECT 1) SELECT * FROM cte', 'WITH'],
            ['MERGE target USING src', 'MERGE'],
            ['    SELECT 1', 'SELECT'],   // leading whitespace
            ['-- comment\nSELECT 1', 'SELECT'],   // comment before keyword
        ];

        for (const [sql, expected] of cases) {
            test(`detects ${expected}`, () => {
                assert.strictEqual(detectOperation(sql), expected);
            });
        }

        test('returns UNKNOWN for unrecognised statements', () => {
            assert.strictEqual(detectOperation('VACUUM FULL'), 'UNKNOWN');
        });
    });

    // ── extractTableNames ────────────────────────────────────────────────────
    suite('extractTableNames', () => {
        test('extracts single table in FROM clause', () => {
            const tables = extractTableNames('SELECT id FROM users WHERE id = 1');
            assert.ok(tables.includes('users'), `Expected "users" in [${tables}]`);
        });

        test('extracts joined tables', () => {
            const sql = 'SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id';
            const tables = extractTableNames(sql);
            assert.ok(tables.includes('orders'),    `Expected "orders" in [${tables}]`);
            assert.ok(tables.includes('customers'), `Expected "customers" in [${tables}]`);
        });
    });

    // ── isSqlKeyword ─────────────────────────────────────────────────────────
    suite('isSqlKeyword', () => {
        test('recognises SELECT as a keyword', () => {
            assert.strictEqual(isSqlKeyword('SELECT'), true);
        });
        test('is case-insensitive', () => {
            assert.strictEqual(isSqlKeyword('select'), true);
            assert.strictEqual(isSqlKeyword('Select'), true);
        });
        test('rejects non-keywords', () => {
            assert.strictEqual(isSqlKeyword('users'), false);
            assert.strictEqual(isSqlKeyword('myColumn'), false);
        });
    });

    // ── truncate ─────────────────────────────────────────────────────────────
    suite('truncate', () => {
        test('leaves short strings unchanged', () => {
            assert.strictEqual(truncate('hello', 10), 'hello');
        });
        test('truncates long strings with ellipsis', () => {
            assert.strictEqual(truncate('hello world', 5), 'hello...');
        });
        test('handles exact length boundary', () => {
            assert.strictEqual(truncate('hello', 5), 'hello');
        });
    });

    // ── extractStatementAtOffset ──────────────────────────────────────────────
    suite('extractStatementAtOffset', () => {
        test('returns the statement containing the given offset', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3';
            // Offset 0 is inside "SELECT 1"
            assert.strictEqual(extractStatementAtOffset(sql, 0), 'SELECT 1');
        });

        test('returns the second statement when offset is past the first semicolon', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3';
            // Position 10 is inside " SELECT 2"
            assert.strictEqual(extractStatementAtOffset(sql, 11), 'SELECT 2');
        });
    });
});
