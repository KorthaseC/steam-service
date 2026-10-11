import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import {
  clientIpKey,
  rateLimitKey,
  requireAdmin,
  requireGuest,
  resolveAccessCode,
  resolveSessionAuth,
} from "./auth.js";
import { config } from "./config.js";
import { hltbStatus, refreshHltb } from "./hltb.js";
import {
  netAfterFee,
  priceStoreStatus,
  refreshPrices,
  resolvePrices,
} from "./prices.js";
import { sessionCookie, signSession } from "./session.js";
import { SteamApiError } from "./sources/steamWebApi.js";
import { getInventory, InventoryError } from "./steamInventory.js";
import {
  hideLibraryGame,
  loadHltbProgress,
  loadLibrary,
  unhideAllLibraryGames,
  unhideLibraryGame,
} from "./steamLibrary.js";
import { parseSteamRef } from "./steamRef.js";
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

/**
 * Guards the one endpoint where a short, human typed secret is guessed against.
 * Keyed on the client address because there is no authenticated identity yet.
 */
const loginLimiter = rateLimit({
  windowMs: config.loginRateWindowMs,
  limit: config.loginRateMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIpKey(req.ip),
  message: { error: "rate_limited" },
});

/**
 * Budget for the browser frontend. Larger than the guest limit because loading
 * one library plus polling for completion times is many small requests, not the
 * single heavy call a spreadsheet client makes.
 */
const libraryLimiter = rateLimit({
  windowMs: config.sessionRateWindowMs,
  limit: config.sessionRateMax,
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

/** Same, for the Steam Web API errors behind the library endpoints. */
function handleSteamError(error: unknown): { status: number; body: object } {
  if (error instanceof SteamApiError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message },
    };
  }
  console.error("[routes] unexpected error:", error);
  return { status: 500, body: { error: "internal_error" } };
}

const INVALID_REF = {
  error: "invalid_steam_ref",
  message:
    "Expected a SteamID64, a steamcommunity.com profile link or a vanity name",
};

const INVALID_APP_ID = {
  error: "invalid_app_id",
  message: "Expected a positive numeric AppID",
};

/**
 * Who is asking, for everything stored per caller. The label of the access
 * code or guest key - `session:chris`, `sheet` - rather than anything about the
 * browser, so hidden games follow a person across devices. Two people sharing
 * one code share one list, which is the price of having no accounts.
 */
function ownerOf(req: Request): string | null {
  return req.auth?.label ?? null;
}

