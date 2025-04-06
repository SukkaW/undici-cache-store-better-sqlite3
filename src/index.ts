import type CacheHandler from 'undici/types/cache-interceptor';

import { Writable } from 'node:stream';
import createDb from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import type { Database, Statement } from 'better-sqlite3';

import { noop } from 'foxts/noop';

export interface BetterSqlite3CacheStoreOpts {
  /**
   * Location of the database
   * @default ':memory:'
   */
  location?: string,

  /**
   * @default Infinity
   */
  maxCount?: number,

  /**
   * @default Infinity
   */
  maxEntrySize?: number,

  /**
   * When set to true, the runtime type validation is disabled to improve performance.
   *
   * @default false
   */
  loose?: boolean
}

const VERSION = 3;

// 2gb
const MAX_ENTRY_SIZE = 2 * 1000 * 1000 * 1000;

interface SqliteStoreValue {
  readonly id: number,
  body?: Uint8Array,
  statusCode: number,
  statusMessage: string,
  headers?: string,
  vary?: string,
  etag?: string,
  cacheControlDirectives?: string,
  cachedAt: number,
  staleAt: number,
  deleteAt: number
}

export class BetterSqlite3CacheStore implements CacheHandler.CacheStore {
  private maxEntrySize = MAX_ENTRY_SIZE;
  private maxCount = Infinity;

  private db: Database;

  private getValuesQuery: Statement<[url: string, method: string], SqliteStoreValue>;
  private insertValueQuery: Statement;
  private updateValueQuery: Statement;
  private deleteByUrlQuery: Statement;
  private countEntriesQuery: Statement<[], { total: number }>;
  private deleteExpiredValuesQuery: Statement;
  private deleteOldValuesQuery: Statement<[number], number> | null;

  private assertCacheKey: (key: any) => asserts key is CacheHandler.CacheKey;
  private assertCacheValue: (value: any) => asserts value is CacheHandler.CacheValue;

