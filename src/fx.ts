import { config } from "./config.js";
import { getMeta, setMeta } from "./db.js";

/**
 * The bulk price dump publishes Steam prices in USD. When the service is
 * configured for EUR the rate is pulled from the ECB reference feed once every
 * twelve hours and cached, with the configured fallback used if that fails.
 */

const RATE_KEY = "usd_to_eur_rate";
const RATE_TIME_KEY = "usd_to_eur_fetched_at";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export async function getUsdToTargetRate(): Promise<{
  rate: number;
  source: string;
}> {
  if (config.currency === "USD") {
    return { rate: 1, source: "identity" };
  }

  const cachedRate = Number(getMeta(RATE_KEY));
  const cachedAt = Number(getMeta(RATE_TIME_KEY));
  if (
    Number.isFinite(cachedRate) &&
    cachedRate > 0 &&
    Date.now() - cachedAt < MAX_AGE_MS
  ) {
    return { rate: cachedRate, source: "cache" };
  }

  try {
    const response = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=EUR",
      {
        signal: AbortSignal.timeout(config.outboundTimeoutMs),
        headers: { "User-Agent": config.userAgent },
      },
    );
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = (await response.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.EUR;
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      throw new Error("no usable rate in response");
    }
    setMeta(RATE_KEY, String(rate));
    setMeta(RATE_TIME_KEY, String(Date.now()));
    return { rate, source: "frankfurter" };
  } catch (error) {
    console.warn(
      `[fx] exchange rate lookup failed, using fallback: ${(error as Error).message}`,
    );
    const fallback =
      Number.isFinite(cachedRate) && cachedRate > 0
        ? cachedRate
        : config.usdToEurFallback;
    return { rate: fallback, source: "fallback" };
  }
}
