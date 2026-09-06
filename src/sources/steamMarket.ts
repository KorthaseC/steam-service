import { config } from "./../config.js";
import { steamHeaders } from "./../steamHeaders.js";
import { createThrottledQueue } from "./../throttle.js";

/**
 * Direct lookup against Steam's own market endpoint. Used only for items the
 * bulk dump does not know, for example brand new cases or very rare stickers.
 *
 * Steam allows roughly twenty of these per minute per IP and answers with 429
 * for several minutes afterwards, so every call goes through a single global
 * queue with a fixed delay between requests.
 */

const CURRENCY_CODES: Record<string, number> = { USD: 1, EUR: 3 };
const APP_ID = 730;

const queue = createThrottledQueue({
  label: "steam-market",
  delayMs: config.steamFallbackDelayMs,
  // Steam blocks the whole IP, not just the item that tripped the limit.
  blockMs: 5 * 60_000,
});

/**
 * Turns a localised Steam price string such as "1.234,56€" or "$12.34" into a
 * number. The decimal separator is whichever of comma or dot appears last.
 */
export function parsePriceString(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return undefined;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalised: string;

  if (lastComma === -1 && lastDot === -1) {
    normalised = cleaned;
  } else if (lastComma > lastDot) {
    normalised = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalised = cleaned.replace(/,/g, "");
  }

  const value = Number(normalised);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

interface PriceOverviewResponse {
  success?: boolean;
  lowest_price?: string;
  median_price?: string;
}

async function requestPrice(
  marketHashName: string,
): Promise<number | undefined> {
  const currencyCode = CURRENCY_CODES[config.currency] ?? 3;
  const url =
    `https://steamcommunity.com/market/priceoverview/` +
    `?appid=${APP_ID}&currency=${currencyCode}` +
    `&market_hash_name=${encodeURIComponent(marketHashName)}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.outboundTimeoutMs),
    headers: steamHeaders("https://steamcommunity.com/market/"),
  });

  if (response.status === 429) {
    queue.block();
    return undefined;
  }
  if (!response.ok) return undefined;

  const data = (await response.json()) as PriceOverviewResponse;
  if (!data.success) return undefined;

  // The lowest active listing reflects what an item would actually sell for.
  const raw = data.lowest_price ?? data.median_price;
  if (!raw) return undefined;
  return parsePriceString(raw);
}

/**
 * Queues a single lookup. Resolves with undefined whenever Steam refuses or
 * has no listing, so callers can simply treat the item as unpriced.
 */
export function lookupSteamPrice(
  marketHashName: string,
): Promise<number | undefined> {
  return queue.run(() => requestPrice(marketHashName));
}

export function isSteamLookupBlocked(): boolean {
  return queue.isBlocked();
}
