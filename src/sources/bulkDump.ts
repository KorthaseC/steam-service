import { config } from "./../config.js";
import { getUsdToTargetRate } from "./../fx.js";
import { parsePriceString } from "./steamMarket.js";

/**
 * Bulk source for Steam market prices, built on Steam's own market search.
 * That endpoint returns 100 items per call instead of the single item that
 * priceoverview yields, so the whole CS2 catalogue is reachable in a few
 * hundred throttled requests rather than tens of thousands.
 *
 * A full crawl takes roughly fifteen minutes and runs in the background, so
 * requests are always answered from the database and never wait for it.
 */

const SEARCH_URL = "https://steamcommunity.com/market/search/render/";
const CURRENCY_CODES: Record<string, number> = { USD: 1, EUR: 3 };
const APP_ID = 730;
const PAGE_SIZE = 100;

/** Hard stop so a broken total_count cannot turn into an endless crawl. */
const MAX_PAGES = 400;
/** Steam blocks the IP for minutes after a burst, so a 429 pauses the crawl. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const MAX_ATTEMPTS_PER_PAGE = 3;

interface SearchResultItem {
  hash_name?: string;
  sell_listings?: number;
  /** Lowest listing in minor units of the requested currency. */
  sell_price?: number;
  sell_price_text?: string;
  asset_description?: { market_hash_name?: string };
}

interface SearchResponse {
  success?: boolean;
  start?: number;
  total_count?: number;
  results?: SearchResultItem[] | null;
}

export interface DumpResult {
  prices: Array<{ name: string; price: number; source: string }>;
  rate: number;
  rateSource: string;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Steam usually honours the currency parameter, but falls back to USD for
 * anonymous callers in some regions. The price text carries the symbol, so it
 * decides whether a conversion is needed rather than the request parameter.
 */
function currencyOf(text: string | undefined): "EUR" | "USD" | undefined {
  if (!text) return undefined;
  if (text.includes("€")) return "EUR";
  if (text.includes("$")) return "USD";
  return undefined;
}

function pageUrl(start: number): string {
  const params = new URLSearchParams({
    appid: String(APP_ID),
    norender: "1",
    count: String(PAGE_SIZE),
    start: String(start),
    currency: String(CURRENCY_CODES[config.currency] ?? 3),
    search_descriptions: "0",
  });
  return `${SEARCH_URL}?${params}`;
}

/**
 * Fetches one page, retrying after a backoff when Steam rate limits. Returns
 * undefined once the attempts are used up, which ends the crawl and keeps
 * whatever was collected so far.
 */
async function fetchPage(start: number): Promise<SearchResponse | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
    try {
      const response = await fetch(pageUrl(start), {
        signal: AbortSignal.timeout(config.outboundTimeoutMs),
        headers: {
          "User-Agent": config.userAgent,
          Accept: "application/json",
          Referer: "https://steamcommunity.com/market/",
        },
      });

      if (response.status === 429 || response.status === 403) {
        console.warn(
          `[prices] Steam rate limited at offset ${start}, waiting 5 minutes ` +
            `(attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE})`,
        );
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      if (!response.ok) {
        console.warn(
          `[prices] offset ${start} returned status ${response.status}`,
        );
        await sleep(config.steamFallbackDelayMs);
        continue;
      }

      // Steam answers with an HTML error page instead of a status code when
      // it is unhappy, so the body is inspected before parsing.
      const body = await response.text();
      if (!body.trimStart().startsWith("{")) {
        console.warn(`[prices] offset ${start} returned a non-JSON body`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }

      return JSON.parse(body) as SearchResponse;
    } catch (error) {
      console.warn(
        `[prices] offset ${start} failed: ${(error as Error).message} ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE})`,
      );
      await sleep(config.steamFallbackDelayMs);
    }
  }
  return undefined;
}

/** Extracts a price in the target currency, converting only when Steam sent USD. */
function priceOf(item: SearchResultItem, usdRate: number): number | undefined {
  const raw =
    typeof item.sell_price === "number" && item.sell_price > 0
      ? item.sell_price / 100
      : parsePriceString(item.sell_price_text ?? "");

  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;

  const sent = currencyOf(item.sell_price_text);
  const converted =
    sent === "USD" && config.currency === "EUR" ? raw * usdRate : raw;
  return Math.round(converted * 100) / 100;
}

export async function fetchBulkPrices(): Promise<DumpResult> {
  const { rate, source: rateSource } = await getUsdToTargetRate();

  const collected = new Map<string, number>();
  let totalCount = Number.POSITIVE_INFINITY;
  let start = 0;
  let pages = 0;

  while (start < totalCount && pages < MAX_PAGES) {
    const page = await fetchPage(start);
    if (!page) break;

    if (typeof page.total_count === "number" && page.total_count > 0) {
      totalCount = page.total_count;
    }

    const results = page.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const name = item.asset_description?.market_hash_name ?? item.hash_name;
      if (!name) continue;
      const price = priceOf(item, rate);
      if (price === undefined) continue;
      collected.set(name, price);
    }

    pages++;
    start += results.length;

    // Progress matters here: a full crawl runs for a quarter of an hour.
    if (pages % 25 === 0) {
      console.log(
        `[prices] crawled ${collected.size} items (offset ${start}/${totalCount})`,
      );
    }

    await sleep(config.steamFallbackDelayMs);
  }

  if (collected.size === 0) {
    throw new Error(
      "Steam market search returned no usable prices; the server may be rate limited",
    );
  }

  const prices = [...collected].map(([name, price]) => ({
    name,
    price,
    source: "market-search",
  }));

  return { prices, rate, rateSource, url: SEARCH_URL };
}
