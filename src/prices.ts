import { config } from "./config.js";
import {
  countPrices,
  getMeta,
  getPricesFor,
  recordHistory,
  setMeta,
  upsertPrices,
  type PriceRecord,
} from "./db.js";
import { fetchBulkPrices } from "./sources/bulkDump.js";
import {
  isSteamLookupBlocked,
  lookupSteamPrice,
} from "./sources/steamMarket.js";

/**
 * Owns the price cache: refreshes it on a schedule and answers lookups from
 * the database, only touching Steam directly for names the dump does not
 * cover.
 */

const LAST_REFRESH_KEY = "last_price_refresh";
const LAST_REFRESH_COUNT_KEY = "last_price_refresh_count";

let refreshInFlight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  itemCount: number;
  historyRows: number;
  rate: number;
  rateSource: string;
  durationMs: number;
}

/**
 * Pulls the bulk dump into the local store. Concurrent calls share one run so
 * that a manual refresh cannot pile up on top of the scheduled one.
 */
export function refreshPrices(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const started = Date.now();
    const { prices, rate, rateSource } = await fetchBulkPrices();

    upsertPrices(prices, started);

    let historyRows = 0;
    if (config.enableHistory) {
      historyRows = recordHistory(
        prices,
        started,
        config.historyIntervalHours * 60 * 60 * 1000,
      );
    }

    setMeta(LAST_REFRESH_KEY, String(started));
    setMeta(LAST_REFRESH_COUNT_KEY, String(prices.length));

    const result: RefreshResult = {
      itemCount: prices.length,
      historyRows,
      rate,
      rateSource,
      durationMs: Date.now() - started,
    };
    console.log(
      `[prices] refreshed ${result.itemCount} items in ${result.durationMs}ms ` +
        `(history rows: ${historyRows}, rate: ${rate} via ${rateSource})`,
    );
    return result;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export interface PriceLookupResult {
  /** Prices found, keyed by market hash name. */
  prices: Map<string, PriceRecord>;
  /** Names that could not be priced from any source. */
  missing: string[];
  /** True when the direct Steam fallback is currently rate limited. */
  steamBlocked: boolean;
}

/**
 * Resolves prices for a list of names. Anything missing from the cache is
 * looked up directly at Steam, up to the configured per request budget, and
 * the result is written back so the next caller gets it for free.
 */
export async function resolvePrices(
  names: string[],
): Promise<PriceLookupResult> {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  const prices = getPricesFor(unique);
  const missing = unique.filter((name) => !prices.has(name));

  if (
    missing.length === 0 ||
    !config.steamFallbackEnabled ||
    isSteamLookupBlocked()
  ) {
    return { prices, missing, steamBlocked: isSteamLookupBlocked() };
  }

  const budget = missing.slice(0, config.steamFallbackMaxPerRequest);
  const resolved: Array<{ name: string; price: number; source: string }> = [];

  for (const name of budget) {
    const price = await lookupSteamPrice(name);
    if (price !== undefined) {
      resolved.push({ name, price, source: "steam" });
    }
  }

  if (resolved.length > 0) {
    const now = Date.now();
    upsertPrices(resolved, now);
    for (const entry of resolved) {
      prices.set(entry.name, {
        marketHashName: entry.name,
        price: entry.price,
        currency: config.currency,
        source: entry.source,
        updatedAt: now,
      });
    }
  }

  return {
    prices,
    missing: unique.filter((name) => !prices.has(name)),
    steamBlocked: isSteamLookupBlocked(),
  };
}

/** Net proceeds after Steam's cut, which is what a sale actually pays out. */
export function netAfterFee(price: number): number {
  return Math.round((price / config.steamFeeDivisor) * 100) / 100;
}

export function priceStoreStatus(): {
  itemCount: number;
  lastRefresh: number | null;
  lastRefreshItems: number | null;
  stale: boolean;
} {
  const lastRefreshRaw = getMeta(LAST_REFRESH_KEY);
  const lastRefresh = lastRefreshRaw ? Number(lastRefreshRaw) : null;
  const lastCountRaw = getMeta(LAST_REFRESH_COUNT_KEY);
  return {
    itemCount: countPrices(),
    lastRefresh,
    lastRefreshItems: lastCountRaw ? Number(lastCountRaw) : null,
    stale:
      lastRefresh === null ||
      Date.now() - lastRefresh > config.priceStaleMinutes * 60_000,
  };
}

/**
 * Starts the background refresh loop. An empty store is filled immediately,
 * otherwise the first run waits for the normal interval.
 */
export function startPriceWorker(): NodeJS.Timeout {
  const run = () => {
    refreshPrices().catch((error) => {
      console.error(`[prices] refresh failed: ${(error as Error).message}`);
    });
  };

  const status = priceStoreStatus();
  if (status.itemCount === 0 || status.stale) {
    run();
  }

  const timer = setInterval(run, config.priceRefreshMinutes * 60_000);
  // Do not hold the event loop open purely for the refresh timer.
  timer.unref();
  return timer;
}
