import { config } from "./../config.js";

/**
 * Steam's official Web API, used for everything the community site cannot give
 * us anonymously: resolving a vanity name, reading a profile, and listing the
 * games somebody owns.
 *
 * This does not reuse steamHeaders.ts. Those headers exist to make requests to
 * steamcommunity.com look like a browser on that same site, complete with a
 * matching Referer and Sec-Fetch-Site: same-origin. api.steampowered.com is a
 * key authenticated API that expects an ordinary client, and sending browser
 * headers with a same-origin hint to a different host is exactly the kind of
 * inconsistency that gets a caller refused.
 *
 * The API key is a secret and never appears in a log line or an error message.
 */

const API_BASE = "https://api.steampowered.com";

/** communityvisibilitystate 3 is the only value that means "public". */
const VISIBILITY_PUBLIC = 3;

export type SteamApiErrorCode =
  | "feature_disabled"
  | "vanity_not_found"
  | "profile_not_found"
  | "profile_private"
  | "library_unavailable"
  | "game_not_in_library"
  | "steam_rate_limited"
  | "steam_unavailable";

export class SteamApiError extends Error {
  constructor(
    public readonly code: SteamApiErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SteamApiError";
  }
}

export interface PlayerSummary {
  steamId: string;
  personaName: string;
  realName: string | null;
  avatarUrl: string;
  profileUrl: string;
  visibility: number;
}

export interface OwnedGame {
  appId: number;
  name: string;
  /** Minutes, as Steam reports them. */
  playtimeMinutes: number;
  /** Unix seconds, or null when Steam has never recorded a session. */
  lastPlayed: number | null;
  /**
   * Hash naming the game's square community icon, or null when Steam sends
   * none. Optional because libraries cached before it was read lack it.
   */
  iconHash?: string | null;
}

export function isSteamApiConfigured(): boolean {
  return config.steamApiKey.length > 0;
}

function requireKey(): string {
  if (!config.steamApiKey) {
    throw new SteamApiError(
      "feature_disabled",
      "STEAM_API_KEY is not configured, so Steam library features are disabled",
      503,
    );
  }
  return config.steamApiKey;
}

/**
 * One place for every outbound Web API call. Builds the URL from a parameter
 * map so the key is never interpolated into a string by a caller, and maps
 * transport failures onto the typed error above.
 */
async function callApi<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set("key", requireKey());
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
      `Could not reach the Steam Web API: ${(error as Error).message}`,
      502,
    );
  }

  if (response.status === 429) {
    throw new SteamApiError(
      "steam_rate_limited",
      "The Steam Web API is rate limiting this key",
      429,
    );
  }
  if (response.status === 401 || response.status === 403) {
    // Deliberately vague: the caller must not learn whether the key is wrong.
    throw new SteamApiError(
      "steam_unavailable",
      "The Steam Web API rejected the request; check STEAM_API_KEY",
      502,
    );
  }
  if (!response.ok) {
    throw new SteamApiError(
      "steam_unavailable",
      `The Steam Web API returned status ${response.status}`,
      502,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new SteamApiError(
      "steam_unavailable",
      `The Steam Web API returned unreadable JSON: ${(error as Error).message}`,
      502,
    );
  }
}

interface ResolveResponse {
  response?: { steamid?: string; success?: number };
}

/**
 * Turns a vanity name into a SteamID64. Returns null when Steam knows no such
 * name, which the caller caches so a typo is not retried on every reload.
 */
export async function resolveVanity(vanity: string): Promise<string | null> {
  const data = await callApi<ResolveResponse>(
    "ISteamUser/ResolveVanityURL/v1/",
    { vanityurl: vanity },
  );
  // success is 1 for a hit and 42 for "no match"; treat anything else as a miss.
  const steamId = data.response?.steamid;
  if (data.response?.success !== 1 || !steamId) return null;
  return steamId;
}

interface SummariesResponse {
  response?: {
    players?: Array<{
      steamid?: string;
      personaname?: string;
      realname?: string;
      avatarfull?: string;
      profileurl?: string;
      communityvisibilitystate?: number;
    }>;
  };
}

export async function getPlayerSummary(
  steamId: string,
): Promise<PlayerSummary> {
  const data = await callApi<SummariesResponse>(
    "ISteamUser/GetPlayerSummaries/v2/",
    { steamids: steamId },
  );

  const player = data.response?.players?.[0];
  if (!player?.steamid) {
    throw new SteamApiError(
      "profile_not_found",
      "Steam knows no account with this ID",
      404,
    );
  }

  return {
    steamId: player.steamid,
    personaName: player.personaname ?? "",
    // Steam omits realname entirely when it is unset or hidden.
    realName: player.realname?.trim() ? player.realname : null,
    avatarUrl: player.avatarfull ?? "",
    profileUrl:
      player.profileurl ?? `https://steamcommunity.com/profiles/${steamId}`,
    visibility: player.communityvisibilitystate ?? 0,
  };
}

export function isProfilePublic(summary: PlayerSummary): boolean {
  return summary.visibility === VISIBILITY_PUBLIC;
}

interface OwnedGamesResponse {
  response?: { game_count?: number; games?: Array<Record<string, unknown>> };
}

/**
 * Lists the games on an account.
 *
 * Steam answers a request for hidden game details with 200 and an empty
 * response object rather than an error, so an absent games array is treated as
 * "game details are private" - a distinct case from a private profile, and a
 * common one, because the game details toggle is separate in Steam's settings.
 */
export async function getOwnedGames(steamId: string): Promise<OwnedGame[]> {
  const data = await callApi<OwnedGamesResponse>(
    "IPlayerService/GetOwnedGames/v1/",
    {
      steamid: steamId,
      include_appinfo: "1",
      include_played_free_games: "1",
    },
  );

  const games = data.response?.games;
  if (!Array.isArray(games)) {
    throw new SteamApiError(
      "library_unavailable",
      "This account keeps its game details private",
      403,
    );
  }

  const result: OwnedGame[] = [];
  for (const raw of games) {
    const appId = Number(raw.appid);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    // A game with no appid or no name is unusable downstream: the appid keys
    // the HowLongToBeat cache and the name is what gets searched.
    if (!Number.isInteger(appId) || appId <= 0 || !name) continue;

    const playtime = Number(raw.playtime_forever);
    const lastPlayed = Number(raw.rtime_last_played);
    // Only a plain SHA-1 hex string is accepted: the value becomes part of an
    // image URL, so anything else is dropped rather than interpolated.
    const iconHash =
      typeof raw.img_icon_url === "string" &&
      /^[0-9a-f]{40}$/i.test(raw.img_icon_url)
        ? raw.img_icon_url.toLowerCase()
        : null;

    result.push({
      appId,
      name,
      playtimeMinutes: Number.isFinite(playtime) && playtime > 0 ? playtime : 0,
      lastPlayed:
        Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : null,
      iconHash,
    });
  }

  return result;
}
