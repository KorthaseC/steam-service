import { config } from "./../config.js";
import { createThrottledQueue } from "./../throttle.js";

/**
 * HowLongToBeat has no public API, so this talks to the same endpoints their
 * own web app uses. Verified against the live site; the flow is:
 *
 *   1. GET  /api/search/site/init?t=<ms>  ->  { token, hpKey, hpVal }
 *   2. POST /api/search/site              with headers x-auth-token, x-hp-key,
 *      x-hp-val, and the same hpKey/hpVal pair repeated as a field inside the
 *      JSON body. Sending it in only one of the two places is rejected.
 *   3. A 403 means the token expired: fetch a new one and retry once.
 *
 * The token is a base64 blob that encodes the caller's IP address and User
 * Agent, so the init call and the search that uses it have to present the same
 * User-Agent header. Changing it mid-session invalidates the token.
 *
 * This is scraping and it will break. Everything site specific lives in this
 * file, HLTB_ENABLED turns it off without a deploy, and a failure degrades to
 * "no completion times" rather than to a failed request for the whole library.
 */

const BASE_URL = "https://howlongtobeat.com";

const queue = createThrottledQueue({
  label: "hltb",
  delayMs: config.hltbDelayMs,
  // Longer than Steam's: this is an unofficial client on somebody else's site,
  // so backing off generously is the price of being allowed to keep asking.
  blockMs: 10 * 60_000,
});

/**
 * Browser identity for HowLongToBeat. Deliberately the same string the Steam
 * requests use: it is a plain current-Chrome user agent, and having one value
 * to rotate is easier than keeping two in sync with their client hints.
 */
function browserHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "User-Agent": config.steamUserAgent,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    ...extra,
  };
}

interface SearchToken {
  token: string;
  hpKey: string;
  hpVal: string;
  fetchedAt: number;
}

/** Cached across calls; a search token is good for many lookups. */
let cachedToken: SearchToken | undefined;

/**
 * Fetches a fresh search token. Kept separate from the search itself so that a
 * 403 can discard the old one and retry exactly once.
 */
async function fetchToken(): Promise<SearchToken | undefined> {
  const response = await fetch(
    `${BASE_URL}/api/search/site/init?t=${Date.now()}`,
    {
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: browserHeaders(),
    },
  );

  if (response.status === 429) {
    queue.block();
    return undefined;
  }
  if (!response.ok) return undefined;

  const data = (await response.json()) as Partial<SearchToken> | null;
  if (!data?.token || !data.hpKey || !data.hpVal) return undefined;

  return {
    token: data.token,
    hpKey: data.hpKey,
    hpVal: data.hpVal,
    fetchedAt: Date.now(),
  };
}

async function getToken(
  forceRefresh = false,
): Promise<SearchToken | undefined> {
  const maxAgeMs = config.hltbTokenTtlMinutes * 60_000;
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() - cachedToken.fetchedAt < maxAgeMs
  ) {
    return cachedToken;
  }
  cachedToken = await fetchToken();
  return cachedToken;
}

/** One entry as the search endpoint returns it. Times are seconds. */
interface SearchResult {
  game_id?: number;
  game_name?: string;
  game_alias?: string;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
}

interface SearchResponse {
  count?: number;
  data?: SearchResult[];
}

function buildSearchBody(
  terms: string[],
  token: SearchToken,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    searchType: "games",
    searchTerms: terms,
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: "",
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: null, max: null },
        gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
        year: "",
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  // The honeypot pair has to appear in the body as well as in the headers.
  body[token.hpKey] = token.hpVal;
  return body;
}

async function search(
  terms: string[],
  retry = true,
): Promise<SearchResult[] | undefined> {
  const token = await getToken();
  if (!token) return undefined;

  const response = await fetch(`${BASE_URL}/api/search/site`, {
    method: "POST",
    signal: AbortSignal.timeout(config.outboundTimeoutMs),
    headers: browserHeaders({
      "Content-Type": "application/json",
      "x-auth-token": token.token,
      "x-hp-key": token.hpKey,
      "x-hp-val": token.hpVal,
    }),
    body: JSON.stringify(buildSearchBody(terms, token)),
  });

  if (response.status === 403 && retry) {
    // Exactly what their own client does when the token goes stale.
    cachedToken = undefined;
    await getToken(true);
    return search(terms, false);
  }
  if (response.status === 429) {
    queue.block();
    return undefined;
  }
  if (!response.ok) return undefined;

  const data = (await response.json()) as SearchResponse | null;
  return Array.isArray(data?.data) ? data.data : undefined;
}

/**
 * Reads the Steam AppID off a game's detail page.
 *
 * The search response does not carry profile_steam, but the detail page embeds
 * the full record in its __NEXT_DATA__ blob, and that page needs no token. This
 * is what turns a plausible name match into a certain one.
 */
