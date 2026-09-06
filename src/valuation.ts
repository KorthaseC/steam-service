import { config } from "./config.js";
import { netAfterFee, resolvePrices } from "./prices.js";
import type { InventorySnapshot } from "./steamInventory.js";

/**
 * Joins an inventory snapshot with the price cache and produces the numbers
 * that both the API and the spreadsheet care about.
 */

export interface ValuedItem {
  name: string;
  quantity: number;
  marketable: boolean;
  tradable: boolean;
  type: string;
  /** Current market price for a single unit, null when unknown. */
  unitPrice: number | null;
  /** unitPrice multiplied by quantity. */
  totalPrice: number | null;
  /** What the position would pay out after Steam's cut. */
  netAfterFee: number | null;
  priceSource: string | null;
  priceUpdatedAt: number | null;
}

export interface ValuationResult {
  steamId: string;
  currency: string;
  fetchedAt: number;
  fromCache: boolean;
  uniqueItems: number;
  totalItems: number;
  /** Gross value at current market prices, marketable items only. */
  totalMarketValue: number;
  /** Payout after Steam's cut, marketable items only. */
  totalNetAfterFee: number;
  /** Names that no source could price. */
  unpriced: string[];
  steamLookupBlocked: boolean;
  items: ValuedItem[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function valueInventory(
  snapshot: InventorySnapshot,
): Promise<ValuationResult> {
  const { prices, missing, steamBlocked } = await resolvePrices(
    snapshot.items.map((item) => item.marketHashName),
  );

  let totalMarketValue = 0;
  let totalNetAfterFee = 0;

  const items: ValuedItem[] = snapshot.items.map((item) => {
    const price = prices.get(item.marketHashName);
    const unitPrice = price ? price.price : null;
    const totalPrice =
      unitPrice === null ? null : round(unitPrice * item.quantity);
    const net = totalPrice === null ? null : netAfterFee(totalPrice);

    // Non marketable items cannot be sold, so they stay out of the totals.
    if (item.marketable && totalPrice !== null && net !== null) {
      totalMarketValue += totalPrice;
      totalNetAfterFee += net;
    }

    return {
      name: item.marketHashName,
      quantity: item.quantity,
      marketable: item.marketable,
      tradable: item.tradable,
      type: item.type,
      unitPrice,
      totalPrice,
      netAfterFee: net,
      priceSource: price?.source ?? null,
      priceUpdatedAt: price?.updatedAt ?? null,
    };
  });

  // Most valuable positions first, unpriced items last.
  items.sort((a, b) => (b.totalPrice ?? -1) - (a.totalPrice ?? -1));

  return {
    steamId: snapshot.steamId,
    currency: config.currency,
    fetchedAt: snapshot.fetchedAt,
    fromCache: snapshot.fromCache,
    uniqueItems: snapshot.items.length,
    totalItems: snapshot.totalItems,
    totalMarketValue: round(totalMarketValue),
    totalNetAfterFee: round(totalNetAfterFee),
    unpriced: missing,
    steamLookupBlocked: steamBlocked,
    items,
  };
}

/** Escapes a single CSV field for consumers such as Google Sheets IMPORTDATA. */
function csvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Flat CSV representation. Numbers use a dot as decimal separator, which is
 * what Google Sheets expects from an imported data source.
 */
export function toCsv(result: ValuationResult): string {
  const header = [
    "market_hash_name",
    "quantity",
    "unit_price",
    "total_price",
    "net_after_fee",
    "currency",
    "marketable",
    "price_source",
    "price_updated_at",
  ].join(",");

  const rows = result.items.map((item) =>
    [
      csvField(item.name),
      csvField(item.quantity),
      csvField(item.unitPrice),
      csvField(item.totalPrice),
      csvField(item.netAfterFee),
      csvField(result.currency),
      csvField(item.marketable),
      csvField(item.priceSource),
      csvField(
        item.priceUpdatedAt
          ? new Date(item.priceUpdatedAt).toISOString()
          : null,
      ),
    ].join(","),
  );

  return [header, ...rows].join("\n");
}
