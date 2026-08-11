type NodeSqliteModule = typeof import("node:sqlite");
type NativeDatabase = import("node:sqlite").DatabaseSync;
type NativeStatement = import("node:sqlite").StatementSync;

type BoundValue = null | number | bigint | string | Uint8Array;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function normalizedBinding(value: unknown): BoundValue {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`Unsupported SQLite binding value: ${Object.prototype.toString.call(value)}`);
}

function numeric(value: number | bigint) {
  return typeof value === "bigint" ? Number(value) : value;
}

function result<T>(results: T[], changes = 0, duration = 0, lastRowId?: number | bigint): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      changes,
      duration,
      ...(lastRowId === undefined ? {} : { last_row_id: numeric(lastRowId) }),
    },
  };
}

function elapsed(startedAt: number) {
  return Math.max(0, performance.now() - startedAt);
}

function queryUsuallyReturnsRows(query: string) {
  const normalized = query.replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u, "");
  return /^(?:SELECT|PRAGMA|EXPLAIN|VALUES)\b/iu.test(normalized);
}

class SqlitePreparedStatement implements D1PreparedStatement {
  readonly #owner: SqliteD1Database;
  readonly #query: string;
  readonly #bindings: BoundValue[];

  constructor(owner: SqliteD1Database, query: string, bindings: BoundValue[] = []) {
    this.#owner = owner;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values: unknown[]) {
    return new SqlitePreparedStatement(this.#owner, this.#query, values.map(normalizedBinding));
  }

  #statement(): NativeStatement {
    return this.#owner.native.prepare(this.#query);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.#statement().get(...this.#bindings) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column)) throw new Error(`Column not found: ${column}`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const startedAt = performance.now();
    const rows = this.#statement().all(...this.#bindings) as T[];
    return result(rows, 0, elapsed(startedAt));
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const startedAt = performance.now();
    const mutation = this.#statement().run(...this.#bindings);
    return result<T>([], numeric(mutation.changes), elapsed(startedAt), mutation.lastInsertRowid);
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.#statement().all(...this.#bindings) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.values(row) as T);
  }

  executeForBatch(): D1Result {
    const statement = this.#statement();
    const startedAt = performance.now();
    // StatementSync.columns() was added after the first Node 22 SQLite API.
    // Keep the package's Node 22.13 minimum viable with a query-shape fallback.
    const returnsRows = typeof statement.columns === "function"
      ? statement.columns().length > 0
      : queryUsuallyReturnsRows(this.#query);
    if (returnsRows) {
      const rows = statement.all(...this.#bindings) as Array<Record<string, unknown>>;
      return result(rows, 0, elapsed(startedAt));
    }
    const mutation = statement.run(...this.#bindings);
    return result([], numeric(mutation.changes), elapsed(startedAt), mutation.lastInsertRowid);
  }

  belongsTo(database: SqliteD1Database) {
    return this.#owner === database;
  }
}

export class SqliteD1Database implements D1Database {
  readonly native: NativeDatabase;

  constructor(database: NativeDatabase) {
    this.native = database;
    this.native.exec("PRAGMA journal_mode = WAL");
    this.native.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    this.native.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    if (!query.trim()) throw new Error("Cannot prepare an empty SQL statement");
    return new SqlitePreparedStatement(this, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    if (statements.length === 0) return [];
    const localStatements = statements.map((statement) => {
      if (!(statement instanceof SqlitePreparedStatement) || !statement.belongsTo(this)) {
        throw new TypeError("Every batch statement must be prepared by this SQLite database");
      }
      return statement;
    });

    this.native.exec("BEGIN IMMEDIATE");
    try {
      const results = localStatements.map((statement) => statement.executeForBatch());
      this.native.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.native.exec("ROLLBACK");
      } catch {
        // Preserve the statement error. A failed rollback must not hide it.
      }
      throw error;
    }
  }

  async exec(query: string) {
    const startedAt = performance.now();
    this.native.exec(query);
    return { count: query.trim() ? 1 : 0, duration: elapsed(startedAt) };
  }

  close() {
    this.native.close();
  }
}

let sqlitePromise: Promise<SqliteD1Database> | undefined;
let singletonPath: string | undefined;

async function openSqliteDatabase(path: string) {
  const moduleName = `node:${"sqlite"}`;
  const { DatabaseSync } = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleName) as NodeSqliteModule;

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const fsModule = `node:${"fs/promises"}`;
    const pathModule = `node:${"path"}`;
    const [{ mkdir }, { dirname, resolve }] = await Promise.all([
      import(/* webpackIgnore: true */ /* @vite-ignore */ fsModule) as Promise<typeof import("node:fs/promises")>,
      import(/* webpackIgnore: true */ /* @vite-ignore */ pathModule) as Promise<typeof import("node:path")>,
    ]);
    const resolvedPath = resolve(path);
    await mkdir(dirname(resolvedPath), { recursive: true });
    path = resolvedPath;
  }

  return new SqliteD1Database(new DatabaseSync(path));
}

export function getSqliteDatabase(path = "./data/dore.sqlite") {
  if (sqlitePromise && singletonPath !== path) {
    throw new Error(`SQLite is already initialized at ${singletonPath}; refusing to switch to ${path}`);
  }
  singletonPath ??= path;
  sqlitePromise ??= openSqliteDatabase(path).catch((error) => {
    sqlitePromise = undefined;
    singletonPath = undefined;
    throw error;
  });
  return sqlitePromise;
}

export async function createSqliteDatabase(path = ":memory:") {
  return openSqliteDatabase(path);
}
