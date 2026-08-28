/**
 * SQLite driver adapter.
 *
 * Prefers better-sqlite3 when it is installed (mature, stable API), and falls
 * back to Node's built-in node:sqlite otherwise. The built-in path means a
 * clean `npm install` needs no compiler, no Rust and no node-gyp — which is the
 * difference between "it runs on your friend's laptop" and a support call.
 *
 * Only the intersection of the two APIs is used: exec(), and prepare() with
 * POSITIONAL (?) parameters. Do not introduce named parameters or driver-
 * specific helpers here; that is what would make the fallback a lie.
 */

export interface RunResult { changes: number; lastInsertRowid: number | bigint }

export interface Stmt {
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[];
  run(...params: SqlParam[]): RunResult;
}

export type SqlParam = string | number | bigint | Uint8Array | null;

export interface Driver {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
  readonly kind: 'better-sqlite3' | 'node:sqlite';
}

export async function openDatabase(file: string): Promise<Driver> {
  try {
    // The specifier is held in a variable on purpose. better-sqlite3 is
    // genuinely optional; a literal import would make TypeScript demand types
    // for a package that is usually not installed.
    const specifier = 'better-sqlite3';
    const mod = await import(specifier);
    const Database = (mod.default ?? mod) as unknown as new (f: string) => {
      exec(s: string): void;
      prepare(s: string): Stmt;
      close(): void;
    };
    const db = new Database(file);
    return {
      kind: 'better-sqlite3',
      exec: (s) => db.exec(s),
      prepare: (s) => db.prepare(s),
      close: () => db.close(),
    };
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    return {
      kind: 'node:sqlite',
      exec: (s) => db.exec(s),
      prepare: (s) => {
        const st = db.prepare(s);
        return {
          get: <T>(...p: SqlParam[]) => st.get(...(p as never[])) as T | undefined,
          all: <T>(...p: SqlParam[]) => st.all(...(p as never[])) as T[],
          run: (...p: SqlParam[]) => st.run(...(p as never[])) as unknown as RunResult,
        };
      },
      close: () => db.close(),
    };
  }
}