  constructor({
    location = ':memory:',
    maxCount = Infinity,
    maxEntrySize = MAX_ENTRY_SIZE,
    loose = false
  }: BetterSqlite3CacheStoreOpts = {}) {
    this.maxCount = maxCount;
    this.maxEntrySize = maxEntrySize;

    this.assertCacheKey = loose ? noop : assertCacheKey;
    this.assertCacheValue = loose ? noop : assertCacheValue;

    this.db = createDb(location, { fileMustExist: false });

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = normal');
    this.db.pragma('temp_store = memory');
    this.db.pragma('optimize');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cacheInterceptorV${VERSION} (
        -- Data specific to us
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        method TEXT NOT NULL,

        -- Data returned to the interceptor
        body BUF NULL,
        deleteAt INTEGER NOT NULL,
        statusCode INTEGER NOT NULL,
        statusMessage TEXT NOT NULL,
        headers TEXT NULL,
        cacheControlDirectives TEXT NULL,
        etag TEXT NULL,
        vary TEXT NULL,
        cachedAt INTEGER NOT NULL,
        staleAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_url ON cacheInterceptorV${VERSION}(url);
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_method ON cacheInterceptorV${VERSION}(method);
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_deleteAt ON cacheInterceptorV${VERSION}(deleteAt);
    `);

    this.getValuesQuery = this.db.prepare(`
      SELECT
        id,
        body,
        deleteAt,
        statusCode,
        statusMessage,
        headers,
        etag,
        cacheControlDirectives,
        vary,
        cachedAt,
        staleAt
      FROM cacheInterceptorV${VERSION}
      WHERE
        url = ?
        AND method = ?
      ORDER BY
        deleteAt ASC
    `);

    this.updateValueQuery = this.db.prepare(`
      UPDATE cacheInterceptorV${VERSION} SET
        body = ?,
        deleteAt = ?,
        statusCode = ?,
        statusMessage = ?,
        headers = ?,
        etag = ?,
        cacheControlDirectives = ?,
        cachedAt = ?,
        staleAt = ?
      WHERE
        id = ?
    `);

    this.insertValueQuery = this.db.prepare(`
      INSERT INTO cacheInterceptorV${VERSION} (
        url,
        method,
        body,
        deleteAt,
        statusCode,
        statusMessage,
        headers,
        etag,
        cacheControlDirectives,
        vary,
        cachedAt,
        staleAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.deleteByUrlQuery = this.db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE url = ?`
    );

    this.countEntriesQuery = this.db.prepare(
      `SELECT COUNT(*) AS total FROM cacheInterceptorV${VERSION}`
    );

    this.deleteExpiredValuesQuery = this.db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE deleteAt <= ?`
    );

    this.deleteOldValuesQuery = this.maxCount === Infinity
      ? null
      : this.db.prepare(`
        DELETE FROM cacheInterceptorV${VERSION}
        WHERE id IN (
          SELECT
            id
          FROM cacheInterceptorV${VERSION}
          ORDER BY cachedAt DESC
          LIMIT ?
        )
      `);
  }

  close() {
    this.db.close();
  }

  private findValue(key: CacheHandler.CacheKey, canBeExpired = false) {
    const url = makeValueUrl(key);
    const { headers, method } = key;

    const values = this.getValuesQuery.all(url, method);

    if (values.length === 0) {
      return;
    }

    const now = Date.now();
    for (const value of values) {
      if (now >= value.deleteAt && !canBeExpired) {
        return;
      }

      let matches = true;

      let vary;
      if (value.vary) {
        if (!headers) {
          return;
        }

        if (typeof value.vary === 'string') {
          vary = JSON.parse(value.vary);
        } else {
          vary = value.vary;
        }

        for (const header in vary) {
          if (!headerValueEquals(headers[header], vary[header])) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        return value;
      }
    }
  }

  get(key: CacheHandler.CacheKey): CacheHandler.GetResult & { body?: Buffer } | undefined {
    this.assertCacheKey(key);

    const value = this.findValue(key);
    return value
      ? {
        body: value.body ? Buffer.from(value.body.buffer, value.body.byteOffset, value.body.byteLength) : undefined,
        statusCode: value.statusCode,
        statusMessage: value.statusMessage,
        headers: value.headers ? JSON.parse(value.headers) : undefined,
        etag: value.etag || undefined,
        vary: value.vary ? JSON.parse(value.vary) : undefined,
        cacheControlDirectives: value.cacheControlDirectives
          ? JSON.parse(value.cacheControlDirectives)
          : undefined,
        cachedAt: value.cachedAt,
        staleAt: value.staleAt,
        deleteAt: value.deleteAt
      }
      : undefined;
  }

  set(key: CacheHandler.CacheKey, value: CacheHandler.CacheValue & { body: null | Buffer | Buffer[] }) {
    assertCacheKey(key);

    const url = makeValueUrl(key);
    const body = Array.isArray(value.body) ? Buffer.concat(value.body) : value.body;
    const size = body?.byteLength;

    if (size && size > this.maxEntrySize) {
      return;
    }

    const existingValue = this.findValue(key, true);
    if (existingValue) {
      // Updating an existing response, let's overwrite it
      this.updateValueQuery.run(
        body,
        value.deleteAt,
        value.statusCode,
        value.statusMessage,
        value.headers ? JSON.stringify(value.headers) : null,
        value.etag || null,
        value.cacheControlDirectives ? JSON.stringify(value.cacheControlDirectives) : null,
        value.cachedAt,
        value.staleAt,
        existingValue.id
      );
    } else {
      this.prune();
      // New response, let's insert it
      this.insertValueQuery.run(
        url,
        key.method,
        body,
        value.deleteAt,
        value.statusCode,
        value.statusMessage,
        value.headers ? JSON.stringify(value.headers) : null,
        value.etag || null,
        value.cacheControlDirectives ? JSON.stringify(value.cacheControlDirectives) : null,
        value.vary ? JSON.stringify(value.vary) : null,
        value.cachedAt,
        value.staleAt
      );
    }
  }

  /**
   * Counts the number of rows in the cache
   */
  get size() {
    const { total } = this.countEntriesQuery.get()!;
    return total;
  }

  private prune() {
    if (this.size <= this.maxCount) {
      return 0;
    }

    const removed = this.deleteExpiredValuesQuery.run(Date.now()).changes;
    if (removed) {
      return removed;
    }

    if (this.deleteOldValuesQuery) {
      const removed = this.deleteOldValuesQuery.run(Math.max(Math.floor(this.maxCount * 0.1), 1)).changes;
      if (removed) {
        return removed;
      }
    }

    return 0;
  }

  createWriteStream(key: CacheHandler.CacheKey, value: CacheHandler.CacheValue) {
    this.assertCacheKey(key);
    this.assertCacheValue(value);

    let size = 0;

    const body: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- inside class calling outer methods
    const store = this;

    return new Writable({
      write(chunk, encoding, callback) {
        if (typeof chunk === 'string') {
          chunk = Buffer.from(chunk, encoding);
        }

        size += chunk.byteLength;

        if (size < store.maxEntrySize) {
          body.push(chunk);
        } else {
          this.destroy();
        }

        callback();
      },
      final(callback) {
        store.set(key, { ...value, body });
        callback();
      }
    });
  }

  delete(key: CacheHandler.CacheKey) {
    this.assertCacheKey(key);

    this.deleteByUrlQuery.run(makeValueUrl(key));
  }
}

function makeValueUrl(key: CacheHandler.CacheKey) {
  return `${key.origin}/${key.path}`;
}

function assertCacheKey(key: any): asserts key is CacheHandler.CacheValue {
  if (typeof key !== 'object') {
    throw new TypeError(`expected key to be object, got ${typeof key}`);
  }

  for (const property of ['origin', 'method', 'path']) {
    if (typeof key[property] !== 'string') {
      throw new TypeError(`expected key.${property} to be string, got ${typeof key[property]}`);
    }
  }

  if (key.headers !== undefined && typeof key.headers !== 'object') {
    throw new TypeError(`expected headers to be object, got ${typeof key}`);
  }
}

function assertCacheValue(value: any): asserts value is CacheHandler.CacheValue {
  if (typeof value !== 'object') {
    throw new TypeError(`expected value to be object, got ${typeof value}`);
  }

  for (const property of ['statusCode', 'cachedAt', 'staleAt', 'deleteAt']) {
    if (typeof value[property] !== 'number') {
      throw new TypeError(`expected value.${property} to be number, got ${typeof value[property]}`);
    }
  }

  if (typeof value.statusMessage !== 'string') {
    throw new TypeError(`expected value.statusMessage to be string, got ${typeof value.statusMessage}`);
  }

  if (value.headers != null && typeof value.headers !== 'object') {
    throw new TypeError(`expected value.rawHeaders to be object, got ${typeof value.headers}`);
  }

  if (value.vary !== undefined && typeof value.vary !== 'object') {
    throw new TypeError(`expected value.vary to be object, got ${typeof value.vary}`);
  }

  if (value.etag !== undefined && typeof value.etag !== 'string') {
    throw new TypeError(`expected value.etag to be string, got ${typeof value.etag}`);
  }
}

function headerValueEquals(lhs: string | string[] | null | undefined, rhs: string | string[] | null | undefined) {
  if (Array.isArray(lhs) && Array.isArray(rhs)) {
    for (let i = 0; i < lhs.length; i++) {
      if (rhs.includes(lhs[i])) {
        return false;
      }
    }

    return true;
  }

  return lhs === rhs;
}
