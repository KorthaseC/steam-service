/**
 * Parses whatever a user typed into either a SteamID64 or a vanity name.
 *
 * The frontend parses the same input to build its URLs, but the server never
 * trusts that: the value ends up in an outbound request to Steam, so it is
 * re-validated here. Anything that does not match one of the known shapes is
 * rejected rather than passed along, which keeps caller controlled text out of
 * the URL entirely - the same rule normaliseSteamId follows in steamInventory.
 *
 * Pure and dependency free so it can be unit tested without any I/O.
 */

/** SteamID64 for individual accounts always starts with 7656119 and has 17 digits. */
const STEAM_ID_PATTERN = /^7656119\d{10}$/;

/**
 * Steam requires a vanity name of 3 to 32 characters. Two is accepted here so
 * that a legacy short name still resolves; Steam decides the real answer.
 */
const VANITY_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

export interface SteamRef {
  kind: "steamid64" | "vanity";
  /** The SteamID64, or the vanity name lowercased for use as a cache key. */
  value: string;
}

/**
 * Pulls the meaningful segment out of a steamcommunity.com URL. Returns
 * undefined for any other host, so a link to somewhere else is never followed.
 */
function fromUrl(input: string): SteamRef | null | undefined {
  let url: URL;
  try {
    // A bare "steamcommunity.com/id/x" has no scheme; give it one to parse.
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return undefined;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "steamcommunity.com" && host !== "steamcommunity.com.") {
    return undefined;
  }

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const [kind, value] = segments;
  if (!value) return null;

  if (kind === "profiles") {
    return STEAM_ID_PATTERN.test(value) ? { kind: "steamid64", value } : null;
  }
  if (kind === "id") {
    // decodeURIComponent can throw on a malformed escape such as "%zz".
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    return VANITY_PATTERN.test(decoded)
      ? { kind: "vanity", value: decoded.toLowerCase() }
      : null;
  }
  return null;
}

/**
 * Returns null for anything unusable, so the caller decides the error shape.
 * Accepts a SteamID64, a profile or id URL with or without scheme, and a bare
 * vanity name.
 */
export function parseSteamRef(input: unknown): SteamRef | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;

  if (STEAM_ID_PATTERN.test(trimmed)) {
    return { kind: "steamid64", value: trimmed };
  }

  // Only treat it as a URL when it looks like one, so that a vanity name
  // containing no slash or dot never takes the URL path.
  if (trimmed.includes("/") || trimmed.includes(".") || trimmed.includes(":")) {
    const fromLink = fromUrl(trimmed);
    // undefined means "not a steamcommunity URL"; null means "unusable one".
    return fromLink === undefined ? null : fromLink;
  }

  if (VANITY_PATTERN.test(trimmed)) {
    return { kind: "vanity", value: trimmed.toLowerCase() };
  }

  return null;
}
