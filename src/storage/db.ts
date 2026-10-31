// Thin promise layer over IndexedDB. No dependency: we need versioned upgrades,
// single-transaction read-modify-write, and quarantine of unreadable records.

import type { Parser } from '../shared/validate';
import { tryParse } from '../shared/validate';

export const DB_NAME = 'tabvault';
export const DB_VERSION = 1;

export type StoreName = 'workspaces' | 'sessions' | 'later' | 'annotations' | 'rules' | 'activity' | 'kv' | 'quarantine';

/**
 * Migrations run in order inside the upgrade transaction, so a failure aborts and
 * leaves the old database intact. Add a new entry and bump DB_VERSION to change schema.
 */
const MIGRATIONS: ((db: IDBDatabase, tx: IDBTransaction) => void)[] = [
  (db) => {
    db.createObjectStore('workspaces', { keyPath: 'id' });
    const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
    sessions.createIndex('kind', 'kind');
    db.createObjectStore('later', { keyPath: 'id' });
    db.createObjectStore('annotations', { keyPath: 'urlKey' });
    db.createObjectStore('rules', { keyPath: 'id' });
    db.createObjectStore('activity', { keyPath: 'day' });
    db.createObjectStore('kv');
    db.createObjectStore('quarantine', { autoIncrement: true });
  },
];

export class StorageError extends Error {
  constructor(message: string, readonly quota = false) {
    super(message);
    this.name = 'StorageError';
  }
}

function friendly(err: unknown): StorageError {
  const name = (err as DOMException | undefined)?.name;
  if (name === 'QuotaExceededError') {
    return new StorageError('Your disk is full, so TabVault could not save this. Free up space and try again.', true);
  }
  return new StorageError(`Local storage error: ${(err as Error | undefined)?.message ?? 'unknown'}`);
}

let connection: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      for (let v = event.oldVersion; v < MIGRATIONS.length; v++) MIGRATIONS[v]!(db, tx);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another context upgrading, or the browser closing the handle: reopen next time.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      db.onclose = () => {
        connection = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      connection = null;
      reject(friendly(req.error));
    };
    req.onblocked = () => {
      connection = null;
      reject(new StorageError('Storage upgrade is blocked by another TabVault page. Close it and retry.'));
    };
  });
  return connection;
}

/** Test seam, and recovery path if a connection goes bad. */
export function resetConnection(): void {
  connection = null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `body` in one transaction and resolve only after it commits. Everything inside
 * is all-or-nothing, which is what keeps multi-record updates safe if the worker dies.
 */
export async function transact<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const run = async () => {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(friendly(failure ?? tx.error));
      tx.onabort = () => reject(friendly(failure ?? tx.error));
      Promise.resolve()
        .then(() => body(tx))
        .then((value) => {
          result = value;
        })
        .catch((err) => {
          failure = err;
          try {
            tx.abort();
          } catch {
            // already finished
          }
        });
    });
  };
  try {
    return await run();
  } catch (err) {
    // A handle closed under us (worker restart, version change): retry once on a fresh one.
    if ((err as DOMException).name === 'InvalidStateError') {
      connection = null;
      return run();
    }
    throw err;
  }
}

export const get = <T>(store: StoreName, key: IDBValidKey) =>
  transact(store, 'readonly', (tx) => request<T | undefined>(tx.objectStore(store).get(key)));

export const put = <T>(store: StoreName, value: T, key?: IDBValidKey) =>
  transact(store, 'readwrite', async (tx) => {
    await request(tx.objectStore(store).put(value, key));
  });

export const del = (store: StoreName, key: IDBValidKey | IDBValidKey[]) =>
  transact(store, 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    await Promise.all((Array.isArray(key) ? key : [key]).map((k) => request(os.delete(k))));
  });

export const rawAll = <T>(store: StoreName) => transact(store, 'readonly', (tx) => request<T[]>(tx.objectStore(store).getAll()));

/** Read-modify-write in a single transaction. Return undefined from `fn` to skip the write. */
export function mutate<T>(store: StoreName, key: IDBValidKey, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
  return transact(store, 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    const current = await request<T | undefined>(os.get(key));
    const next = fn(current);
    if (next === undefined) return current;
    await request(os.keyPath ? os.put(next) : os.put(next, key));
    return next;
  });
}

/**
 * Read a whole store through its schema. Records that no longer parse are moved to
 * `quarantine` rather than deleted, so one corrupt entry never breaks the app or
 * silently destroys data.
 */
export async function readAll<T>(store: StoreName, parser: Parser<T>): Promise<T[]> {
  const rows = await rawAll<unknown>(store);
  const good: T[] = [];
  const bad: unknown[] = [];
  for (const row of rows) {
    const parsed = tryParse(parser, row);
    if (parsed) good.push(parsed);
    else bad.push(row);
  }
  if (bad.length) await quarantine(store, bad).catch(() => undefined);
  return good;
}

export async function readOne<T>(store: StoreName, key: IDBValidKey, parser: Parser<T>): Promise<T | undefined> {
  const row = await get<unknown>(store, key);
  if (row === undefined) return undefined;
  const parsed = tryParse(parser, row);
  if (parsed) return parsed;
  await quarantine(store, [row]).catch(() => undefined);
  return undefined;
}

async function quarantine(store: StoreName, rows: unknown[]): Promise<void> {
  await transact([store, 'quarantine'], 'readwrite', async (tx) => {
    const source = tx.objectStore(store);
    const dest = tx.objectStore('quarantine');
    const keyPath = source.keyPath as string;
    await Promise.all(
      rows.map(async (row) => {
        await request(dest.add({ store, row, at: Date.now() }));
        const key = (row as Record<string, IDBValidKey> | null)?.[keyPath];
        if (key !== undefined) await request(source.delete(key));
      }),
    );
  });
}

export const countQuarantined = () => transact('quarantine', 'readonly', (tx) => request(tx.objectStore('quarantine').count()));

export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  await transact(store, 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    await Promise.all(values.map((v) => request(os.put(v))));
  });
}

export { request };
