import Database from "better-sqlite3";
import { config } from "./config.js";

/**
 * SQLite is used as a local cache so that no user request ever has to wait for
 * Steam. Everything in here is derived data and can be rebuilt by a refresh.
 */

export const db = new Database(config.dbPath);

// WAL keeps reads from blocking while the price worker writes.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS prices (
    market_hash_name TEXT PRIMARY KEY,
    price            REAL NOT NULL,
    currency         TEXT NOT NULL,
    source           TEXT NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_history (
    market_hash_name TEXT NOT NULL,
    price            REAL NOT NULL,
    currency         TEXT NOT NULL,
    recorded_at      INTEGER NOT NULL,
    PRIMARY KEY (market_hash_name, recorded_at)
  );

  CREATE INDEX IF NOT EXISTS idx_price_history_name
    ON price_history (market_hash_name, recorded_at DESC);

  CREATE TABLE IF NOT EXISTS inventory_cache (
    steam_id   TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export interface PriceRecord {
  marketHashName: string;
  price: number;
  currency: string;
  source: string;
  updatedAt: number;
}

interface PriceRow {
  market_hash_name: string;
  price: number;
  currency: string;
  source: string;
  updated_at: number;
}

const upsertPriceStmt = db.prepare(`
  INSERT INTO prices (market_hash_name, price, currency, source, updated_at)
  VALUES (@name, @price, @currency, @source, @updatedAt)
  ON CONFLICT (market_hash_name) DO UPDATE SET
    price      = excluded.price,
    currency   = excluded.currency,
    source     = excluded.source,
    updated_at = excluded.updated_at
`);

const selectPriceStmt = db.prepare<[string], PriceRow>(
  `SELECT * FROM prices WHERE market_hash_name = ?`,
);

const lastHistoryStmt = db.prepare<[string], { recorded_at: number }>(
  `SELECT recorded_at FROM price_history
   WHERE market_hash_name = ?
   ORDER BY recorded_at DESC LIMIT 1`,
);

const insertHistoryStmt = db.prepare(`
  INSERT OR IGNORE INTO price_history (market_hash_name, price, currency, recorded_at)
  VALUES (@name, @price, @currency, @recordedAt)
`);

const countPricesStmt = db.prepare<[], { total: number }>(
  `SELECT COUNT(*) AS total FROM prices`,
);

const selectMetaStmt = db.prepare<[string], { value: string }>(
  `SELECT value FROM meta WHERE key = ?`,
);

const upsertMetaStmt = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
);

const selectInventoryStmt = db.prepare<
  [string],
  { payload: string; fetched_at: number }
>(`SELECT payload, fetched_at FROM inventory_cache WHERE steam_id = ?`);

const upsertInventoryStmt = db.prepare(
  `INSERT INTO inventory_cache (steam_id, payload, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT (steam_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
);

const pruneInventoryStmt = db.prepare(
  `DELETE FROM inventory_cache WHERE fetched_at < ?`,
);

/**
 * Prepared statements for the chunked price lookup, keyed by chunk size. Only
 * two ever exist in practice: one full chunk and one remainder.
 */
const selectPricesStmts = new Map<
  number,
  Database.Statement<string[], PriceRow>
>();

function selectPricesStmt(
  size: number,
): Database.Statement<string[], PriceRow> {
  let statement = selectPricesStmts.get(size);
  if (!statement) {
    const placeholders = new Array<string>(size).fill("?").join(",");
    statement = db.prepare<string[], PriceRow>(
      `SELECT * FROM prices WHERE market_hash_name IN (${placeholders})`,
    );
    selectPricesStmts.set(size, statement);
  }
  return statement;
}

function toRecord(row: PriceRow): PriceRecord {
  return {
    marketHashName: row.market_hash_name,
    price: row.price,
    currency: row.currency,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

/** Writes a batch of prices in a single transaction. */
export const upsertPrices = db.transaction(
  (
    records: Array<{ name: string; price: number; source: string }>,
    updatedAt: number,
  ) => {
    for (const record of records) {
      upsertPriceStmt.run({
        name: record.name,
        price: record.price,
        currency: config.currency,
        source: record.source,
        updatedAt,
      });
    }
  },
);

/**
 * Appends history rows, but only for items whose last snapshot is older than
 * the configured interval. Without that guard a 30 minute refresh cycle would
 * write millions of rows per week.
 */
export const recordHistory = db.transaction(
  (
    records: Array<{ name: string; price: number }>,
    recordedAt: number,
    minGapMs: number,
  ) => {
    let written = 0;
    for (const record of records) {
      const last = lastHistoryStmt.get(record.name);
      if (last && recordedAt - last.recorded_at < minGapMs) continue;
      insertHistoryStmt.run({
        name: record.name,
        price: record.price,
        currency: config.currency,
        recordedAt,
      });
      written++;
    }
    return written;
  },
);

export function getPrice(marketHashName: string): PriceRecord | undefined {
  const row = selectPriceStmt.get(marketHashName);
  return row ? toRecord(row) : undefined;
}

/**
 * Bulk variant of getPrice. Chunked because SQLite limits the number of bound
 * parameters in a single statement.
 */
export function getPricesFor(names: string[]): Map<string, PriceRecord> {
  const result = new Map<string, PriceRecord>();
  const chunkSize = 400;
  for (let i = 0; i < names.length; i += chunkSize) {
    const chunk = names.slice(i, i + chunkSize);
    const rows = selectPricesStmt(chunk.length).all(...chunk);
    for (const row of rows) {
      result.set(row.market_hash_name, toRecord(row));
    }
  }
  return result;
}

export function countPrices(): number {
  return countPricesStmt.get()?.total ?? 0;
}

export function getMeta(key: string): string | undefined {
  return selectMetaStmt.get(key)?.value;
}

export function setMeta(key: string, value: string): void {
  upsertMetaStmt.run(key, value);
}

export function getCachedInventory(
  steamId: string,
): { payload: string; fetchedAt: number } | undefined {
  const row = selectInventoryStmt.get(steamId);
  return row ? { payload: row.payload, fetchedAt: row.fetched_at } : undefined;
}

export function setCachedInventory(
  steamId: string,
  payload: string,
  fetchedAt: number,
): void {
  upsertInventoryStmt.run(steamId, payload, fetchedAt);
}

/** Drops inventory snapshots that nobody has requested in a long time. */
export function pruneInventoryCache(maxAgeMs: number): void {
  pruneInventoryStmt.run(Date.now() - maxAgeMs);
}
