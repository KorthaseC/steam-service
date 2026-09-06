import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { db, pruneInventoryCache } from "./db.js";
import { startPriceWorker } from "./prices.js";
import { router } from "./routes.js";

/**
 * Application entrypoint. The server binds to loopback only and expects a
 * reverse proxy (Caddy) to handle TLS and the public hostname.
 */

const app = express();

// Required so rate limiting and logs see the real client IP behind Caddy.
app.set("trust proxy", config.trustProxyHops);
app.disable("x-powered-by");

app.use(helmet());
// Small limit: the largest legitimate body is a list of item names.
app.use(express.json({ limit: "128kb" }));

// Minimal request log without query strings, which would contain API keys.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms ` +
        `[${req.auth?.label ?? "anon"}]`,
    );
  });
  next();
});

app.use("/api", router);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Final safety net so no stack trace ever reaches a client.
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[server] unhandled error:", error);
    res.status(500).json({ error: "internal_error" });
  },
);

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(
    `[server] currency ${config.currency}, ${config.guestKeys.size} guest key(s) configured`,
  );
});

const priceTimer = startPriceWorker();

// Inventory snapshots older than a day are of no use to anybody.
const pruneTimer = setInterval(
  () => pruneInventoryCache(24 * 60 * 60 * 1000),
  60 * 60 * 1000,
);
pruneTimer.unref();

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`);
  clearInterval(priceTimer);
  clearInterval(pruneTimer);
  server.close(() => {
    // Closing checkpoints the write ahead log, so no .wal file is left behind.
    db.close();
    process.exit(0);
  });
  // Force exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
