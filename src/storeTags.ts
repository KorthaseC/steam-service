import { config } from "./config.js";
import {
  getMeta,
  getTagNames,
  getTagsFor,
  replaceTagNames,
  setMeta,
  upsertTags,
} from "./db.js";
import {
  chunkAppIds,
  fetchTagIds,
  fetchTagList,
  resolveTagNames,
} from "./sources/steamStore.js";

/**
 * Keeps store tags for a library current, and turns them into display names.
 *
 * The governing rule is that tags are a garnish. Every path in here is allowed
 * to give up quietly: an undocumented endpoint that starts refusing must cost
 * the reader their tag filter, never their library. Nothing in this module
 * throws, and `tagsFor` returns whatever it managed to assemble.
 *
 * Unlike the completion times there is no worker and no polling. A batch of 200
 * AppIDs answers in about half a second, so even a very large library fills
 * inside one request; the budget below exists only so a slow day at Steam
 * cannot hold a page open.
 */

const LIST_FETCHED_KEY = `store_tag_list_fetched_at:${config.storeTagLanguage}`;
const LIST_HASH_KEY = `store_tag_list_hash:${config.storeTagLanguage}`;

export interface TagFill {
  /** AppID to display names, most agreed-upon tag first. */
  tags: Map<number, string[]>;
  /** Games whose tags are known, for the summary the frontend renders. */
  known: number;
}

/** In-process copy, so a library request does not re-read 450 rows every time. */
let cachedNames: Map<number, string> | null = null;

function namesAreStale(): boolean {
  const fetchedAt = Number(getMeta(LIST_FETCHED_KEY) ?? 0);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  return Date.now() - fetchedAt > config.storeTagListMaxAgeDays * 86_400_000;
}

/**
 * The tag vocabulary, fetched at most once per `storeTagListMaxAgeDays`.
 *
 * A failed refresh falls back to whatever is already stored: month old tag
 * names are still correct for almost every game, and refusing to show any tag
 * because the vocabulary could not be refreshed would be a poor trade.
 */
async function ensureTagNames(): Promise<Map<number, string>> {
  if (cachedNames && !namesAreStale()) return cachedNames;

  const stored = getTagNames(config.storeTagLanguage);
  if (stored.size > 0 && !namesAreStale()) {
    cachedNames = stored;
    return stored;
  }

  try {
    const list = await fetchTagList();

    // Steam hands out a hash of the vocabulary. When it has not moved, the
    // stored rows are already right and only the freshness stamp needs
    // touching. The size check matters: a hash recorded against rows that have
    // since been lost would otherwise short-circuit the write forever, and the
    // list would be refetched on every restart without ever being persisted.
    if (
      stored.size > 0 &&
      list.versionHash &&
      list.versionHash === getMeta(LIST_HASH_KEY)
    ) {
      setMeta(LIST_FETCHED_KEY, String(Date.now()));
      cachedNames = stored;
      return stored;
    }

    replaceTagNames(config.storeTagLanguage, list.names);
    setMeta(LIST_FETCHED_KEY, String(Date.now()));
    setMeta(LIST_HASH_KEY, list.versionHash);
    cachedNames = list.names;
    return list.names;
  } catch (error) {
    console.warn(`[tags] tag list refresh failed: ${(error as Error).message}`);
    cachedNames = stored;
    return stored;
  }
}

/**
 * Assembles tags for a set of games, fetching the ones that are missing or
 * stale within the wall clock budget.
 */
export async function tagsFor(appIds: number[]): Promise<TagFill> {
  const tags = new Map<number, string[]>();
  if (!config.storeTagsEnabled || appIds.length === 0) {
    return { tags, known: 0 };
  }

  const names = await ensureTagNames();
  const cached = getTagsFor(appIds);
  const maxAgeMs = config.storeTagMaxAgeDays * 86_400_000;
  const now = Date.now();

  const missing: number[] = [];
  for (const appId of appIds) {
    const record = cached.get(appId);
    if (!record) {
      missing.push(appId);
      continue;
    }
    tags.set(appId, resolveTagNames(record.tagIds, names));
    if (now - record.updatedAt > maxAgeMs) missing.push(appId);
  }

  if (missing.length > 0) {
    await fillMissing(missing, tags, names);
  }

  // A game can legitimately carry no tags, so "known" counts entries present
  // rather than entries that are non-empty.
  return { tags, known: tags.size };
}

/**
 * Fetches the batches that are missing, sequentially and under a deadline.
 *
 * Sequential on purpose: this is an undocumented endpoint and a library is at
 * most a handful of requests, so there is nothing to gain from opening several
 * at once and a rate limit to lose. The first failure ends the fill - if Steam
 * is refusing, the next batch will be refused too.
 */
async function fillMissing(
  missing: number[],
  tags: Map<number, string[]>,
  names: ReadonlyMap<number, string>,
): Promise<void> {
  const deadline = Date.now() + config.storeTagBudgetMs;
  const batches = chunkAppIds(missing, config.storeTagBatchSize);

  for (const batch of batches) {
    if (Date.now() > deadline) {
      console.warn(
        `[tags] budget spent with ${batches.length} batches planned; the rest fill on the next load`,
      );
      break;
    }

    let fetched: Map<number, number[]>;
    try {
      fetched = await fetchTagIds(batch);
    } catch (error) {
      console.warn(`[tags] lookup failed: ${(error as Error).message}`);
      break;
    }

    const records: Array<{ appId: number; tagIds: number[] }> = [];
    for (const [appId, tagIds] of fetched) {
      records.push({ appId, tagIds });
      tags.set(appId, resolveTagNames(tagIds, names));
    }

    // Apps Steam did not answer for - delisted, region locked - are recorded
    // with no tags so the next load does not ask about them again.
    for (const appId of batch) {
      if (!fetched.has(appId)) {
        records.push({ appId, tagIds: [] });
        tags.set(appId, []);
      }
    }

    if (records.length > 0) upsertTags(records, Date.now());
  }
}
