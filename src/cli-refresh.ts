import { countTrackedItems, trackItems } from "./db.js";
import { refreshPrices } from "./prices.js";
import { getInventory } from "./steamInventory.js";

/**
 * Warm-up and manual refresh: node dist/cli-refresh.js [steamid64]
 *
 * With a SteamID the inventory is read first and its item names are added to
 * the tracking list, which is how an empty database gets seeded. Without one,
 * only the names already tracked are refreshed.
 *
 * Runs batch after batch until nothing is due, so the first pass over a fresh
 * inventory can take several minutes.
 */

async function main(): Promise<void> {
  const steamId = process.argv[2];

  if (steamId) {
    console.log(`Reading inventory ${steamId} ...`);
    const snapshot = await getInventory(steamId, true);
    trackItems(
      snapshot.items.map((item) => item.marketHashName),
      Date.now(),
    );
    console.log(
      `Tracking ${snapshot.items.length} item names from that inventory.`,
    );
  }

  if (countTrackedItems() === 0) {
    console.log(
      "Nothing is being tracked yet. Pass your SteamID64 as an argument to seed " +
        "the list from your inventory.",
    );
    return;
  }

  for (;;) {
    const result = await refreshPrices();

    if (result.attempted === 0) {
      console.log("All tracked prices are current.");
      return;
    }
    if (result.steamBlocked) {
      console.log(
        `Steam is rate limiting; ${result.remaining} names are still due. ` +
          "Run this again in a few minutes, or let the service catch up on its own.",
      );
      return;
    }
    if (result.remaining === 0) {
      console.log("All tracked prices are current.");
      return;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(`Refresh failed: ${error.message}`);
    process.exit(1);
  });
