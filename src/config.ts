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

export const config = {
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 8087),
  trustProxyHops: num("TRUST_PROXY_HOPS", 1),

  adminKey,
  guestKeys: parseGuestKeys(str("GUEST_KEYS", "")),

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
  inventoryMaxPages: num("INVENTORY_MAX_PAGES", 5),

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

  /** Shared by every outbound HTTP call so a hanging peer cannot stall a request. */
  outboundTimeoutMs: 30_000,
  /** Steam rejects requests without a plausible browser user agent. */
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
} as const;
