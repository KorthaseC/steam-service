import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  clientIpKey,
  rateLimitKey,
  requireAdmin,
  requireGuest,
} from "./auth.js";
import { config } from "./config.js";
import {
  netAfterFee,
  priceStoreStatus,
  refreshPrices,
  resolvePrices,
} from "./prices.js";
import { getInventory, InventoryError } from "./steamInventory.js";
import { toCsv, valueInventory } from "./valuation.js";

/**
 * All HTTP endpoints. Guest routes expose nothing but the valuation of an
 * explicitly requested public inventory; everything else needs the admin key.
 */

export const router = Router();

/**
 * First line of defence, applied to every route before authentication runs.
 * The per key limiters below can only see requests that already carry a valid
 * key, so without this one key guessing and the open health endpoint would be
 * unlimited. Budget is deliberately larger than the per key limits.
 */
const ipLimiter = rateLimit({
  windowMs: config.ipRateWindowMs,
  limit: config.ipRateMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIpKey(req.ip),
  message: { error: "rate_limited" },
});

router.use(ipLimiter);

const guestLimiter = rateLimit({
  windowMs: config.guestRateWindowMs,
  limit: config.guestRateMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: "rate_limited" },
});

const adminLimiter = rateLimit({
  windowMs: config.adminRateWindowMs,
  limit: config.adminRateMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: "rate_limited" },
});

/** Translates the typed inventory errors into HTTP responses. */
function handleInventoryError(error: unknown): {
  status: number;
  body: object;
} {
  if (error instanceof InventoryError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message },
    };
  }
  console.error("[routes] unexpected error:", error);
  return { status: 500, body: { error: "internal_error" } };
}

/** Public liveness probe. Deliberately reveals nothing beyond service state. */
router.get("/health", (_req, res) => {
  const status = priceStoreStatus();
  res.json({
    ok: true,
    currency: config.currency,
    priceItems: status.itemCount,
    lastPriceRefresh: status.lastRefresh
      ? new Date(status.lastRefresh).toISOString()
      : null,
    pricesStale: status.stale,
  });
});

/**
 * Values any public inventory. This is the endpoint shared with other people.
 * The SteamID has to be supplied by the caller and is validated strictly.
 */
router.get(
  "/inventory/:steamId",
  requireGuest,
  guestLimiter,
  async (req, res) => {
    try {
      const snapshot = await getInventory(req.params.steamId);
      const result = await valueInventory(snapshot);
      const status = priceStoreStatus();

      res.json({
        steamId: result.steamId,
        currency: result.currency,
        summary: {
          uniqueItems: result.uniqueItems,
          totalItems: result.totalItems,
          totalMarketValue: result.totalMarketValue,
          totalNetAfterFee: result.totalNetAfterFee,
          unpricedItems: result.unpriced.length,
        },
        meta: {
          inventoryFetchedAt: new Date(result.fetchedAt).toISOString(),
          inventoryFromCache: result.fromCache,
          pricesStale: status.stale,
          lastPriceRefresh: status.lastRefresh
            ? new Date(status.lastRefresh).toISOString()
            : null,
        },
        items: result.items,
      });
    } catch (error) {
      const { status, body } = handleInventoryError(error);
      res.status(status).json(body);
    }
  },
);

/**
 * Same data as the inventory endpoint but shaped for the spreadsheet, with an
 * optional CSV representation. Admin only, since it is meant for your own
 * account and allows bypassing the inventory cache.
 */
router.get(
  "/portfolio/:steamId",
  requireAdmin,
  adminLimiter,
  async (req, res) => {
    try {
      const force = req.query.refresh === "1";
      const snapshot = await getInventory(req.params.steamId, force);
      const result = await valueInventory(snapshot);

      if (req.query.format === "csv") {
        res.type("text/csv; charset=utf-8").send(toCsv(result));
        return;
      }

      res.json(result);
    } catch (error) {
      const { status, body } = handleInventoryError(error);
      res.status(status).json(body);
    }
  },
);

/**
 * Prices an arbitrary list of item names. This is what the spreadsheet calls
 * with the names from its own purchase log, so that sold or externally held
 * items can be valued too.
 */
router.post("/prices/lookup", requireAdmin, adminLimiter, async (req, res) => {
  const body = req.body as { names?: unknown };
  if (!Array.isArray(body?.names)) {
    res
      .status(400)
      .json({ error: "invalid_body", message: "Expected { names: string[] }" });
    return;
  }
  if (body.names.length > 500) {
    res
      .status(413)
      .json({
        error: "too_many_names",
        message: "At most 500 names per request",
      });
    return;
  }

  const names = body.names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 200);

  try {
    const { prices, missing, steamBlocked } = await resolvePrices(names);
    const payload: Record<
      string,
      { price: number; netAfterFee: number; source: string; updatedAt: string }
    > = {};

    for (const [name, record] of prices) {
      payload[name] = {
        price: record.price,
        netAfterFee: netAfterFee(record.price),
        source: record.source,
        updatedAt: new Date(record.updatedAt).toISOString(),
      };
    }

    res.json({
      currency: config.currency,
      prices: payload,
      missing,
      steamLookupBlocked: steamBlocked,
    });
  } catch (error) {
    const { status, body: errorBody } = handleInventoryError(error);
    res.status(status).json(errorBody);
  }
});

/** Forces a price refresh outside the normal schedule. */
router.post(
  "/admin/refresh-prices",
  requireAdmin,
  adminLimiter,
  async (_req, res) => {
    try {
      const result = await refreshPrices();
      res.json({ ok: true, ...result });
    } catch (error) {
      res
        .status(502)
        .json({ error: "refresh_failed", message: (error as Error).message });
    }
  },
);

/** Detailed store status, including the list of configured guest key labels. */
router.get("/admin/status", requireAdmin, adminLimiter, (_req, res) => {
  const status = priceStoreStatus();
  res.json({
    currency: config.currency,
    priceItems: status.itemCount,
    lastPriceRefresh: status.lastRefresh
      ? new Date(status.lastRefresh).toISOString()
      : null,
    lastRefreshItems: status.lastRefreshItems,
    pricesStale: status.stale,
    guestKeyLabels: [...config.guestKeys.values()],
    refreshIntervalMinutes: config.priceRefreshMinutes,
    inventoryCacheMinutes: config.inventoryCacheMinutes,
  });
});
