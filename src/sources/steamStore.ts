import { config } from "./../config.js";
import { SteamApiError } from "./steamWebApi.js";

/**
 * Steam's store browse API, used for what a game's store page shows beyond its
 * name: the user tags ("Metroidvania", "Soulslike"), the review summary
 * ("Very Positive, 94 %") and the paths of its capsule images.
 *
 * All three come from one call per batch. That matters, because this is a
 * different animal from the completion times: HowLongToBeat needs one
 * throttled request per game and takes roughly 25 minutes for a large library,
 * while this endpoint answers 200 AppIDs in about half a second, so a whole
 * library is three requests. Nothing here needs a worker, a queue or polling.
 *
 * Caveats that shaped the code below:
 *
 * - **It is undocumented.** This is the API the store front-end calls, not a
 *   published Web API, and it needs no key. It can change without notice, so a
 *   failure here must never take the library down with it - the caller treats
 *   everything from here as a garnish, and `storeDetails.ts` swallows errors
 *   accordingly.
 * - **GET only, and the URL is the limit.** POST is refused with 405, and the
 *   request is a JSON blob in a query parameter, so the cap is URL length
 *   rather than a documented item count: 240 AppIDs still answer, 300 come back
 *   414 URI Too Long. The default batch of 200 leaves comfortable headroom.
 * - **Image paths are not derivable.** Newer store art lives under a content
 *   hash, `steam/apps/<appid>/<hash>/capsule_231x87.jpg`, so the old habit of
 *   building `steam/apps/<appid>/capsule_231x87.jpg` from the AppID alone
 *   returns a 404 for those games. The real path only comes from here.
 */

const STORE_API_BASE = "https://api.steampowered.com";

/** Measured ceiling is just over 240 AppIDs; the default stays well below it. */
export const MAX_BATCH = 240;

/** Steam's EUserReviewScore runs from 1 (overwhelmingly negative) to 9. */
const MAX_REVIEW_SCORE = 9;

export interface StoreTagList {
  /** Steam's own hash of the tag vocabulary, so a refresh can be a no-op. */
  versionHash: string;
  names: Map<number, string>;
}

/**
 * A game's review summary, as the store page shows it.
 *
 * `score` is Steam's EUserReviewScore: 1 overwhelmingly negative, 5 mixed, 9
 * overwhelmingly positive, and 0 when there are too few reviews for a verdict.
 * Kept as the number rather than Steam's label, so the frontend can word it in
 * its own language regardless of what the store API was asked for.
 */
export interface StoreReviewSummary {
  score: number;
  /** 0-100, or null when Steam does not report one. */
  percentPositive: number | null;
  count: number;
}

/** Everything read from one store item. */
export interface StoreItemDetails {
  /** Tag IDs in Steam's agreement order. */
  tagIds: number[];
  reviews: StoreReviewSummary | null;
  /**
   * The capsule image, relative to the store asset host, including Steam's
   * cache-busting query - e.g. `steam/apps/620/<hash>/capsule_231x87.jpg?t=1`.
   * Stored relative so a move of the asset host is a configuration change
   * rather than a refetch of every game.
   */
  capsulePath: string | null;
}

/**
 * Splits AppIDs into request sized batches.
 *
 * Exported for the tests: the batch size is the one number here that turns a
 * working request into a 414, and it is worth pinning down.
 */
export function chunkAppIds(appIds: number[], size: number): number[][] {
  const limit = Math.max(1, Math.min(Math.floor(size), MAX_BATCH));
  const batches: number[][] = [];
  for (let i = 0; i < appIds.length; i += limit) {
    batches.push(appIds.slice(i, i + limit));
  }
  return batches;
}

