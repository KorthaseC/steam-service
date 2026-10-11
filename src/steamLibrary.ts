import { config } from "./config.js";
import {
  getCachedLibrary,
  getCachedProfile,
  getHiddenGames,
  getHltbFor,
  getVanityResolution,
  hideGame,
  setCachedLibrary,
  setCachedProfile,
  setVanityResolution,
  trackGames,
  unhideAllGames,
  unhideGame,
} from "./db.js";
import { kickHltbWorker } from "./hltb.js";
import { RefreshCooldown } from "./refreshCooldown.js";
import { isHltbBlocked } from "./sources/howLongToBeat.js";
import {
  getOwnedGames,
  getPlayerSummary,
  isProfilePublic,
  isSteamApiConfigured,
  resolveVanity,
  SteamApiError,
  type OwnedGame,
} from "./sources/steamWebApi.js";
import type { SteamRef } from "./steamRef.js";
import { storeDetailsFor } from "./storeDetails.js";

/**
 * Puts a Steam profile, its library and the cached HowLongToBeat times into the
 * one payload the frontend renders.
 *
 * Completion times are never fetched during a request. A library of several
 * hundred games would take far longer than any reasonable timeout to look up,
 * so games the cache does not know are returned as null, recorded as worth
 * looking up, and filled in by the background worker. The frontend polls the
 * companion endpoint until nothing is pending.
 *
 * Games the caller has hidden are taken out before any of that happens. They
 * are not tracked for completion times, not looked up in the store, and not
 * counted in the progress figures, so a hidden game can never be the reason
 * somebody is still waiting for the progress bar. They come back separately
 * in `hidden`, enough to offer them for restoring.
 */

export interface LibraryGame {
  appId: number;
  name: string;
  /**
   * The capsule image. The store's own path when the store lookup delivered
   * one, otherwise a URL derived from the AppID, which works for older store
   * art only. Never empty - but not guaranteed to load, see `iconUrl`.
   */
  capsuleUrl: string;
  /**
   * The square community icon, for a frontend whose capsule failed to load.
   * Null when Steam sends no icon for the game.
   */
  iconUrl: string | null;
  playtimeMinutes: number;
  /** ISO timestamp, or null when Steam has never recorded a session. */
  lastPlayed: string | null;
  /** null means "not looked up yet", which the UI shows as a skeleton. */
  hltb: GameTimes | null;
  /**
   * Steam store tags, most agreed-upon first, already resolved to display
   * names in the configured language. Empty when Steam knows none for this
   * game or the lookup was unavailable - see `tags` on the response for which.
   */
  tags: string[];
  /**
   * The store's review summary. Null when the store has none for this game -
   * never reviewed, delisted - or the lookup was unavailable; the `tags`
   * coverage on the response tells those apart, since both come from the
   * same call.
   */
  reviews: GameReviews | null;
}

/** A game the caller has hidden from this library. */
export interface HiddenGame {
  appId: number;
  name: string;
  /** ISO timestamp of when it was first hidden. */
  hiddenAt: string;
}

export interface GameReviews {
  /**
   * Steam's EUserReviewScore: 1 overwhelmingly negative, 5 mixed, 9
   * overwhelmingly positive, 0 when there are too few reviews for a verdict.
   */
  score: number;
  /** 0-100, or null when Steam reports no percentage. */
  percentPositive: number | null;
  count: number;
}

export interface GameTimes {
  /** Minutes, like playtimeMinutes. Null when HowLongToBeat has no figure. */
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
  /** False means HowLongToBeat was searched and knows no such game. */
  matched: boolean;
}

/**
 * How much of the library has its store details settled - tags, reviews and
 * capsule path, which all come from one call. Unlike the completion times this
 * is not progress to poll on - it arrives with the response - it exists so the
 * UI can tell "this game has no tags" from "the store could not be asked".
 */
export interface TagCoverage {
  total: number;
  known: number;
}

export interface HltbProgress {
  total: number;
  resolved: number;
  pending: number;
  unmatched: number;
  /** True while HowLongToBeat is refusing requests, so progress has stalled. */
  blocked: boolean;
}

