import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

/**
 * Central configuration. Every value comes from the environment so that no
 * secret ever lives in the repository. Invalid or missing critical values make
 * the process exit at startup instead of failing later at request time.
 */

function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable ${name}`);
    }
    return fallback;
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Parses "key:label,key:label" into a lookup from key to a human readable
 * label. The label identifies a key in the log and is its rate limit bucket,
 * so it has to be unique per entry.
 */
function parseGuestKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    const key = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const label = separator === -1 ? "unnamed" : trimmed.slice(separator + 1);
    if (key.length < 24) {
      throw new Error(
        `Guest key "${label}" is shorter than 24 characters and would be brute forceable`,
      );
    }
    keys.set(key, label || "unnamed");
  }
  return keys;
}

/**
 * Same shape as parseGuestKeys, but for the codes a person types into the web
 * frontend. Twelve characters instead of twenty four because these are meant to
 * be readable and typed by hand; the login endpoint carries its own strict rate
 * limit to make up for the smaller search space. See the security section of
 * the README before lowering this further.
 */
function parseAccessCodes(raw: string): Map<string, string> {
  const codes = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    const code = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const label = separator === -1 ? "unnamed" : trimmed.slice(separator + 1);
    if (code.length < 12) {
      throw new Error(
        `Access code "${label}" is shorter than 12 characters and would be guessable`,
      );
    }
    codes.set(code, label || "unnamed");
  }
  return codes;
}

const dataDir = path.resolve(str("DATA_DIR", "./data"));
fs.mkdirSync(dataDir, { recursive: true });

const adminKey = str("ADMIN_KEY");
if (adminKey.length < 32) {
  throw new Error(
    "ADMIN_KEY must be at least 32 characters (openssl rand -hex 32)",
  );
}

const currency = str("CURRENCY", "EUR").toUpperCase();
if (currency !== "EUR" && currency !== "USD") {
  throw new Error("CURRENCY must be either EUR or USD");
}

/**
 * The Steam library and HowLongToBeat features are optional: without a Web API
 * key the routes answer 503 and everything else keeps working. That way an
 * existing deployment still starts after an update without new configuration.
 */
const steamApiKey = str("STEAM_API_KEY", "");

const accessCodes = parseAccessCodes(str("ACCESS_CODES", ""));
const sessionSecret = str("SESSION_SECRET", "");
// Codes without a secret would hand out cookies nobody can verify, so this
// combination is a configuration error rather than a disabled feature.
if (accessCodes.size > 0 && sessionSecret.length < 32) {
  throw new Error(
    "ACCESS_CODES requires SESSION_SECRET with at least 32 characters (openssl rand -hex 32)",
  );
}

export const config = {
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 8087),
  trustProxyHops: num("TRUST_PROXY_HOPS", 1),

  adminKey,
  guestKeys: parseGuestKeys(str("GUEST_KEYS", "")),

  accessCodes,
  sessionSecret,
  sessionTtlDays: num("SESSION_TTL_DAYS", 30),
  cookieName: str("COOKIE_NAME", "sxo_session"),
  /** Only ever false for local development over plain http. */
  cookieSecure: bool("COOKIE_SECURE", true),

  dataDir,
  dbPath: path.join(dataDir, "prices.sqlite"),

  currency: currency as "EUR" | "USD",

  /** How often the background refresh cycle runs. */
  priceRefreshMinutes: num("PRICE_REFRESH_MINUTES", 60),
  /** A price older than this is queued for refresh and reported as stale. */
  priceMaxAgeHours: num("PRICE_MAX_AGE_HOURS", 12),
  /** Upper bound on lookups per refresh cycle, so one cycle stays bounded. */
  refreshBatchSize: num("PRICE_REFRESH_BATCH", 150),
  /** A name that fails this often in a row is dropped from the refresh queue. */
  maxLookupFailures: num("MAX_LOOKUP_FAILURES", 5),
  /** Names nobody has asked about for this long are forgotten. */
  trackedRetentionDays: num("TRACKED_RETENTION_DAYS", 30),

  historyIntervalHours: num("HISTORY_INTERVAL_HOURS", 24),
  enableHistory: bool("ENABLE_HISTORY", true),
  steamFeeDivisor: num("STEAM_FEE_DIVISOR", 1.15),

  steamFallbackEnabled: bool("STEAM_FALLBACK_ENABLED", true),
  steamFallbackDelayMs: num("STEAM_FALLBACK_DELAY_MS", 4000),
  steamFallbackMaxPerRequest: num("STEAM_FALLBACK_MAX_PER_REQUEST", 15),

  inventoryCacheMinutes: num("INVENTORY_CACHE_MINUTES", 10),
  /**
   * Items per inventory page. Steam scales its rate limit with this value and
   * rejects large pages outright for anonymous callers, so this stays close to
   * what the community site itself requests.
   */
  inventoryPageSize: num("INVENTORY_PAGE_SIZE", 75),
  /** Safety limit on pagination: page size times this is the item ceiling. */
  inventoryMaxPages: num("INVENTORY_MAX_PAGES", 40),
  /** Pause between inventory pages, so paging does not look like a burst. */
  inventoryPageDelayMs: num("INVENTORY_PAGE_DELAY_MS", 2000),

  /**
   * Applied before authentication, so wrong keys and the open health endpoint
   * are bounded too. Must stay above the per key limits, otherwise a legitimate
   * client behind a single address hits this one first.
   */
  ipRateWindowMs: num("IP_RATE_WINDOW_MINUTES", 10) * 60_000,
  ipRateMax: num("IP_RATE_MAX", 300),

  guestRateWindowMs: num("GUEST_RATE_WINDOW_MINUTES", 10) * 60_000,
  guestRateMax: num("GUEST_RATE_MAX", 20),
  adminRateWindowMs: num("ADMIN_RATE_WINDOW_MINUTES", 10) * 60_000,
  adminRateMax: num("ADMIN_RATE_MAX", 200),

  /**
   * The login endpoint is the one place where a short secret is guessed against,
   * so it gets a far tighter budget than the rest, keyed on the client address.
   */
  loginRateWindowMs: num("LOGIN_RATE_WINDOW_MINUTES", 15) * 60_000,
  loginRateMax: num("LOGIN_RATE_MAX", 10),

  /** Sessions get their own budget: browsing a library is many small requests. */
  sessionRateWindowMs: num("SESSION_RATE_WINDOW_MINUTES", 10) * 60_000,
  sessionRateMax: num("SESSION_RATE_MAX", 120),

  /** Shared by every outbound HTTP call so a hanging peer cannot stall a request. */
  outboundTimeoutMs: 30_000,

  /**
   * Steam answers 429 to clients it does not recognise, so requests present a
   * consistent browser identity (see steamHeaders.ts). Both values belong
   * together: the client hint has to name the same major version as the user
   * agent, otherwise the pair looks forged. Bump them when Steam starts
   * refusing this combination.
   */
  steamUserAgent: str(
    "STEAM_USER_AGENT",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  ),
  steamSecChUa: str(
    "STEAM_SEC_CH_UA",
    '"Chromium";v="124", "Google Chrome";v="124"',
  ),

  // --- Steam library -----------------------------------------------------
  steamApiKey,
  /** A library changes far less often than a price, so it is cached longer. */
  libraryCacheMinutes: num("LIBRARY_CACHE_MINUTES", 60),
  profileCacheMinutes: num("PROFILE_CACHE_MINUTES", 60),
  vanityCacheHours: num("VANITY_CACHE_HOURS", 24),
  /**
   * Capsule images come straight from Steam's CDN. Kept configurable because
   * Steam has moved this host twice and a broken image is otherwise a redeploy.
   */
  steamCapsuleBase: str(
    "STEAM_CAPSULE_BASE",
    "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps",
  ),

  // --- HowLongToBeat -----------------------------------------------------
  /** Emergency switch, for when HowLongToBeat closes the door on scraping. */
  hltbEnabled: bool("HLTB_ENABLED", true),
  hltbWorkerIntervalMinutes: num("HLTB_WORKER_INTERVAL_MINUTES", 2),
  /** Lookups per cycle. Batch times delay should stay under the interval. */
  hltbBatchSize: num("HLTB_BATCH_SIZE", 40),
  hltbDelayMs: num("HLTB_DELAY_MS", 3000),
  /** Completion times are effectively static, so they are refreshed rarely. */
  hltbMaxAgeDays: num("HLTB_MAX_AGE_DAYS", 90),
  /** A game with no match is retried eventually, in case it gets added later. */
  hltbUnmatchedRetryDays: num("HLTB_UNMATCHED_RETRY_DAYS", 30),
  /** How long a discovered search token is reused before being fetched again. */
  hltbTokenTtlMinutes: num("HLTB_TOKEN_TTL_MINUTES", 30),
} as const;