/** One place for the two GET calls, so the failure mapping is written once. */
async function callStore<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${STORE_API_BASE}/${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: {
        "User-Agent": config.steamUserAgent,
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new SteamApiError(
      "steam_unavailable",
      `Could not reach the Steam store API: ${(error as Error).message}`,
      502,
    );
  }

  if (response.status === 429) {
    throw new SteamApiError(
      "steam_rate_limited",
      "The Steam store API is rate limiting this address",
      429,
    );
  }
  // 414 means the batch outgrew the URL. Worth its own message, because the
  // fix is a configuration change rather than a retry.
  if (response.status === 414) {
    throw new SteamApiError(
      "steam_unavailable",
      "The Steam store API refused the request as too long; lower STORE_TAG_BATCH_SIZE",
      502,
    );
  }
  if (!response.ok) {
    throw new SteamApiError(
      "steam_unavailable",
      `The Steam store API returned status ${response.status}`,
      502,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new SteamApiError(
      "steam_unavailable",
      `The Steam store API returned unreadable JSON: ${(error as Error).message}`,
      502,
    );
  }
}

interface StoreItemsResponse {
  response?: { store_items?: Array<Record<string, unknown>> };
}

/**
 * Reads tags, reviews and the capsule path out of a store items response.
 *
 * An item counts as answered when Steam reports success or sends any of the
 * three parts. Delisted and region locked apps come back with neither; they
 * are simply absent from the result, which the caller records so it does not
 * ask again on the next page load.
 */
export function parseStoreItems(
  payload: unknown,
): Map<number, StoreItemDetails> {
  const result = new Map<number, StoreItemDetails>();
  const items = (payload as StoreItemsResponse)?.response?.store_items;
  if (!Array.isArray(items)) return result;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const appId = Number(item.appid ?? item.id);
    if (!Number.isInteger(appId) || appId <= 0) continue;

    const rawTagIds = item.tagids;
    const reviews = parseReviews(item.reviews);
    const capsulePath = pickCapsulePath(item.assets);

    const answered =
      item.success === 1 ||
      Array.isArray(rawTagIds) ||
      reviews !== null ||
      capsulePath !== null;
    if (!answered) continue;

    const tagIds: number[] = [];
    if (Array.isArray(rawTagIds)) {
      for (const raw of rawTagIds) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0) tagIds.push(id);
      }
    }

    // An empty tag list is a real answer - the app exists and carries no tags -
    // so it is recorded rather than skipped, which stops it being refetched.
    result.set(appId, { tagIds, reviews, capsulePath });
  }

  return result;
}

/**
 * Reads a review summary. Steam's filtered summary is the one the store page
 * shows - it leaves out review bombs flagged as off-topic - so it is preferred,
 * with the unfiltered one as a fallback.
 */
export function parseReviews(raw: unknown): StoreReviewSummary | null {
  if (!raw || typeof raw !== "object") return null;

  const container = raw as Record<string, unknown>;
  const summary = [
    container.summary_filtered,
    container.summary_unfiltered,
  ].find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === "object",
  );
  if (!summary) return null;

  const score = Number(summary.review_score);
  const percent = Number(summary.percent_positive);
  const count = Number(summary.review_count);

  return {
    score:
      Number.isInteger(score) && score >= 0 && score <= MAX_REVIEW_SCORE
        ? score
        : 0,
    percentPositive:
      summary.percent_positive !== undefined &&
      Number.isFinite(percent) &&
      percent >= 0 &&
      percent <= 100
        ? Math.round(percent)
        : null,
    count: Number.isInteger(count) && count > 0 ? count : 0,
  };
}

/**
 * Chooses the capsule image for a list row.
 *
 * The small capsule is the one this app has always shown and the lightest to
 * load; the header and the main capsule are the same artwork in other crops,
 * for the games that do not ship a small one.
 */
function pickCapsulePath(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const assets = raw as Record<string, unknown>;
  for (const filename of [
    assets.small_capsule,
    assets.header,
    assets.main_capsule,
  ]) {
    const path = resolveAssetPath(assets.asset_url_format, filename);
    if (path) return path;
  }
  return null;
}