export interface LibraryResponse {
  profile: {
    steamId64: string;
    personaName: string;
    realName: string | null;
    avatarUrl: string;
    profileUrl: string;
    rawInput: string;
  };
  /** Visible games only; hidden ones are listed in `hidden`. */
  games: LibraryGame[];
  /** What this caller has hidden here, most recently hidden first. */
  hidden: HiddenGame[];
  hltb: HltbProgress;
  tags: TagCoverage;
  meta: {
    libraryFetchedAt: string;
    fromCache: boolean;
    /**
     * Seconds until a `?refresh=1` for this SteamID goes to Steam again, 0
     * when a forced refresh is available right now. A refresh requested
     * sooner is answered from the cache instead.
     *
     * Relative rather than a timestamp on purpose: the client compares it
     * against its own clock, and a browser whose clock is a few minutes off
     * would otherwise lock or unlock its refresh control at the wrong time.
     */
    refreshAvailableInSeconds: number;
  };
}

function requireFeature(): void {
  if (!isSteamApiConfigured()) {
    throw new SteamApiError(
      "feature_disabled",
      "STEAM_API_KEY is not configured, so Steam library features are disabled",
      503,
    );
  }
}

/**
 * Turns a parsed reference into a SteamID64. Vanity resolutions are cached in
 * both directions: a hit avoids a lookup, and a remembered miss stops a typo
 * from hitting Steam on every reload.
 */
export async function resolveSteamId(ref: SteamRef): Promise<string> {
  requireFeature();
  if (ref.kind === "steamid64") return ref.value;

  const maxAgeMs = config.vanityCacheHours * 60 * 60 * 1000;
  const cached = getVanityResolution(ref.value);
  if (cached && Date.now() - cached.resolvedAt < maxAgeMs) {
    if (cached.steamId) return cached.steamId;
    throw new SteamApiError(
      "vanity_not_found",
      `Steam knows no profile named "${ref.value}"`,
      404,
    );
  }

  const steamId = await resolveVanity(ref.value);
  setVanityResolution(ref.value, steamId, Date.now());

  if (!steamId) {
    throw new SteamApiError(
      "vanity_not_found",
      `Steam knows no profile named "${ref.value}"`,
      404,
    );
  }
  return steamId;
}

/**
 * Reads a profile, serving the cache while it is fresh.
 *
 * Public and private profiles are cached for very different lengths of time.
 * A public profile barely changes, so it is kept for `profileCacheMinutes`. A
 * private one is kept only for `privateProfileCacheSeconds`: the typical next
 * step after seeing "this profile is private" is to change the setting and
 * try again, and a long negative cache would refuse that retry for up to an
 * hour without ever asking Steam.
 *
 * `forceRefresh` skips the cache entirely. The caller is responsible for
 * rationing it; see `RefreshCooldown`.
 */
async function loadProfile(
  steamId: string,
  forceRefresh: boolean,
): Promise<{
  personaName: string;
  realName: string | null;
  avatarUrl: string;
  profileUrl: string;
}> {
  if (!forceRefresh) {
    const cached = getCachedProfile(steamId);
    if (cached) {
      const ageMs = Date.now() - cached.fetchedAt;

      if (isProfilePublic(cached)) {
        if (ageMs < config.profileCacheMinutes * 60_000) return cached;
      } else if (
        ageMs <
        Math.max(0, config.privateProfileCacheSeconds) * 1000
      ) {
        throw new SteamApiError(
          "profile_private",
          "This Steam profile is private",
          403,
        );
      }
    }
  }

  const summary = await getPlayerSummary(steamId);
  setCachedProfile({ ...summary, fetchedAt: Date.now() });

  if (!isProfilePublic(summary)) {
    throw new SteamApiError(
      "profile_private",
      "This Steam profile is private",
      403,
    );
  }
  return summary;
}

/**
 * Reads the owned games, serving a cached snapshot while it is fresh. A damaged
 * cache row must not turn into a 500, so it is discarded and refetched - the
 * same defensive parse getInventory uses.
 */
