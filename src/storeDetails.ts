import { config } from "./config.js";
import {
  getMeta,
  getStoreDetailsFor,
  getTagNames,
  replaceTagNames,
  setMeta,
  upsertStoreDetails,
} from "./db.js";
import {
  chunkAppIds,
  fetchStoreItems,
  fetchTagList,
  resolveTagNames,
  type StoreItemDetails,
  type StoreReviewSummary,
} from "./sources/steamStore.js";

/**
 * Keeps a library's store details current: tags as display names, the review
 * summary, and the path of each game's capsule image.
 *
 * The governing rule is that all of it is a garnish. Every path in here is
 * allowed to give up quietly: an undocumented endpoint that starts refusing
 * must cost the reader their tag filter, ratings and exact images, never their
 * library. Nothing in this module throws, and `storeDetailsFor` returns
 * whatever it managed to assemble.
 *
 * Unlike the completion times there is no worker and no polling. A batch of 200
 * AppIDs answers in about half a second, so even a very large library fills
 * inside one request; the budget below exists only so a slow day at Steam
 * cannot hold a page open.
 */

const LIST_FETCHED_KEY = `store_tag_list_fetched_at:${config.storeTagLanguage}`;
const LIST_HASH_KEY = `store_tag_list_hash:${config.storeTagLanguage}`;

/** What the library payload needs for one game. */
export interface GameStoreDetails {
  /** Display names, most agreed-upon tag first. */
  tags: string[];
  reviews: StoreReviewSummary | null;
  /** Relative to the store asset host; null when the store sent none. */
  capsulePath: string | null;
}

export interface StoreDetailsFill {
  /** Only games whose details are known; absent means "could not be loaded". */
  details: Map<number, GameStoreDetails>;
  /** Games whose details are known, for the summary the frontend renders. */
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
 * A record is refreshed at the shorter of the two lifetimes. Tags and reviews
 * come from the same call, so there is nothing to gain from ageing them
 * separately - and a batch of 200 is cheap enough that refreshing tags a little
 * more often than they need is not worth a second code path.
 */
function detailsMaxAgeMs(): number {
  const days = Math.min(
    config.storeTagMaxAgeDays,
    config.storeReviewMaxAgeDays,
  );
  return Math.max(0, days) * 86_400_000;
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
    console.warn(
      `[store] tag list refresh failed: ${(error as Error).message}`,
    );
    cachedNames = stored;
    return stored;
  }
}

/**
 * Assembles store details for a set of games, fetching the ones that are
 * missing or stale within the wall clock budget. A stale record is still used
 * until its replacement arrives.
 */
export async function storeDetailsFor(
  appIds: number[],
): Promise<StoreDetailsFill> {
  const details = new Map<number, GameStoreDetails>();
  if (!config.storeTagsEnabled || appIds.length === 0) {
    return { details, known: 0 };
  }

  const names = await ensureTagNames();
  const cached = getStoreDetailsFor(appIds);
  const maxAgeMs = detailsMaxAgeMs();
  const now = Date.now();

  const missing: number[] = [];
  for (const appId of appIds) {
    const record = cached.get(appId);
    if (!record) {
      missing.push(appId);
      continue;
    }
    details.set(appId, toGameDetails(record, names));
    if (now - record.updatedAt > maxAgeMs) missing.push(appId);
  }

  if (missing.length > 0) {
    await fillMissing(missing, details, names);
  }

  // A game can legitimately carry no tags and no reviews, so "known" counts
  // entries present rather than entries that have content.
  return { details, known: details.size };
}

function toGameDetails(
  record: Pick<StoreItemDetails, "tagIds" | "reviews" | "capsulePath">,
  names: ReadonlyMap<number, string>,
): GameStoreDetails {
  return {
    tags: resolveTagNames(record.tagIds, names),
    reviews: record.reviews,
    capsulePath: record.capsulePath,
  };
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
  details: Map<number, GameStoreDetails>,
  names: ReadonlyMap<number, string>,
): Promise<void> {
  const deadline = Date.now() + config.storeTagBudgetMs;
  const batches = chunkAppIds(missing, config.storeTagBatchSize);

  for (const batch of batches) {
    if (Date.now() > deadline) {
      console.warn(
        `[store] budget spent with ${batches.length} batches planned; the rest fill on the next load`,
      );
      break;
    }

    let fetched: Map<number, StoreItemDetails>;
    try {
      fetched = await fetchStoreItems(batch);
    } catch (error) {
      console.warn(`[store] lookup failed: ${(error as Error).message}`);
      break;
    }

    const records: Array<{ appId: number } & StoreItemDetails> = [];
    for (const [appId, item] of fetched) {
      records.push({ appId, ...item });
      details.set(appId, toGameDetails(item, names));
    }

    // Apps Steam did not answer for - delisted, region locked - are recorded
    // empty so the next load does not ask about them again.
    for (const appId of batch) {
      if (!fetched.has(appId)) {
        const empty: StoreItemDetails = {
          tagIds: [],
          reviews: null,
          capsulePath: null,
        };
        records.push({ appId, ...empty });
        details.set(appId, toGameDetails(empty, names));
      }
    }

    if (records.length > 0) upsertStoreDetails(records, Date.now());
  }
}
