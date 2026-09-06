import { config } from "./../config.js";
import { getUsdToTargetRate } from "./../fx.js";

/**
 * Bulk source for Steam market prices. One request returns the whole CS2
 * catalogue, which avoids the per item rate limit that makes the official
 * priceoverview endpoint unusable for entire inventories.
 *
 * The payload maps a market hash name to price entries per marketplace. Only
 * the Steam block is used here, preferring the most recent averaging window
 * that actually contains a value.
 */

const DUMP_URL = "https://prices.csgotrader.app/latest/prices_v6.json";

interface SteamPriceBlock {
  last_24h?: number | null;
  last_7d?: number | null;
  last_30d?: number | null;
  last_90d?: number | null;
}

interface DumpEntry {
  steam?: SteamPriceBlock | null;
}

export interface DumpResult {
  prices: Array<{ name: string; price: number; source: string }>;
  rate: number;
  rateSource: string;
}

/** Picks the freshest averaging window that holds a positive number. */
function pickSteamPrice(block: SteamPriceBlock): number | undefined {
  const candidates = [
    block.last_24h,
    block.last_7d,
    block.last_30d,
    block.last_90d,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

export async function fetchBulkPrices(): Promise<DumpResult> {
  const { rate, source: rateSource } = await getUsdToTargetRate();

  const response = await fetch(DUMP_URL, {
    signal: AbortSignal.timeout(120_000),
    headers: {
      "User-Agent": config.userAgent,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Bulk price dump returned status ${response.status}`);
  }

  const data = (await response.json()) as Record<string, DumpEntry>;
  const prices: Array<{ name: string; price: number; source: string }> = [];

  for (const [name, entry] of Object.entries(data)) {
    if (!entry?.steam) continue;
    const usd = pickSteamPrice(entry.steam);
    if (usd === undefined) continue;
    // Round to cents so that the stored value matches what the market shows.
    prices.push({
      name,
      price: Math.round(usd * rate * 100) / 100,
      source: "bulk",
    });
  }

  if (prices.length === 0) {
    throw new Error("Bulk price dump contained no usable Steam prices");
  }

  return { prices, rate, rateSource };
}
