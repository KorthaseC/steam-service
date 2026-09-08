import { config } from "./../config.js";
import { SteamApiError } from "./steamWebApi.js";

/**
 * Steam's store browse API, used for the user tags a game carries on its store
 * page ("Metroidvania", "Soulslike", "Open World").
 *
 * This is a different animal from the completion times. HowLongToBeat needs one
 * throttled request per game and takes roughly 25 minutes for a large library;
 * this endpoint answers 200 AppIDs in about half a second, so a whole library
 * is three requests. Nothing here needs a worker, a queue or polling.
 *
 * Two caveats that shaped the code below:
 *
 * - **It is undocumented.** This is the API the store front-end calls, not a
 *   published Web API, and it needs no key. It can change without notice, so a
 *   failure here must never take the library down with it - the caller treats
 *   tags as a garnish, and `steamLibrary.ts` swallows errors accordingly.
 * - **GET only, and the URL is the limit.** POST is refused with 405, and the
 *   request is a JSON blob in a query parameter, so the cap is URL length
 *   rather than a documented item count: 240 AppIDs still answer, 300 come back
 *   414 URI Too Long. The default batch of 200 leaves comfortable headroom.
 */

const STORE_API_BASE = "https://api.steampowered.com";

/** Measured ceiling is just over 240 AppIDs; the default stays well below it. */
export const MAX_BATCH = 240;

export interface StoreTagList {
  /** Steam's own hash of the tag vocabulary, so a refresh can be a no-op. */
  versionHash: string;
  names: Map<number, string>;
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
async function callStore<T>(path: string, params: Record<string, string>): Promise<T> {
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
 * Reads the tag IDs out of a store items response.
 *
 * Delisted and region locked apps come back with `success` other than 1 and no
 * tags; they are simply absent from the result, which the caller records so it
 * does not ask again on the next page load.
 */
export function parseStoreItems(payload: unknown): Map<number, number[]> {
  const result = new Map<number, number[]>();
  const items = (payload as StoreItemsResponse)?.response?.store_items;
  if (!Array.isArray(items)) return result;

  for (const item of items) {
    const appId = Number(item.appid ?? item.id);
    if (!Number.isInteger(appId) || appId <= 0) continue;

    const tagIds = item.tagids;
    if (!Array.isArray(tagIds)) continue;

    const ids: number[] = [];
    for (const raw of tagIds) {
      const id = Number(raw);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }

    // An empty list is a real answer - the app exists and carries no tags - so
    // it is recorded rather than skipped, which stops it being refetched.
    result.set(appId, ids);
  }

  return result;
}

/**
 * Fetches the tag IDs for one batch of AppIDs. Order within a game's list is
 * Steam's own, most agreed-upon tag first, and is preserved throughout.
 */
export async function fetchTagIds(appIds: number[]): Promise<Map<number, number[]>> {
  if (appIds.length === 0) return new Map();

  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: {
      language: config.storeTagLanguage,
      country_code: config.storeTagCountry,
    },
    data_request: { include_tag_count: config.storeTagsPerGame },
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
