import Database from "better-sqlite3";
import { config } from "./config.js";

/**
 * SQLite is used as a local cache so that no user request ever has to wait for
 * Steam. Everything in here is derived data and can be rebuilt over time.
 *
 * Pricing is demand driven: names seen in requests are recorded in
 * tracked_items, and the background worker refreshes the oldest of those.
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

  CREATE TABLE IF NOT EXISTS tracked_items (
    market_hash_name TEXT PRIMARY KEY,
    first_seen       INTEGER NOT NULL,
    last_requested   INTEGER NOT NULL,
    failures         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inventory_cache (
    steam_id   TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS steam_profiles (
    steam_id     TEXT PRIMARY KEY,
    persona_name TEXT NOT NULL,
    real_name    TEXT,
    avatar_url   TEXT NOT NULL,
    profile_url  TEXT NOT NULL,
    visibility   INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vanity_resolutions (
    vanity      TEXT PRIMARY KEY,
    steam_id    TEXT,
    resolved_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_cache (
    steam_id   TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hltb_games (
    app_id        INTEGER PRIMARY KEY,
    hltb_id       INTEGER,
    hltb_name     TEXT,
    main_story    INTEGER,
    main_extra    INTEGER,
    completionist INTEGER,
    matched       INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS steam_tags (
    app_id     INTEGER PRIMARY KEY,
    tag_ids    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS steam_tag_names (
    tag_id   INTEGER NOT NULL,
    language TEXT NOT NULL,
    name     TEXT NOT NULL,
    PRIMARY KEY (tag_id, language)
  );

  CREATE TABLE IF NOT EXISTS tracked_games (
    app_id         INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    first_seen     INTEGER NOT NULL,
    last_requested INTEGER NOT NULL,
    failures       INTEGER NOT NULL DEFAULT 0
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

interface InventoryRow {
  payload: string;
  fetched_at: number;
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

const trackItemStmt = db.prepare(`
  INSERT INTO tracked_items (market_hash_name, first_seen, last_requested)
  VALUES (?, ?, ?)
  ON CONFLICT (market_hash_name) DO UPDATE SET last_requested = excluded.last_requested
`);

/**
 * Names whose price is missing or past its maximum age, oldest first. Entries
 * that keep failing sink to the back and drop out entirely once they exceed
 * the failure limit, so a permanently unlistable item cannot block the queue.
 */
const selectDueStmt = db.prepare<[number, number, number], { name: string }>(`
  SELECT t.market_hash_name AS name
  FROM tracked_items t
  LEFT JOIN prices p ON p.market_hash_name = t.market_hash_name
  WHERE t.failures < ?
    AND (p.updated_at IS NULL OR p.updated_at < ?)
  ORDER BY t.failures ASC, COALESCE(p.updated_at, 0) ASC
  LIMIT ?
`);

const countDueStmt = db.prepare<[number, number], { total: number }>(`
  SELECT COUNT(*) AS total
  FROM tracked_items t
  LEFT JOIN prices p ON p.market_hash_name = t.market_hash_name
  WHERE t.failures < ?
    AND (p.updated_at IS NULL OR p.updated_at < ?)
`);

const markFailureStmt = db.prepare(
  `UPDATE tracked_items SET failures = failures + 1 WHERE market_hash_name = ?`,
);

const markSuccessStmt = db.prepare(
  `UPDATE tracked_items SET failures = 0 WHERE market_hash_name = ?`,
);

const pruneTrackedStmt = db.prepare(
  `DELETE FROM tracked_items WHERE last_requested < ?`,
);

const countPricesStmt = db.prepare<[], { total: number }>(
  `SELECT COUNT(*) AS total FROM prices`,
);

const countTrackedStmt = db.prepare<[], { total: number }>(
  `SELECT COUNT(*) AS total FROM tracked_items`,
);