async function fetchSteamAppId(hltbId: number): Promise<number | undefined> {
  const response = await fetch(`${BASE_URL}/game/${hltbId}`, {
    signal: AbortSignal.timeout(config.outboundTimeoutMs),
    headers: browserHeaders({ Accept: "text/html" }),
  });

  if (response.status === 429) {
    queue.block();
    return undefined;
  }
  if (!response.ok) return undefined;

  const html = await response.text();
  const block =
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!block?.[1]) return undefined;

  try {
    const parsed = JSON.parse(block[1]) as {
      props?: { pageProps?: { game?: { data?: { game?: unknown } } } };
    };
    const games = parsed.props?.pageProps?.game?.data?.game;
    const first = Array.isArray(games) ? games[0] : games;
    const appId = Number(
      (first as { profile_steam?: unknown } | undefined)?.profile_steam,
    );
    return Number.isInteger(appId) && appId > 0 ? appId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduces a title to comparable words: accents folded, trademark symbols and
 * punctuation dropped, "&" spelled out. Deliberately conservative - it must not
 * merge two genuinely different games.
 */
export function normaliseTitle(name: string): string {
  return (
    name
      // Stripped before NFKD, which would otherwise expand these into the
      // letters TM, SM and C and turn "PAYDAY(tm) 2" into "paydaytm 2".
      .replace(/[\u2122\u2120\u00ae\u00a9]/g, " ")
      .normalize("NFKD")
      // NFKD splits an accented letter into base plus combining mark.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

/**
 * Second chance normalisation that also removes edition and re-release wording,
 * which Steam puts in a title and HowLongToBeat usually does not. Applied only
 * after an exact comparison failed, because "Remastered" can be a separate
 * entry with genuinely different completion times.
 */
export function stripEdition(normalised: string): string {
  return normalised
    .replace(
      /\b(goty|game of the year|definitive|deluxe|enhanced|complete|ultimate|gold|premium|anniversary|remaster|remastered|special|extended|collectors|collector s|standard)\b/g,
      " ",
    )
    .replace(/\b(edition|version)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Seconds to whole minutes; HowLongToBeat uses 0 to mean "no data". */
function toMinutes(seconds: number | undefined): number | null {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return null;
  return Math.round(seconds / 60);
}

export interface HltbMatch {
  hltbId: number;
  hltbName: string;
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
}

/**
 * Tri-state on purpose. "unmatched" is a real answer worth caching so a
 * multiplayer title is not searched forever; "failed" means we never got to ask
 * and the game should be retried.
 */
export type HltbLookup =
  | { status: "matched"; match: HltbMatch }
  | { status: "unmatched" }
  | { status: "failed" };

function toMatch(result: SearchResult): HltbMatch | undefined {
  const hltbId = Number(result.game_id);
  if (!Number.isInteger(hltbId) || hltbId <= 0) return undefined;
  return {
    hltbId,
    hltbName: result.game_name ?? "",
    mainStory: toMinutes(result.comp_main),
    mainExtra: toMinutes(result.comp_plus),
    completionist: toMinutes(result.comp_100),
  };
}

/**
 * Finds the completion times for one Steam game.
 *
 * Matching runs cheapest first, because every step costs another request to
 * somebody else's server:
 *   1. an exact normalised name match, on the title or on HLTB's alias field
 *   2. the same comparison with edition wording removed
 *   3. only if the name is still ambiguous, confirm the top candidates against
 *      their Steam AppID, which is authoritative
 *
 * In practice the great majority of a library resolves at step one for a single
 * request per game.
 */
export async function matchGame(
  appId: number,
  name: string,
): Promise<HltbLookup> {
  if (!config.hltbEnabled) return { status: "failed" };

  const terms = normaliseTitle(name).split(" ").filter(Boolean);
  if (terms.length === 0) return { status: "unmatched" };

  const results = await queue.run(() => search(terms));
  if (results === undefined) return { status: "failed" };
  if (results.length === 0) return { status: "unmatched" };

  const target = normaliseTitle(name);

  for (const result of results) {
    const candidates = [result.game_name, result.game_alias]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
      .map(normaliseTitle);
    if (candidates.includes(target)) {
      const match = toMatch(result);
      if (match) return { status: "matched", match };
    }
  }

  const strippedTarget = stripEdition(target);
  if (strippedTarget.length > 0) {
    for (const result of results) {
      const candidates = [result.game_name, result.game_alias]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .map((value) => stripEdition(normaliseTitle(value)));
      if (candidates.includes(strippedTarget)) {
        const match = toMatch(result);
        if (match) return { status: "matched", match };
      }
    }
  }

  // Ambiguous: ask the detail pages who they actually are. Capped at two, so a
  // library full of unmatchable titles cannot triple the request volume.
  for (const result of results.slice(0, 2)) {
    const match = toMatch(result);
    if (!match) continue;

    const confirmed = await queue.run(() => fetchSteamAppId(match.hltbId));
    if (confirmed === appId) return { status: "matched", match };
  }

  return { status: "unmatched" };
}

export function isHltbBlocked(): boolean {
  return queue.isBlocked();
}