async function loadGames(
  steamId: string,
  forceRefresh: boolean,
): Promise<{ games: OwnedGame[]; fetchedAt: number; fromCache: boolean }> {
  const maxAgeMs = config.libraryCacheMinutes * 60_000;

  if (!forceRefresh) {
    const cached = getCachedLibrary(steamId);
    if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
      try {
        const parsed: unknown = JSON.parse(cached.payload);
        if (Array.isArray(parsed)) {
          return {
            games: parsed as OwnedGame[],
            fetchedAt: cached.fetchedAt,
            fromCache: true,
          };
        }
      } catch {
        console.warn(
          `[library] discarding unreadable cache entry for ${steamId}`,
        );
      }
    }
  }

  const games = await getOwnedGames(steamId);
  const fetchedAt = Date.now();
  setCachedLibrary(steamId, JSON.stringify(games), fetchedAt);
  return { games, fetchedAt, fromCache: false };
}

/**
 * Rations forced refreshes per SteamID. The cooldown is read from the config on
 * every call rather than captured once, so tests and a changed environment see
 * the current value.
 */
const forcedRefreshes = new RefreshCooldown(
  () => Math.max(0, config.libraryRefreshCooldownSeconds) * 1000,
);

/**
 * Prefers the path the store reported, which carries the content hash newer
 * store art lives under. Falls back to the AppID-derived URL, which older art
 * still answers to.
 */
function capsuleUrl(appId: number, capsulePath: string | null): string {
  if (capsulePath) return `${config.storeAssetBase}/${capsulePath}`;
  return `${config.steamCapsuleBase}/${appId}/capsule_231x87.jpg`;
}

function iconUrl(
  appId: number,
  iconHash: string | null | undefined,
): string | null {
  if (!iconHash) return null;
  return `${config.steamCommunityIconBase}/${appId}/${iconHash}.jpg`;
}

function toTimes(record: {
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
  matched: boolean;
}): GameTimes {
  return {
    mainStory: record.mainStory,
    mainExtra: record.mainExtra,
    completionist: record.completionist,
    matched: record.matched,
  };
}

function progressOf(
  appIds: number[],
  known: Map<number, { matched: boolean }>,
): HltbProgress {
  let resolved = 0;
  let unmatched = 0;
  for (const appId of appIds) {
    const record = known.get(appId);
    if (!record) continue;
    if (record.matched) resolved++;
    else unmatched++;
  }
  return {
    total: appIds.length,
    resolved,
    unmatched,
    pending: appIds.length - resolved - unmatched,
    blocked: isHltbBlocked(),
  };
}

/**
 * Builds the full library payload and registers every game for completion time
 * lookup. Sorted by playtime so the response is stable and the most played
 * titles are visible before the frontend applies its own sorting.
 *
 * `requestRefresh` asks for the profile and the owned games to be read from
 * Steam rather than the cache - for somebody who has just changed a privacy
 * setting, or whose playtimes were hidden when the library was cached. It is
 * honoured at most once per `libraryRefreshCooldownSeconds` per SteamID; a
 * request inside that window is answered from the cache as usual, which the
 * response shows through `fromCache` and `refreshAvailableInSeconds`.
 */
export async function loadLibrary(
  ref: SteamRef,
  rawInput: string,
  owner: string,
  requestRefresh = false,
): Promise<LibraryResponse> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  const forceRefresh = requestRefresh && forcedRefreshes.claim(steamId);

  const profile = await loadProfile(steamId, forceRefresh);
  const loaded = await loadGames(steamId, forceRefresh);
  const { fetchedAt, fromCache } = loaded;

  const hiddenRecords = getHiddenGames(owner, steamId);
  const games = withoutHidden(loaded.games, hiddenRecords);

  // Everything anybody looks at becomes worth keeping current, which is the
  // same demand driven rule the price cache follows.
  if (games.length > 0) {
    trackGames(
      games.map((game) => ({ appId: game.appId, name: game.name })),
      Date.now(),
    );
  }

  const appIds = games.map((game) => game.appId);
  const known = getHltbFor(appIds);

  // Store details come back with this response rather than through the
  // polling companion: a batch of 200 answers in about half a second, so even
  // a large library is a couple of requests. The call never rejects - a store
  // outage costs tags, ratings and exact images, not the library.
  const store = await storeDetailsFor(appIds);

  const entries: LibraryGame[] = games
    .map((game) => {
      const record = known.get(game.appId);
      const details = store.details.get(game.appId);
      return {
        appId: game.appId,
        name: game.name,
        capsuleUrl: capsuleUrl(game.appId, details?.capsulePath ?? null),
        iconUrl: iconUrl(game.appId, game.iconHash),
        playtimeMinutes: game.playtimeMinutes,
        lastPlayed: game.lastPlayed
          ? new Date(game.lastPlayed * 1000).toISOString()
          : null,
        hltb: record ? toTimes(record) : null,
        tags: details?.tags ?? [],
        reviews: details?.reviews ? { ...details.reviews } : null,
      };
    })
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);

  const hltb = progressOf(appIds, known);
  // Do not wait for the next tick when there is visible work to do.
  if (hltb.pending > 0) kickHltbWorker();

  return {
    profile: {
      steamId64: steamId,
      personaName: profile.personaName,
      realName: profile.realName,
      avatarUrl: profile.avatarUrl,
      profileUrl: profile.profileUrl,
      rawInput,
    },
    games: entries,
    hidden: toHiddenGames(hiddenRecords),
    hltb,
    tags: { total: appIds.length, known: store.known },
    meta: {
      libraryFetchedAt: new Date(fetchedAt).toISOString(),
      fromCache,
      refreshAvailableInSeconds: Math.max(
        0,
        Math.ceil((forcedRefreshes.availableAt(steamId) - Date.now()) / 1000),
      ),
    },
  };
}