const selectMetaStmt = db.prepare<[string], { value: string }>(
  `SELECT value FROM meta WHERE key = ?`,
);

const upsertMetaStmt = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?)
   ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
);

const selectInventoryStmt = db.prepare<[string], InventoryRow>(
  `SELECT payload, fetched_at FROM inventory_cache WHERE steam_id = ?`,
);

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
 * the configured interval, so a frequent refresh does not bloat the table.
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

/** Records names as worth pricing, refreshing their last requested timestamp. */
export const trackItems = db.transaction((names: string[], now: number) => {
  for (const name of names) {
    trackItemStmt.run(name, now, now);
  }
});

export function selectDueItems(
  olderThan: number,
  maxFailures: number,
  limit: number,
): string[] {
  return selectDueStmt
    .all(maxFailures, olderThan, limit)
    .map((row) => row.name);
}

export function countDueItems(olderThan: number, maxFailures: number): number {
  return countDueStmt.get(maxFailures, olderThan)?.total ?? 0;
}

export function markLookupFailure(name: string): void {
  markFailureStmt.run(name);
}

export function markLookupSuccess(name: string): void {
  markSuccessStmt.run(name);
}

export function pruneTrackedItems(maxIdleMs: number): void {
  pruneTrackedStmt.run(Date.now() - maxIdleMs);
}

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

