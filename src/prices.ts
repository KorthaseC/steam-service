import { config } from "./config.js";
import {
  countDueItems,
  countPrices,
  countTrackedItems,
  getMeta,
  getPricesFor,
  markLookupFailure,
  markLookupSuccess,
  pruneTrackedItems,
  recordHistory,
  selectDueItems,
  setMeta,
  trackItems,
  upsertPrices,
  type PriceRecord,
} from "./db.js";
import {
  isSteamLookupBlocked,
  lookupSteamPrice,
} from "./sources/steamMarket.js";

/**
 * Owns the price cache. Pricing is demand driven: names arriving in requests
 * are tracked, and a background cycle refreshes the oldest tracked prices a
 * batch at a time. Steam's rate limit makes crawling the full catalogue
 * impossible, so only what is actually asked about is kept current.
 */

const LAST_REFRESH_KEY = "last_price_refresh";
const LAST_REFRESH_COUNT_KEY = "last_price_refresh_count";

let refreshInFlight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  /** Names that were due and attempted in this cycle. */
  attempted: number;
  /** Prices successfully written. */
  updated: number;
  /** Lookups Steam did not answer with a price. */
  failed: number;
  /** Names still due after this cycle. */
  remaining: number;
  /** True when the cycle stopped early because Steam is rate limiting. */
  steamBlocked: boolean;
  durationMs: number;
}

function dueBefore(): number {
  return Date.now() - config.priceMaxAgeHours * 60 * 60 * 1000;
}

/**
 * Refreshes up to `budget` due prices. Concurrent calls share one run so a
 * manual refresh cannot pile up on top of the scheduled one.
 */
export function refreshPrices(
  budget = config.refreshBatchSize,
): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const started = Date.now();
    const due = selectDueItems(dueBefore(), config.maxLookupFailures, budget);

    let updated = 0;
    let failed = 0;

    for (const name of due) {
      // Stop rather than queue behind a five minute backoff.
      if (isSteamLookupBlocked()) break;

      const price = await lookupSteamPrice(name);
      if (price === undefined) {
        markLookupFailure(name);
        failed++;
        continue;
      }

      const now = Date.now();
      // Written per item so that an interrupted cycle keeps its progress.
      upsertPrices([{ name, price, source: "steam" }], now);
      if (config.enableHistory) {
        recordHistory(
          [{ name, price }],
          now,
          config.historyIntervalHours * 60 * 60 * 1000,
        );
      }
      markLookupSuccess(name);
      updated++;
    }

    setMeta(LAST_REFRESH_KEY, String(started));
    setMeta(LAST_REFRESH_COUNT_KEY, String(updated));
    pruneTrackedItems(config.trackedRetentionDays * 24 * 60 * 60 * 1000);

    const result: RefreshResult = {
      attempted: due.length,
      updated,
      failed,
      remaining: countDueItems(dueBefore(), config.maxLookupFailures),
      steamBlocked: isSteamLookupBlocked(),
      durationMs: Date.now() - started,
    };

    if (result.attempted > 0) {
      console.log(
        `[prices] refreshed ${result.updated}/${result.attempted} items in ` +
          `${Math.round(result.durationMs / 1000)}s ` +
          `(failed: ${result.failed}, still due: ${result.remaining})`,
      );
    }
    return result;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export interface PriceLookupResult {
  /** Prices found, keyed by market hash name. */
  prices: Map<string, PriceRecord>;
  /** Names that could not be priced at all. */
  missing: string[];
  /** True when direct lookups are currently rate limited. */
  steamBlocked: boolean;
}

/**
 * Resolves prices for a list of names and records them as worth tracking, so
 * the background cycle keeps them current from now on. Names with no price yet
 * are looked up immediately, up to the per request budget; the rest are picked
 * up by the next cycle.
 */
export async function resolvePrices(
  names: string[],
): Promise<PriceLookupResult> {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  if (unique.length > 0) trackItems(unique, Date.now());

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
    if (price === undefined) {
      markLookupFailure(name);
      continue;
    }
    markLookupSuccess(name);
    resolved.push({ name, price, source: "steam" });
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
  trackedItems: number;
  dueItems: number;
  lastRefresh: number | null;
  lastRefreshItems: number | null;
  stale: boolean;
} {
  const lastRefreshRaw = getMeta(LAST_REFRESH_KEY);
  const lastRefresh = lastRefreshRaw ? Number(lastRefreshRaw) : null;
  const lastCountRaw = getMeta(LAST_REFRESH_COUNT_KEY);

  // Stale means the cycle itself stopped running, not that individual prices
  // are old: three missed cycles is well past any normal delay.
  const staleAfterMs = config.priceRefreshMinutes * 60_000 * 3;

  return {
    itemCount: countPrices(),
    trackedItems: countTrackedItems(),
    dueItems: countDueItems(dueBefore(), config.maxLookupFailures),
    lastRefresh,
    lastRefreshItems: lastCountRaw ? Number(lastCountRaw) : null,
    stale: lastRefresh === null || Date.now() - lastRefresh > staleAfterMs,
  };
}

/** Starts the background refresh cycle. A run with nothing due is a no-op. */
export function startPriceWorker(): NodeJS.Timeout {
  const run = () => {
    refreshPrices().catch((error) => {
      console.error(`[prices] refresh failed: ${(error as Error).message}`);
    });
  };

  run();

  const timer = setInterval(run, config.priceRefreshMinutes * 60_000);
  // Do not hold the event loop open purely for the refresh timer.
  timer.unref();
  return timer;
}