/** A relative directory prefix such as `steam/apps/620/`. */
const ASSET_PREFIX = /^(?:[A-Za-z0-9_-]+\/)+$/;
/** A plain filename, optionally below a hash directory. */
const ASSET_FILENAME =
  /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/i;
/** Nothing, or Steam's cache-busting query such as `?t=1751503462`. */
const ASSET_QUERY = /^(?:\?[A-Za-z0-9_=&.-]*)?$/;

/**
 * Fills Steam's `asset_url_format` - `steam/apps/620/${FILENAME}?t=123` - with
 * one filename, producing a path relative to the store asset host.
 *
 * Deliberately strict. The result ends up in an `<img src>` on somebody's
 * screen, so anything that is not plainly a relative image path - a scheme, a
 * `..`, an unexpected character - is refused rather than passed on, and the
 * caller falls back to its derived URL.
 */
export function resolveAssetPath(
  format: unknown,
  filename: unknown,
): string | null {
  if (typeof format !== "string" || typeof filename !== "string") return null;

  const marker = "${FILENAME}";
  const at = format.indexOf(marker);
  if (at === -1 || format.indexOf(marker, at + marker.length) !== -1)
    return null;

  const prefix = format.slice(0, at);
  const query = format.slice(at + marker.length);

  if (!ASSET_PREFIX.test(prefix) || !ASSET_QUERY.test(query)) return null;
  if (!ASSET_FILENAME.test(filename)) return null;

  return `${prefix}${filename}${query}`;
}

/**
 * Fetches tags, reviews and capsule paths for one batch of AppIDs. Tag order
 * within a game's list is Steam's own, most agreed-upon first, and is
 * preserved throughout.
 */
export async function fetchStoreItems(
  appIds: number[],
): Promise<Map<number, StoreItemDetails>> {
  if (appIds.length === 0) return new Map();

  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: {
      language: config.storeTagLanguage,
      country_code: config.storeTagCountry,
    },
    data_request: {
      include_tag_count: config.storeTagsPerGame,
      include_reviews: true,
      include_assets: true,
    },
  };

  const payload = await callStore<unknown>("IStoreBrowseService/GetItems/v1/", {
    input_json: JSON.stringify(input),
  });

  return parseStoreItems(payload);
}

interface TagListResponse {
  response?: {
    version_hash?: string;
    tags?: Array<{ tagid?: unknown; name?: unknown }>;
  };
}

export function parseTagList(payload: unknown): StoreTagList {
  const response = (payload as TagListResponse)?.response;
  const names = new Map<number, string>();

  for (const tag of response?.tags ?? []) {
    const id = Number(tag.tagid);
    const name = typeof tag.name === "string" ? tag.name.trim() : "";
    if (!Number.isInteger(id) || id <= 0 || !name) continue;
    names.set(id, name);
  }

  return { versionHash: String(response?.version_hash ?? ""), names };
}

/**
 * The whole tag vocabulary in one request - around 450 entries and 16 kB.
 * Localised, so the cache is keyed by language.
 */
export async function fetchTagList(): Promise<StoreTagList> {
  const payload = await callStore<unknown>("IStoreService/GetTagList/v1/", {
    language: config.storeTagLanguage,
  });

  const list = parseTagList(payload);
  if (list.names.size === 0) {
    throw new SteamApiError(
      "steam_unavailable",
      "The Steam store API returned an empty tag list",
      502,
    );
  }
  return list;
}

/**
 * Turns stored tag IDs into display names, dropping any the vocabulary does not
 * know. A tag can be created after the list was cached, and showing "#4521" to
 * a reader is worse than showing one tag fewer.
 */
export function resolveTagNames(
  tagIds: readonly number[],
  names: ReadonlyMap<number, string>,
): string[] {
  const resolved: string[] = [];
  for (const id of tagIds) {
    const name = names.get(id);
    if (name) resolved.push(name);
  }
  return resolved;
}
