import { config } from "./config.js";
import { getCachedInventory, setCachedInventory } from "./db.js";
import { steamHeaders } from "./steamHeaders.js";

/**
 * Reads a public CS2 inventory from Steam and reduces it to a list of item
 * names with quantities. Results are cached per SteamID because Steam blocks
 * the server IP quickly when inventories are fetched repeatedly.
 */

const APP_ID = 730;
const CONTEXT_ID = 2;

/** SteamID64 for individual accounts always starts with 7656119 and has 17 digits. */
const STEAM_ID_PATTERN = /^7656119\d{10}$/;

export type InventoryErrorCode =
  | "invalid_steamid"
  | "inventory_private"
  | "steam_rate_limited"
  | "steam_unavailable"
  | "inventory_empty";

export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

export interface InventoryItem {
  marketHashName: string;
  quantity: number;
  marketable: boolean;
  tradable: boolean;
  type: string;
}

export interface InventorySnapshot {
  steamId: string;
  items: InventoryItem[];
  totalItems: number;
  fetchedAt: number;
  fromCache: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validates and normalises user supplied input. Only a plain SteamID64 is
 * accepted, which keeps any user controlled string out of the outbound URL.
 */
export function normaliseSteamId(input: unknown): string {
  if (typeof input !== "string") {
    throw new InventoryError(
      "invalid_steamid",
      "SteamID must be a string",
      400,
    );
  }
  const trimmed = input.trim();
  if (!STEAM_ID_PATTERN.test(trimmed)) {
    throw new InventoryError(
      "invalid_steamid",
      "Expected a 17 digit SteamID64 starting with 7656119",
      400,
    );
  }
  return trimmed;
}

interface SteamAsset {
  classid?: string;
  instanceid?: string;
  assetid?: string;
  amount?: string;
}

interface SteamDescription {
  classid?: string;
  instanceid?: string;
  market_hash_name?: string;
  marketable?: number;
  tradable?: number;
  type?: string;
}

interface SteamInventoryPage {
  assets?: SteamAsset[];
  descriptions?: SteamDescription[];
  more_items?: number;
  last_assetid?: string;
  total_inventory_count?: number;
}

function descriptionKey(
  classId: string | undefined,
  instanceId: string | undefined,
): string {
  return `${classId ?? "0"}_${instanceId ?? "0"}`;
}

async function fetchPage(
  steamId: string,
  startAssetId?: string,
): Promise<SteamInventoryPage> {
  const params = new URLSearchParams({
    l: "english",
    count: String(config.inventoryPageSize),
  });
  if (startAssetId) params.set("start_assetid", startAssetId);

  const url = `https://steamcommunity.com/inventory/${steamId}/${APP_ID}/${CONTEXT_ID}?${params}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(config.outboundTimeoutMs),
      headers: steamHeaders(
        `https://steamcommunity.com/profiles/${steamId}/inventory`,
      ),
    });
  } catch (error) {
    throw new InventoryError(
      "steam_unavailable",
      `Could not reach Steam: ${(error as Error).message}`,
      502,
    );
  }

  if (response.status === 403 || response.status === 401) {
    throw new InventoryError(
      "inventory_private",
      "This inventory is private or the profile does not exist",
      403,
    );
  }
  if (response.status === 429) {
    throw new InventoryError(
      "steam_rate_limited",
      "Steam refused the inventory request with 429. This is usually the " +
        "client identity rather than the request volume; check STEAM_USER_AGENT.",
      429,
    );
  }
  if (!response.ok) {
    throw new InventoryError(
      "steam_unavailable",
      `Steam returned status ${response.status}`,
      502,
    );
  }

  const data = (await response.json()) as SteamInventoryPage | null;
  // Steam answers 200 with a null body for hidden inventories.
  if (
    !data ||
    !Array.isArray(data.assets) ||
    !Array.isArray(data.descriptions)
  ) {
    throw new InventoryError(
      "inventory_private",
      "Steam returned no inventory data; the inventory is private or empty",
      403,
    );
  }
  return data;
}

/**
 * Fetches the full inventory, following pagination up to the configured page
 * limit, and aggregates identical items into a single row with a quantity.
 */
async function fetchFromSteam(steamId: string): Promise<InventoryItem[]> {
  const aggregated = new Map<string, InventoryItem>();
  let startAssetId: string | undefined;

  for (let page = 0; page < config.inventoryMaxPages; page++) {
    // Small pages mean more requests, so they are spaced out deliberately.
    if (page > 0) await sleep(config.inventoryPageDelayMs);

    const data = await fetchPage(steamId, startAssetId);

    const descriptions = new Map<string, SteamDescription>();
    for (const description of data.descriptions ?? []) {
      descriptions.set(
        descriptionKey(description.classid, description.instanceid),
        description,
      );
    }

    for (const asset of data.assets ?? []) {
      const description = descriptions.get(
        descriptionKey(asset.classid, asset.instanceid),
      );
      const name = description?.market_hash_name;
      if (!name) continue;

      const amount = Number(asset.amount ?? "1");
      const quantity = Number.isFinite(amount) && amount > 0 ? amount : 1;

      const existing = aggregated.get(name);
      if (existing) {
        existing.quantity += quantity;
      } else {
        aggregated.set(name, {
          marketHashName: name,
          quantity,
          marketable: description?.marketable === 1,
          tradable: description?.tradable === 1,
          type: description?.type ?? "",
        });
      }
    }

    if (data.more_items !== 1 || !data.last_assetid) break;
    startAssetId = data.last_assetid;
  }

  if (aggregated.size === 0) {
    throw new InventoryError(
      "inventory_empty",
      "No CS2 items found in this inventory",
      404,
    );
  }

  return [...aggregated.values()].sort((a, b) =>
    a.marketHashName.localeCompare(b.marketHashName),
  );
}

/**
 * Returns the inventory, serving a cached snapshot when it is still fresh.
 * Pass forceRefresh only for your own account; ignoring the cache for guest
 * requests would hand out a way to get the server IP blocked by Steam.
 */
export async function getInventory(
  steamIdInput: unknown,
  forceRefresh = false,
): Promise<InventorySnapshot> {
  const steamId = normaliseSteamId(steamIdInput);
  const maxAgeMs = config.inventoryCacheMinutes * 60_000;

  if (!forceRefresh) {
    const cached = getCachedInventory(steamId);
    if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
      // A damaged cache row must not turn into a 500; fall through to Steam.
      let items: InventoryItem[] | undefined;
      try {
        const parsed: unknown = JSON.parse(cached.payload);
        if (Array.isArray(parsed)) items = parsed as InventoryItem[];
      } catch {
        console.warn(
          `[inventory] discarding unreadable cache entry for ${steamId}`,
        );
      }

      if (items) {
        return {
          steamId,
          items,
          totalItems: items.reduce((sum, item) => sum + item.quantity, 0),
          fetchedAt: cached.fetchedAt,
          fromCache: true,
        };
      }
    }
  }

  const items = await fetchFromSteam(steamId);
  const fetchedAt = Date.now();
  setCachedInventory(steamId, JSON.stringify(items), fetchedAt);

  return {
    steamId,
    items,
    totalItems: items.reduce((sum, item) => sum + item.quantity, 0),
    fetchedAt,
    fromCache: false,
  };
}
