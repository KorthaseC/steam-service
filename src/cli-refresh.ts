import { refreshPrices } from "./prices.js";

/**
 * One-off price refresh, useful for filling the database before the service
 * is started for the first time: npm run refresh
 */
refreshPrices()
  .then((result) => {
    console.log(
      `Stored ${result.itemCount} prices in ${result.durationMs}ms ` +
        `(exchange rate ${result.rate} via ${result.rateSource})`,
    );
    process.exit(0);
  })
  .catch((error: Error) => {
    console.error(`Refresh failed: ${error.message}`);
    process.exit(1);
  });
