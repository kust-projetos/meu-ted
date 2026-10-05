/**
 * Minimal in-memory SQL adapter for memory tests.
 *
 * Unlike the row-shaped mocks used by the older memory suites, this one
 * understands the schema statements the store actually issues
 * (`CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `INSERT INTO ... (cols)
 * VALUES (...)`) so provenance columns and the tombstone table behave like
 * they do on a real Durable Object.
 */

type Row = Record<string, unknown>;

type Predicate = string;

/**
 * SQLite keywords that must never appear as an UNQUOTED identifier. The mock
 * used to accept any name, which is exactly why a column called `references`
 * (REFERENCES is a keyword) passed the whole suite while every real DDL/DML
 * statement using it was a syntax error. The list mirrors
 * `tests/memory-sqlite-schema.test.ts`, which validates the same set against a
 * real `node:sqlite` engine.
 */
const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY ' +
    'CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE ' +
    'CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP ' +
    'EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM ' +
    'FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD ' +
    'INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL ' +
    'NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE ' +
    'RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ' +
    'ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE ' +
    'UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'
  ).split(/\s+/).map((keyword) => keyword.toLowerCase()),
);

const assertNotKeyword = (identifier: string): void => {
  if (SQLITE_KEYWORDS.has(identifier.toLowerCase())) {
    throw new Error(`near "${identifier}": syntax error (SQLite keyword used as an unquoted identifier)`);
  }
};

/** Splits a WHERE body on top-level `AND` (parenthesised ORs stay intact). */
const splitTopLevelAnd = (raw: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  const tokens = raw.split(/(\s+)/);
  for (const token of tokens) {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    if (/^AND$/.test(token) && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += token;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
};

const stripOuterParens = (raw: string): string => {
  const text = raw.trim();
  if (!text.startsWith('(') || !text.endsWith(')')) return text;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return text;
    }
  }
  return text.slice(1, -1);
};

/** Evaluates one predicate, consuming its positional bindings in order. */
const evaluate = (
  row: Row,
  raw: Predicate,
  bindings: unknown[],
  cursor: number,
): [boolean, number] => {
  const predicate = stripOuterParens(raw.trim());
  if (predicate.includes(' OR ')) {
    let index = cursor;
    for (const branch of predicate.split(' OR ')) {
      const [ok, next] = evaluate(row, branch, bindings, index);
      if (ok) return [true, next];
      index = next;
    }
    return [false, index];
  }
  const comparison = predicate.match(/^(\w+)\s*(=|!=|<>|>=|<=|>|<)\s*(NULL|\?)$/i);
  if (!comparison) return [true, cursor];
  const [, column, operator, literal] = comparison;
  const value = row[column!];
  if (literal!.toUpperCase() === 'NULL') {
    const isNull = value == null;
    return operator === '=' ? [isNull, cursor] : [!isNull, cursor];
  }
  const expected = bindings[cursor];
  const next = cursor + 1;
  const left = value as never;
  const right = expected as never;
  if (value == null) return [false, next];
  switch (operator) {
    case '=':
      return [left === right, next];
    case '!=':
    case '<>':
      return [left !== right, next];
    case '>':
      return [left > right, next];
    case '>=':
      return [left >= right, next];
    case '<':
      return [left < right, next];
    case '<=':
      return [left <= right, next];
    default:
      return [true, next];
  }
};

export type MemorySqlMock = {
  tables: Map<string, Row[]>;
  columns: Map<string, Set<string>>;
  queries: string[];
  exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T>;
  rows(table: string): Row[];
};

export const createMemorySql = (): MemorySqlMock => {
  const tables = new Map<string, Row[]>();
  const columns = new Map<string, Set<string>>();
  const queries: string[] = [];

  const table = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    if (!columns.has(name)) columns.set(name, new Set());
    return tables.get(name)!;
  };

  const sql: MemorySqlMock = {
    tables,
    columns,
    queries,
    rows: (name: string) => table(name),
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);

      if (q.startsWith('CREATE TABLE IF NOT EXISTS')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (!name) return [] as T[];
        const body = q.slice(q.indexOf('(', q.indexOf(name)) + 1, q.lastIndexOf(')'));
        table(name);
        for (const definition of body.split(',')) {
          const column = definition.trim().split(/\s+/)[0];
          if (!column) continue;
          assertNotKeyword(column);
          columns.get(name)!.add(column);
        }
        return [] as T[];
      }
      if (q.startsWith('CREATE INDEX') || q.startsWith('CREATE UNIQUE INDEX')) return [] as T[];

      const alter = q.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
      if (alter) {
        // A keyword column is a syntax error in real SQLite: the mock refuses it
        // instead of silently "migrating" a schema no engine would accept.
        assertNotKeyword(alter[2]!);
        table(alter[1]!);
        columns.get(alter[1]!)!.add(alter[2]!);
        return [] as T[];
      }

      const insert = q.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES/i);
      if (insert) {
        const name = insert[1]!;
        const cols = insert[2]!.split(',').map((column) => column.trim());
        const row: Row = {};
        cols.forEach((column, index) => {
          assertNotKeyword(column);
          row[column] = bindings[index];
        });
        table(name).push(row);
        return [] as T[];
      }

      const select = q.match(/^SELECT \* FROM (\w+)\s*(?:WHERE (.+))?$/i);
      if (select) {
        const rows = table(select[1]!);
        const where = select[2];
        if (!where) return rows as T[];
        const predicates = splitTopLevelAnd(where);
        let cursor = 0;
        for (const predicate of predicates) {
          // First pass only counts how many bindings the WHERE consumes.
          const [, next] = evaluate({} as Row, predicate, bindings, cursor);
          cursor = next;
        }
        return rows.filter((row) => {
          let index = 0;
          for (const predicate of predicates) {
            const [ok, next] = evaluate(row, predicate, bindings, index);
            index = next;
            if (!ok) return false;
          }
          return true;
        }) as T[];
      }

      const update = q.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/i);
      if (update) {
        const rows = table(update[1]!);
        const assignments = update[2]!.split(',').map((part) => part.trim());
        for (const assignment of assignments) assertNotKeyword(assignment.split('=')[0]!.trim());
        const predicates = splitTopLevelAnd(update[3]!);
        // SET bindings come first, in assignment order; WHERE bindings follow.
        const values: Row = {};
        assignments.forEach((assignment, index) => {
          values[assignment.split('=')[0]!.trim()] = bindings[index];
        });
        const whereOffset = assignments.length;
        for (const row of rows) {
          let index = whereOffset;
          let matches = true;
          for (const predicate of predicates) {
            const [ok, next] = evaluate(row, predicate, bindings, index);
            index = next;
            if (!ok) {
              matches = false;
              break;
            }
          }
          if (matches) Object.assign(row, values);
        }
        return [] as T[];
      }

      throw new Error(`unhandled query in memory sql mock: ${q.slice(0, 90)}`);
    },
  };

  return sql;
};