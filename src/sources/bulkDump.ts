import { config } from "./../config.js";
import { getUsdToTargetRate } from "./../fx.js";

/**
 * Bulk source for Steam market prices. One request returns the whole CS2
 * catalogue, which avoids the per item rate limit that makes the official
 * priceoverview endpoint unusable for entire inventories.
 *
 * The payload maps a market hash name to price entries per marketplace. Only
 * the Steam block is used here, preferring the most recent averaging window
 * that actually contains a value. The dump is regenerated once a day, so
 * refreshing more often than a few hours gains nothing.
 */

const DUMP_URL = "https://prices.csgotrader.app/latests.json";

interface SteamPriceWindows {
  last_24h?: number | null;
  last_7d?: number | null;
  last_30d?: number | null;
  last_90d?: number | null;
  price?: number | null;
}

/** The Steam block is usually an object of averaging windows, sometimes a bare number. */
type SteamPriceBlock = SteamPriceWindows | number | null;

interface DumpEntry {
  steam?: SteamPriceBlock;
}

export interface DumpResult {
  prices: Array<{ name: string; price: number; source: string }>;
  rate: number;
  rateSource: string;
}

function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Picks the freshest averaging window that holds a positive number. */
function pickSteamPrice(
  block: SteamPriceBlock | undefined,
): number | undefined {
  if (block === null || block === undefined) return undefined;
  if (typeof block === "number") return usable(block) ? block : undefined;

  const candidates = [
    block.last_24h,
    block.last_7d,
    block.last_30d,
    block.last_90d,
    block.price,
  ];
  for (const value of candidates) {
    if (usable(value)) return value;
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

  // A moved or deleted dump answers with an HTML notice and status 200, so the
  // body is checked before parsing to produce a readable error instead of a
  // JSON syntax complaint about a doctype.
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "unknown";
  if (!body.trimStart().startsWith("{")) {
    throw new Error(
      `Bulk price dump returned ${contentType} instead of JSON. ` +
        `First bytes: ${body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
  }

  let data: Record<string, DumpEntry>;
  try {
    data = JSON.parse(body) as Record<string, DumpEntry>;
  } catch (error) {
    throw new Error(
      `Bulk price dump is not valid JSON: ${(error as Error).message}`,
    );
  }

  const prices: Array<{ name: string; price: number; source: string }> = [];

  for (const [name, entry] of Object.entries(data)) {
    const usd = pickSteamPrice(entry?.steam);
    if (usd === undefined) continue;
    // Round to cents so that the stored value matches what the market shows.
    prices.push({
      name,
      price: Math.round(usd * rate * 100) / 100,
      source: "bulk",
    });
  }

  if (prices.length === 0) {
    // Include one entry verbatim: if the provider changes the payout shape
    // again, the log shows what to adapt the parser to.
    const [sampleName, sampleEntry] = Object.entries(data)[0] ?? [];
    throw new Error(
      `Bulk price dump contained no usable Steam prices. ` +
        `Sample entry "${sampleName}": ${JSON.stringify(sampleEntry).slice(0, 200)}`,
    );
  }

  return { prices, rate, rateSource };
}