export function countTrackedItems(): number {
  return countTrackedStmt.get()?.total ?? 0;
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

/* ------------------------------------------------------------------------ *
 * Steam library and HowLongToBeat
 *
 * Same demand driven shape as the price cache above: games seen in a request
 * land in tracked_games, and the background cycle fills in hltb_games for the
 * oldest of them. Completion times belong to a game, not to a player, so one
 * lookup serves every user who owns that title.
 * ------------------------------------------------------------------------ */

export interface ProfileRecord {
  steamId: string;
  personaName: string;
  realName: string | null;
  avatarUrl: string;
  profileUrl: string;
  visibility: number;
  fetchedAt: number;
}

export interface HltbRecord {
  appId: number;
  hltbId: number | null;
  hltbName: string | null;
  /** All three are minutes, matching Steam's playtime_forever. */
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
  matched: boolean;
  updatedAt: number;
}

export interface TagRecord {
  appId: number;
  /** Steam tag IDs, most agreed-upon first. Names are resolved separately. */
  tagIds: number[];
  updatedAt: number;
}

interface TagRow {
  app_id: number;
  tag_ids: string;
  updated_at: number;
}

interface TagNameRow {
  tag_id: number;
  name: string;
}

interface ProfileRow {
  steam_id: string;
  persona_name: string;
  real_name: string | null;
  avatar_url: string;
  profile_url: string;
  visibility: number;
  fetched_at: number;
}

interface HltbRow {
  app_id: number;
  hltb_id: number | null;
  hltb_name: string | null;
  main_story: number | null;
  main_extra: number | null;
  completionist: number | null;
  matched: number;
  updated_at: number;
}

const selectProfileStmt = db.prepare<[string], ProfileRow>(
  `SELECT * FROM steam_profiles WHERE steam_id = ?`,
);

const upsertProfileStmt = db.prepare(`
  INSERT INTO steam_profiles
    (steam_id, persona_name, real_name, avatar_url, profile_url, visibility, fetched_at)
  VALUES (@steamId, @personaName, @realName, @avatarUrl, @profileUrl, @visibility, @fetchedAt)
  ON CONFLICT (steam_id) DO UPDATE SET
    persona_name = excluded.persona_name,
    real_name    = excluded.real_name,
    avatar_url   = excluded.avatar_url,
    profile_url  = excluded.profile_url,
    visibility   = excluded.visibility,
    fetched_at   = excluded.fetched_at
`);

const selectVanityStmt = db.prepare<
  [string],
  { steam_id: string | null; resolved_at: number }
>(`SELECT steam_id, resolved_at FROM vanity_resolutions WHERE vanity = ?`);

const upsertVanityStmt = db.prepare(
  `INSERT INTO vanity_resolutions (vanity, steam_id, resolved_at) VALUES (?, ?, ?)
   ON CONFLICT (vanity) DO UPDATE SET
     steam_id = excluded.steam_id, resolved_at = excluded.resolved_at`,
);

const selectLibraryStmt = db.prepare<[string], InventoryRow>(
  `SELECT payload, fetched_at FROM library_cache WHERE steam_id = ?`,
);

const upsertLibraryStmt = db.prepare(
  `INSERT INTO library_cache (steam_id, payload, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT (steam_id) DO UPDATE SET
     payload = excluded.payload, fetched_at = excluded.fetched_at`,
);

const pruneLibraryStmt = db.prepare(
  `DELETE FROM library_cache WHERE fetched_at < ?`,
);

const upsertHltbStmt = db.prepare(`
  INSERT INTO hltb_games
    (app_id, hltb_id, hltb_name, main_story, main_extra, completionist, matched, updated_at)
  VALUES (@appId, @hltbId, @hltbName, @mainStory, @mainExtra, @completionist, @matched, @updatedAt)
  ON CONFLICT (app_id) DO UPDATE SET
    hltb_id       = excluded.hltb_id,
    hltb_name     = excluded.hltb_name,
    main_story    = excluded.main_story,
    main_extra    = excluded.main_extra,
    completionist = excluded.completionist,
    matched       = excluded.matched,
    updated_at    = excluded.updated_at
`);

const upsertTagsStmt = db.prepare(`
  INSERT INTO steam_tags (app_id, tag_ids, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (app_id) DO UPDATE SET
    tag_ids    = excluded.tag_ids,
    updated_at = excluded.updated_at
`);

const selectTagNamesStmt = db.prepare<[string], TagNameRow>(
  `SELECT tag_id, name FROM steam_tag_names WHERE language = ?`,
);

const deleteTagNamesStmt = db.prepare(
  `DELETE FROM steam_tag_names WHERE language = ?`,
);

const insertTagNameStmt = db.prepare(
  `INSERT INTO steam_tag_names (tag_id, language, name) VALUES (?, ?, ?)`,
);

const trackGameStmt = db.prepare(`
  INSERT INTO tracked_games (app_id, name, first_seen, last_requested)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (app_id) DO UPDATE SET
    last_requested = excluded.last_requested,
    name           = excluded.name
`);

/**
 * Games whose completion times are missing or stale, oldest first. A matched
 * and an unmatched row age at different rates: real times barely change, while
 * a game HowLongToBeat did not know yet is worth another try sooner. Entries
 * that keep failing sink to the back and drop out past the failure limit.
 */
const selectDueGamesStmt = db.prepare<
  [number, number, number, number],
  { app_id: number; name: string }
>(`
  SELECT t.app_id, t.name
  FROM tracked_games t
  LEFT JOIN hltb_games h ON h.app_id = t.app_id
  WHERE t.failures < ?
    AND (h.app_id IS NULL
         OR (h.matched = 1 AND h.updated_at < ?)
         OR (h.matched = 0 AND h.updated_at < ?))
  ORDER BY t.failures ASC, COALESCE(h.updated_at, 0) ASC
  LIMIT ?
`);

const countDueGamesStmt = db.prepare<
  [number, number, number],
  { total: number }
>(`
  SELECT COUNT(*) AS total
  FROM tracked_games t
  LEFT JOIN hltb_games h ON h.app_id = t.app_id
  WHERE t.failures < ?
    AND (h.app_id IS NULL
         OR (h.matched = 1 AND h.updated_at < ?)
         OR (h.matched = 0 AND h.updated_at < ?))
`);

const markGameFailureStmt = db.prepare(
  `UPDATE tracked_games SET failures = failures + 1 WHERE app_id = ?`,
);

const markGameSuccessStmt = db.prepare(
  `UPDATE tracked_games SET failures = 0 WHERE app_id = ?`,
);

const pruneTrackedGamesStmt = db.prepare(
  `DELETE FROM tracked_games WHERE last_requested < ?`,
);

const countHltbStmt = db.prepare<[number], { total: number }>(
  `SELECT COUNT(*) AS total FROM hltb_games WHERE matched = ?`,
);

/** Chunked lookup for hltb_games, same reasoning as selectPricesStmt above. */
const selectHltbStmts = new Map<number, Database.Statement<number[], HltbRow>>();

function selectHltbStmt(size: number): Database.Statement<number[], HltbRow> {
  let statement = selectHltbStmts.get(size);
  if (!statement) {
    const placeholders = new Array<string>(size).fill("?").join(",");
    statement = db.prepare<number[], HltbRow>(
      `SELECT * FROM hltb_games WHERE app_id IN (${placeholders})`,
    );
    selectHltbStmts.set(size, statement);
  }
  return statement;
}

function toHltbRecord(row: HltbRow): HltbRecord {
  return {
    appId: row.app_id,
    hltbId: row.hltb_id,
    hltbName: row.hltb_name,
    mainStory: row.main_story,
    mainExtra: row.main_extra,
    completionist: row.completionist,
    matched: row.matched === 1,
    updatedAt: row.updated_at,
  };
}

export function getCachedProfile(steamId: string): ProfileRecord | undefined {
  const row = selectProfileStmt.get(steamId);
  if (!row) return undefined;
  return {
    steamId: row.steam_id,
    personaName: row.persona_name,
    realName: row.real_name,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
    visibility: row.visibility,
    fetchedAt: row.fetched_at,
  };
}

export function setCachedProfile(profile: ProfileRecord): void {
  upsertProfileStmt.run(profile);
}

/**
 * A resolution with a null steamId is a remembered "no such vanity name", so a
 * typo does not hit Steam again on every reload.
 */
export function getVanityResolution(
  vanity: string,
): { steamId: string | null; resolvedAt: number } | undefined {
  const row = selectVanityStmt.get(vanity);
  return row ? { steamId: row.steam_id, resolvedAt: row.resolved_at } : undefined;
}

export function setVanityResolution(
  vanity: string,
  steamId: string | null,
  resolvedAt: number,
): void {
  upsertVanityStmt.run(vanity, steamId, resolvedAt);
}

export function getCachedLibrary(
  steamId: string,
): { payload: string; fetchedAt: number } | undefined {
  const row = selectLibraryStmt.get(steamId);
  return row ? { payload: row.payload, fetchedAt: row.fetched_at } : undefined;
}

export function setCachedLibrary(
  steamId: string,
  payload: string,
  fetchedAt: number,
): void {
  upsertLibraryStmt.run(steamId, payload, fetchedAt);
}

export function pruneLibraryCache(maxAgeMs: number): void {
  pruneLibraryStmt.run(Date.now() - maxAgeMs);
}

/** Bulk lookup of completion times, chunked for SQLite's parameter limit. */
export function getHltbFor(appIds: number[]): Map<number, HltbRecord> {
  const result = new Map<number, HltbRecord>();
  const chunkSize = 400;
  for (let i = 0; i < appIds.length; i += chunkSize) {
    const chunk = appIds.slice(i, i + chunkSize);
    for (const row of selectHltbStmt(chunk.length).all(...chunk)) {
      result.set(row.app_id, toHltbRecord(row));
    }
  }
  return result;
}

/** Writes one game's result, matched or not. */
export function upsertHltb(record: Omit<HltbRecord, "updatedAt">, updatedAt: number): void {
  upsertHltbStmt.run({
    appId: record.appId,
    hltbId: record.hltbId,
    hltbName: record.hltbName,
    mainStory: record.mainStory,
    mainExtra: record.mainExtra,
    completionist: record.completionist,
    matched: record.matched ? 1 : 0,
    updatedAt,
  });
}

/** Chunked lookup for steam_tags, same reasoning as selectHltbStmt above. */
const selectTagsStmts = new Map<number, Database.Statement<number[], TagRow>>();

function selectTagsStmt(size: number): Database.Statement<number[], TagRow> {
  let statement = selectTagsStmts.get(size);
  if (!statement) {
    const placeholders = new Array<string>(size).fill("?").join(",");
    statement = db.prepare<number[], TagRow>(
      `SELECT * FROM steam_tags WHERE app_id IN (${placeholders})`,
    );
    selectTagsStmts.set(size, statement);
  }
  return statement;
}

/**
 * Reads cached tag IDs. A row whose JSON no longer parses is treated as absent
 * rather than thrown: tags are decoration, and a damaged row should cause a
 * refetch, not a failed library request.
 */
export function getTagsFor(appIds: number[]): Map<number, TagRecord> {
  const result = new Map<number, TagRecord>();
  const chunkSize = 400;
  for (let i = 0; i < appIds.length; i += chunkSize) {
    const chunk = appIds.slice(i, i + chunkSize);
    for (const row of selectTagsStmt(chunk.length).all(...chunk)) {
      let tagIds: number[];
      try {
        const parsed: unknown = JSON.parse(row.tag_ids);
        if (!Array.isArray(parsed)) continue;
        tagIds = parsed.filter(
          (value): value is number => typeof value === "number",
        );
      } catch {
        continue;
      }
      result.set(row.app_id, {
        appId: row.app_id,
        tagIds,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}

/** Writes a batch of tag lists. An empty list is a real answer and is stored. */
export const upsertTags = db.transaction(
  (records: Array<{ appId: number; tagIds: number[] }>, updatedAt: number) => {
    for (const record of records) {
      upsertTagsStmt.run(record.appId, JSON.stringify(record.tagIds), updatedAt);
    }
  },
);

export function getTagNames(language: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of selectTagNamesStmt.all(language)) {
    names.set(row.tag_id, row.name);
  }
  return names;
}

/**
 * Replaces the vocabulary for one language wholesale. Steam's list is the
 * authority, so merging would only keep tags it has retired.
 */
export const replaceTagNames = db.transaction(
  (language: string, names: ReadonlyMap<number, string>) => {
    deleteTagNamesStmt.run(language);
    for (const [tagId, name] of names) {
      insertTagNameStmt.run(tagId, language, name);
    }
  },
);

/** Records games as worth looking up, refreshing their last requested stamp. */
export const trackGames = db.transaction(
  (games: Array<{ appId: number; name: string }>, now: number) => {
    for (const game of games) {
      trackGameStmt.run(game.appId, game.name, now, now);
    }
  },
);

export function selectDueGames(
  maxFailures: number,
  matchedBefore: number,
  unmatchedBefore: number,
  limit: number,
): Array<{ appId: number; name: string }> {
  return selectDueGamesStmt
    .all(maxFailures, matchedBefore, unmatchedBefore, limit)
    .map((row) => ({ appId: row.app_id, name: row.name }));
}

export function countDueGames(
  maxFailures: number,
  matchedBefore: number,
  unmatchedBefore: number,
): number {
  return (
    countDueGamesStmt.get(maxFailures, matchedBefore, unmatchedBefore)?.total ?? 0
  );
}

export function markGameLookupFailure(appId: number): void {
  markGameFailureStmt.run(appId);
}

export function markGameLookupSuccess(appId: number): void {
  markGameSuccessStmt.run(appId);
}

export function pruneTrackedGames(maxIdleMs: number): void {
  pruneTrackedGamesStmt.run(Date.now() - maxIdleMs);
}

export function countHltbGames(matched: boolean): number {
  return countHltbStmt.get(matched ? 1 : 0)?.total ?? 0;
}