/** AppIDs are positive integers; anything else never reaches the database. */
function parseAppId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const appId = Number(raw);
  return Number.isSafeInteger(appId) && appId > 0 ? appId : null;
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
    res.status(413).json({
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

/* ---------------------------------------------------------------------- *
 * Sessions for the web frontend
 *
 * The frontend cannot hold a bearer key: anything it stores is readable by
 * script on the page. Instead an access code is traded once for an HttpOnly
 * cookie that no script can read. See session.ts for the cookie format.
 * ---------------------------------------------------------------------- */

/** Signs in with an access code and returns the session as a cookie. */
router.post("/auth/session", loginLimiter, (req, res) => {
  if (config.accessCodes.size === 0 || !config.sessionSecret) {
    res.status(503).json({
      error: "feature_disabled",
      message: "No access codes are configured",
    });
    return;
  }

  const body = req.body as { code?: unknown };
  if (typeof body?.code !== "string" || body.code.length === 0) {
    res
      .status(400)
      .json({ error: "invalid_body", message: "Expected { code: string }" });
    return;
  }
  // Bounded before the comparison so a huge body cannot become the workload.
  if (body.code.length > 200) {
    res.status(403).json({ error: "invalid_access_code" });
    return;
  }

  const label = resolveAccessCode(body.code);
  if (!label) {
    res.status(403).json({ error: "invalid_access_code" });
    return;
  }

  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  res.setHeader(
    "Set-Cookie",
    sessionCookie(signSession(label, ttlMs), Math.floor(ttlMs / 1000)),
  );
  res.json({ ok: true, label });
});

/** Reports whether the caller currently holds a valid session. */
router.get("/auth/session", (req, res) => {
  const session = resolveSessionAuth(req);
  res.json({
    authenticated: session !== undefined,
    // Strip the prefix the auth layer adds for its own bookkeeping.
    label: session ? session.label.replace(/^session:/, "") : null,
    loginRequired: config.accessCodes.size > 0,
  });
});

/** Signs out by overwriting the cookie with an expired one. */
router.delete("/auth/session", (_req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------- *
 * Steam library and completion times
 * ---------------------------------------------------------------------- */

/**
 * Profile, owned games and whatever completion times are already cached.
 *
 * Answers immediately: games nobody has looked up yet come back with a null
 * hltb field and are queued for the background worker. The companion endpoint
 * below is what the frontend polls until nothing is pending.
 *
 * `?refresh=1` reads profile and games from Steam instead of the cache, at
 * most once per LIBRARY_REFRESH_COOLDOWN_SECONDS per SteamID. It is not a
 * privilege: guests may use it, because the cooldown bounds the cost no matter
 * who asks, and a request inside the cooldown is simply served from the cache.
 */
router.get(
  "/steam/library/:ref",
  requireGuest,
  libraryLimiter,
  async (req, res) => {
    // noUncheckedIndexedAccess types route params as possibly undefined; the
    // raw text is echoed back so the frontend can show what the user typed.
    const raw = req.params.ref ?? "";
    const ref = parseSteamRef(raw);
    if (!ref) {
      res.status(400).json(INVALID_REF);
      return;
    }

    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    const refresh = req.query.refresh === "1";

    try {
      res.json(await loadLibrary(ref, raw, owner, refresh));
    } catch (error) {
      const { status, body } = handleSteamError(error);
      res.status(status).json(body);
    }
  },
);

/**
 * Completion times only, keyed by AppID. Reads the cached library rather than
 * Steam, so polling this every few seconds costs one local query.
 */
router.get(
  "/steam/library/:ref/hltb",
  requireGuest,
  libraryLimiter,
  async (req, res) => {
    const ref = parseSteamRef(req.params.ref);
    if (!ref) {
      res.status(400).json(INVALID_REF);
      return;
    }

    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    try {
      res.json(await loadHltbProgress(ref, owner));
    } catch (error) {
      const { status, body } = handleSteamError(error);
      res.status(status).json(body);
    }
  },
);

/**
 * Hides one game from the caller's view of this library, permanently until it
 * is shown again. Idempotent. Answers with the caller's updated hidden list.
 *
 * Safe to expose to guests on a cookie session: the cookie is SameSite=Lax, so
 * a cross-site PUT or DELETE never carries it, and the API sends no CORS
 * headers that would let another origin try.
 */
router.put(
  "/steam/library/:ref/hidden/:appId",
  requireGuest,
  libraryLimiter,
  async (req, res) => {
    const ref = parseSteamRef(req.params.ref);
    if (!ref) {
      res.status(400).json(INVALID_REF);
      return;
    }
    const appId = parseAppId(req.params.appId);
    if (appId === null) {
      res.status(400).json(INVALID_APP_ID);
      return;
    }
    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    try {
      res.json({ hidden: await hideLibraryGame(ref, owner, appId) });
    } catch (error) {
      const { status, body } = handleSteamError(error);
      res.status(status).json(body);
    }
  },
);

/** Shows one hidden game again. Idempotent. */
router.delete(
  "/steam/library/:ref/hidden/:appId",
  requireGuest,
  libraryLimiter,
  async (req, res) => {
    const ref = parseSteamRef(req.params.ref);
    if (!ref) {
      res.status(400).json(INVALID_REF);
      return;
    }
    const appId = parseAppId(req.params.appId);
    if (appId === null) {
      res.status(400).json(INVALID_APP_ID);
      return;
    }
    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    try {
      res.json({ hidden: await unhideLibraryGame(ref, owner, appId) });
    } catch (error) {
      const { status, body } = handleSteamError(error);
      res.status(status).json(body);
    }
  },
);

/** Shows every game the caller has hidden in this library again. */
router.delete(
  "/steam/library/:ref/hidden",
  requireGuest,
  libraryLimiter,
  async (req, res) => {
    const ref = parseSteamRef(req.params.ref);
    if (!ref) {
      res.status(400).json(INVALID_REF);
      return;
    }
    const owner = ownerOf(req);
    if (!owner) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    try {
      res.json({ hidden: await unhideAllLibraryGames(ref, owner) });
    } catch (error) {
      const { status, body } = handleSteamError(error);
      res.status(status).json(body);
    }
  },
);

/** Progress of the completion time worker. */
router.get("/steam/status", requireAdmin, adminLimiter, (_req, res) => {
  const status = hltbStatus();
  res.json({
    ...status,
    lastRefresh: status.lastRefresh
      ? new Date(status.lastRefresh).toISOString()
      : null,
    steamApiConfigured: config.steamApiKey.length > 0,
    accessCodes: [...config.accessCodes.values()],
    workerIntervalMinutes: config.hltbWorkerIntervalMinutes,
  });
});

/** Forces a completion time cycle outside the normal schedule. */
router.post(
  "/admin/refresh-hltb",
  requireAdmin,
  adminLimiter,
  async (_req, res) => {
    try {
      const result = await refreshHltb();
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
