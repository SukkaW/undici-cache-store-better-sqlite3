import type CacheHandler from 'undici/types/cache-interceptor';

import { Writable } from 'node:stream';
import createDb from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import type { Database, Statement } from 'better-sqlite3';

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
  maxEntrySize?: number
}

const VERSION = 3;

// 2gb
const MAX_ENTRY_SIZE = 2 * 1000 * 1000 * 1000;

interface SqliteStoreValue extends Omit<CacheHandler.CacheValue, 'headers' | 'vary' | 'cacheControlDirectives'> {
  readonly id: number,
  headers?: string,
  vary?: string,
  body: string,
  cacheControlDirectives: string,

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

  constructor({
    location = ':memory:',
    maxCount = Infinity,
    maxEntrySize = MAX_ENTRY_SIZE
  }: BetterSqlite3CacheStoreOpts = {}) {
    this.maxCount = maxCount;
    this.maxEntrySize = maxEntrySize;

    this.db = createDb(location);

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
        staleAt = ?,
        deleteAt = ?
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
        staleAt,
        deleteAt
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

  get(key: CacheHandler.CacheKey): CacheHandler.GetResult | undefined {
    assertCacheKey(key);

    const value = this.findValue(key);

    if (!value) {
      return undefined;
    }

    return {
      body: Buffer.from(value.body),
      statusCode: value.statusCode,
      statusMessage: value.statusMessage,
      headers: value.headers ? JSON.parse(value.headers) : undefined,
      etag: value.etag ?? undefined,
      vary: value.vary as CacheHandler.CacheValue['vary'] ?? undefined,
      cacheControlDirectives: value.cacheControlDirectives
        ? JSON.parse(value.cacheControlDirectives)
        : undefined,
      cachedAt: value.cachedAt,
      staleAt: value.staleAt,
      deleteAt: value.deleteAt
    } satisfies CacheHandler.GetResult;
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
    if (removed > 0) {
      return removed;
    }

    if (this.deleteOldValuesQuery) {
      const removed = this.deleteOldValuesQuery.run(Math.max(Math.floor(this.maxCount * 0.1), 1)).changes;
      if (removed > 0) {
        return removed;
      }
    }

    return 0;
  }

  createWriteStream(key: CacheHandler.CacheKey, value: CacheHandler.CacheValue) {
    assertCacheKey(key);
    assertCacheValue(value);

    const url = makeValueUrl(key);
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
        const existingValue = store.findValue(key, true);
        if (existingValue) {
          // Updating an existing response, let's overwrite it
          store.updateValueQuery.run(
            Buffer.concat(body),
            value.deleteAt,
            value.statusCode,
            value.statusMessage,
            value.headers ? JSON.stringify(value.headers) : null,
            value.etag || null,
            value.cacheControlDirectives ? JSON.stringify(value.cacheControlDirectives) : null,
            value.cachedAt,
            value.staleAt,
            value.deleteAt,
            existingValue.id
          );
        } else {
          store.prune();
          // New response, let's insert it
          store.insertValueQuery.run(
            url,
            key.method,
            Buffer.concat(body),
            value.deleteAt,
            value.statusCode,
            value.statusMessage,
            value.headers ? JSON.stringify(value.headers) : null,
            value.etag || null,
            value.cacheControlDirectives ? JSON.stringify(value.cacheControlDirectives) : null,
            value.vary ? JSON.stringify(value.vary) : null,
            value.cachedAt,
            value.staleAt,
            value.deleteAt
          );
        }

        callback();
      }
    });
  }

  delete(key: CacheHandler.CacheKey) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`);
    }

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
    if (lhs.length !== rhs.length) {
      return false;
    }

    for (let i = 0; i < lhs.length; i++) {
      if (rhs.includes(lhs[i])) {
        return false;
      }
    }

    return true;
  }

  return lhs === rhs;
}
