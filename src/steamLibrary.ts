import { config } from "./config.js";
import {
  getCachedLibrary,
  getCachedProfile,
  getHltbFor,
  getVanityResolution,
  setCachedLibrary,
  setCachedProfile,
  setVanityResolution,
  trackGames,
} from "./db.js";
import { kickHltbWorker } from "./hltb.js";
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

/**
 * Puts a Steam profile, its library and the cached HowLongToBeat times into the
 * one payload the frontend renders.
 *
 * Completion times are never fetched during a request. A library of several
 * hundred games would take far longer than any reasonable timeout to look up,
 * so games the cache does not know are returned as null, recorded as worth
 * looking up, and filled in by the background worker. The frontend polls the
 * companion endpoint until nothing is pending.
 */

export interface LibraryGame {
  appId: number;
  name: string;
  capsuleUrl: string;
  playtimeMinutes: number;
  /** ISO timestamp, or null when Steam has never recorded a session. */
  lastPlayed: string | null;
  /** null means "not looked up yet", which the UI shows as a skeleton. */
  hltb: GameTimes | null;
}

export interface GameTimes {
  /** Minutes, like playtimeMinutes. Null when HowLongToBeat has no figure. */
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
  /** False means HowLongToBeat was searched and knows no such game. */
  matched: boolean;
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
  games: LibraryGame[];
  hltb: HltbProgress;
  meta: { libraryFetchedAt: string; fromCache: boolean };
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

async function loadProfile(steamId: string): Promise<{
  personaName: string;
  realName: string | null;
  avatarUrl: string;
  profileUrl: string;
}> {
  const maxAgeMs = config.profileCacheMinutes * 60_000;
  const cached = getCachedProfile(steamId);
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    // A cached private profile still has to be refused.
    if (cached.visibility !== 3) {
      throw new SteamApiError(
        "profile_private",
        "This Steam profile is private",
        403,
      );
    }
    return cached;
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

function capsuleUrl(appId: number): string {
  return `${config.steamCapsuleBase}/${appId}/capsule_231x87.jpg`;
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
 */
export async function loadLibrary(
  ref: SteamRef,
  rawInput: string,
  forceRefresh = false,
): Promise<LibraryResponse> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  const profile = await loadProfile(steamId);
  const { games, fetchedAt, fromCache } = await loadGames(
    steamId,
    forceRefresh,
  );

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

  const entries: LibraryGame[] = games
    .map((game) => {
      const record = known.get(game.appId);
      return {
        appId: game.appId,
        name: game.name,
        capsuleUrl: capsuleUrl(game.appId),
        playtimeMinutes: game.playtimeMinutes,
        lastPlayed: game.lastPlayed
          ? new Date(game.lastPlayed * 1000).toISOString()
          : null,
        hltb: record ? toTimes(record) : null,
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
    hltb,
    meta: {
      libraryFetchedAt: new Date(fetchedAt).toISOString(),
      fromCache,
    },
  };
}

/**
 * The polling companion to loadLibrary: the completion times only, keyed by
 * AppID. Reads the cached library rather than Steam, so a frontend polling
 * every few seconds costs nothing but a local query.
 */
export async function loadHltbProgress(ref: SteamRef): Promise<{
  hltb: HltbProgress;
  entries: Record<string, GameTimes>;
}> {
  requireFeature();

  const steamId = await resolveSteamId(ref);
  const { games } = await loadGames(steamId, false);

  const appIds = games.map((game) => game.appId);
  const known = getHltbFor(appIds);

  const entries: Record<string, GameTimes> = {};
  for (const appId of appIds) {
    const record = known.get(appId);
    if (record) entries[String(appId)] = toTimes(record);
  }

  return { hltb: progressOf(appIds, known), entries };
}