/**
 * The polling companion to loadLibrary: the completion times only, keyed by
 * AppID. Reads the cached library rather than Steam, so a frontend polling
 * every few seconds costs nothing but a local query.
 */
export async function loadHltbProgress(
  ref: SteamRef,
  owner: string,
): Promise<{
  hltb: HltbProgress;
  entries: Record<string, GameTimes>;
}> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  const loaded = await loadGames(steamId, false);
  // Same exclusion as the library itself, or the progress figures polled
  // here would disagree with the ones the page was first rendered with.
  const games = withoutHidden(loaded.games, getHiddenGames(owner, steamId));

  const appIds = games.map((game) => game.appId);
  const known = getHltbFor(appIds);

  const entries: Record<string, GameTimes> = {};
  for (const appId of appIds) {
    const record = known.get(appId);
    if (record) entries[String(appId)] = toTimes(record);
  }

  return { hltb: progressOf(appIds, known), entries };
}

/* ---------------------------------------------------------------------- *
 * Hidden games
 * ---------------------------------------------------------------------- */

function withoutHidden(
  games: OwnedGame[],
  hidden: ReadonlyArray<{ appId: number }>,
): OwnedGame[] {
  if (hidden.length === 0) return games;
  const hiddenIds = new Set(hidden.map((game) => game.appId));
  return games.filter((game) => !hiddenIds.has(game.appId));
}

function toHiddenGames(
  records: ReadonlyArray<{ appId: number; name: string; hiddenAt: number }>,
): HiddenGame[] {
  return records.map((record) => ({
    appId: record.appId,
    name: record.name,
    hiddenAt: new Date(record.hiddenAt).toISOString(),
  }));
}

/**
 * Hides one game from this caller's view of a library.
 *
 * The game has to be in the library. That keeps the table from collecting
 * AppIDs somebody typed by hand, and it is where the stored name comes from -
 * the server's copy, not whatever a client chose to send. Reading the library
 * normally costs nothing: whoever presses "hide" has just loaded it, so it is
 * in the cache.
 */
export async function hideLibraryGame(
  ref: SteamRef,
  owner: string,
  appId: number,
): Promise<HiddenGame[]> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  const { games } = await loadGames(steamId, false);

  const game = games.find((candidate) => candidate.appId === appId);
  if (!game) {
    throw new SteamApiError(
      "game_not_in_library",
      "This game is not part of the library",
      404,
    );
  }

  hideGame(owner, steamId, appId, game.name, Date.now());
  return toHiddenGames(getHiddenGames(owner, steamId));
}

/**
 * Shows a hidden game again. Needs no library read: removing a row that does
 * not exist is simply a no-op, so an already restored game is not an error.
 */
export async function unhideLibraryGame(
  ref: SteamRef,
  owner: string,
  appId: number,
): Promise<HiddenGame[]> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  unhideGame(owner, steamId, appId);
  return toHiddenGames(getHiddenGames(owner, steamId));
}

/** Shows every game this caller has hidden in this library again. */
export async function unhideAllLibraryGames(
  ref: SteamRef,
  owner: string,
): Promise<HiddenGame[]> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  unhideAllGames(owner, steamId);
  return [];
}
