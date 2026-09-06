# CS Price Service

A self-hosted HTTP API that values public CS2 Steam inventories and serves
current Steam Market prices from a local cache. Ships with an optional Google
Apps Script client so a spreadsheet can pull live prices into a buy/sell log.

- **Runtime:** Node.js 20+ (tested on 22; `better-sqlite3` ships prebuilt
  binaries for the LTS lines, newer versions may have to compile from source),
  TypeScript, Express
- **Storage:** SQLite (`better-sqlite3`), a single file, no external database
- **Deployment:** binds to loopback, meant to sit behind a reverse proxy

## Why it is built this way

Steam's `priceoverview` endpoint allows roughly 20 requests per minute per IP
and blocks the caller for minutes afterwards. Valuing a 200-item inventory one
request at a time is therefore not viable. Instead:

- A background worker downloads a **bulk price dump** of the entire CS2
  catalogue every 30 minutes into local SQLite. All requests are answered from
  that cache.
- Only names **missing** from the dump (a case released yesterday, say) are
  queried at Steam directly — strictly serialised, with a fixed delay between
  calls and a 5-minute backoff after a `429`.
- Inventories are cached per SteamID for 10 minutes, so repeated requests do not
  hit Steam again.

## How a request flows

```
GET /api/inventory/:steamId
  |- rate limit  per client address (IPv6 bucketed per /64), pre-auth
  |- auth        verify API key (constant-time), assign guest/admin level
  |- rate limit  per key, guest and admin budgets kept apart
  |- inventory   SQLite cache hit? -> use it
  |              otherwise fetch steamcommunity.com/inventory (paginated),
  |              join assets <-> descriptions, aggregate to name + quantity
  |- pricing     bulk SELECT from the prices table
  |              for names still missing: throttled direct Steam lookups,
  |              capped per request, results written back to the cache
  |- valuation   unit price x quantity, minus Steam's fee, totals over
  |              marketable items only, sorted by position value
  |- JSON response
```

## Installation

```bash
git clone <this-repo> cs-price-service
cd cs-price-service

npm install
npm run build

cp .env.example .env
openssl rand -hex 32        # -> ADMIN_KEY
openssl rand -hex 24        # -> one GUEST_KEY per person
$EDITOR .env

npm run refresh             # fill the price cache once (~1 min)
npm start
```

For development: `npm run dev` (tsx watch mode).

### Running as a service

`deploy/cs-price-service.service` is a systemd unit to start from.

```bash
sudo useradd --system --home /opt/cs-price-service --shell /usr/sbin/nologin csprices
sudo mkdir -p /opt/cs-price-service
# copy the built project there, then:
sudo chown -R csprices:csprices /opt/cs-price-service

sudo cp deploy/cs-price-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cs-price-service
sudo journalctl -u cs-price-service -f
```

The unit expects the app at `/opt/cs-price-service` running as user `csprices`,
with `data/` as the only writable path — adjust both if you deploy elsewhere.

### Reverse proxy requirements

No proxy configuration is shipped; that part is deployment-specific and left to
you. Whatever you put in front of the service has to:

- terminate TLS and forward to `127.0.0.1:8087`
- set `X-Forwarded-For`, with `TRUST_PROXY_HOPS` matching the number of proxies,
  otherwise rate limiting buckets every client into a single address
- keep the `key` query parameter out of the access log if you use the `?key=`
  fallback — proxies log the full URI including the query by default
- allow a response timeout above `STEAM_FALLBACK_MAX_PER_REQUEST` ×
  `STEAM_FALLBACK_DELAY_MS`, or lower that cap
- optionally return 404 for anything outside `/api/*`, which drops scanner
  traffic before it reaches the application

## Configuration

Every option is set through the environment; `.env.example` documents all of
them. The ones you are most likely to change:

| Variable                         | Default    | Purpose                                                             |
| -------------------------------- | ---------- | ------------------------------------------------------------------- |
| `ADMIN_KEY`                      | _required_ | Full access. Minimum 32 characters.                                 |
| `GUEST_KEYS`                     | empty      | `key:label,key:label`. Each key >= 24 characters.                   |
| `CURRENCY`                       | `EUR`      | `EUR` or `USD`.                                                     |
| `PRICE_REFRESH_MINUTES`          | `30`       | Bulk dump refresh interval.                                         |
| `PRICE_STALE_MINUTES`            | `180`      | Older prices are still served, but flagged.                         |
| `INVENTORY_CACHE_MINUTES`        | `10`       | Raise this if Steam starts blocking you.                            |
| `STEAM_FEE_DIVISOR`              | `1.15`     | Net proceeds = price / this value.                                  |
| `STEAM_FALLBACK_MAX_PER_REQUEST` | `15`       | Cap on direct Steam lookups per request.                            |
| `IP_RATE_MAX`                    | `300`      | Requests per address before auth. Keep it above the per-key limits. |
| `GUEST_RATE_MAX`                 | `20`       | Guest requests per rate-limit window.                               |
| `ENABLE_HISTORY`                 | `true`     | Store one price point per item per day.                             |

Invalid or missing critical values abort startup rather than failing later at
request time.

## API

Authentication: `Authorization: Bearer <key>`. A `?key=<key>` query parameter is
accepted as a fallback for clients that cannot send headers (Google Sheets
`IMPORTDATA`, for instance) — see the note under _Security model_ first.

| Method | Path                        | Access | Purpose                                        |
| ------ | --------------------------- | ------ | ---------------------------------------------- |
| GET    | `/api/health`               | open   | Liveness and cache state                       |
| GET    | `/api/inventory/:steamId`   | guest  | Value a public inventory                       |
| GET    | `/api/portfolio/:steamId`   | admin  | Same data, plus `?format=csv` and `?refresh=1` |
| POST   | `/api/prices/lookup`        | admin  | Prices for a list of names (max 500)           |
| POST   | `/api/admin/refresh-prices` | admin  | Force a price refresh                          |
| GET    | `/api/admin/status`         | admin  | Detailed cache status                          |

```bash
curl -H "Authorization: Bearer $GUEST_KEY" \
  https://prices.example.com/api/inventory/76561198000000000
```

Response (abridged):

```json
{
  "steamId": "76561198000000000",
  "currency": "EUR",
  "summary": {
    "uniqueItems": 143,
    "totalItems": 271,
    "totalMarketValue": 1842.55,
    "totalNetAfterFee": 1602.22,
    "unpricedItems": 3
  },
  "meta": {
    "inventoryFetchedAt": "2024-01-01T12:00:00.000Z",
    "inventoryFromCache": false,
    "pricesStale": false,
    "lastPriceRefresh": "2024-01-01T11:45:00.000Z"
  },
  "items": [
    {
      "name": "AK-47 | Redline (Field-Tested)",
      "quantity": 2,
      "unitPrice": 12.4,
      "totalPrice": 24.8,
      "netAfterFee": 21.57,
      "marketable": true,
      "priceSource": "bulk"
    }
  ]
}
```

`netAfterFee` is what a sale actually pays out after Steam's cut (~15%).
Non-marketable items are listed but excluded from the totals, because they
cannot be sold.

`POST /api/prices/lookup` takes `{ "names": ["AK-47 | Redline (Field-Tested)"] }`
and returns a `prices` map plus a `missing` array of names no source could
price.

Error codes: `invalid_steamid`, `inventory_private`, `inventory_empty`,
`steam_rate_limited`, `steam_unavailable`, `rate_limited`, `missing_api_key`,
`invalid_api_key`, `admin_key_required`, `invalid_body`, `too_many_names`.

## Security model

- **Loopback only.** The app binds `127.0.0.1`; TLS and public exposure are the
  reverse proxy's job.
- **Two key levels.** A guest key can do exactly one thing: value an explicitly
  requested public inventory. Portfolio, lookup and admin endpoints require the
  admin key.
- **One key per person.** `GUEST_KEYS` holds `key:label` pairs, so revoking one
  person means deleting one entry and restarting. Labels double as rate-limit
  buckets, so give each entry a distinct one.
- **Constant-time key comparison**, so response timing does not reveal how many
  leading characters of a guessed key were correct.
- **No SSRF surface.** SteamIDs are validated against `^7656119\d{10}$` before
  anything happens. No parameter lets a caller influence a URL, host or path.
- **Two-stage rate limiting.** An address-based limiter runs _before_
  authentication, so wrong keys and the open health endpoint are bounded too;
  per-key limiters then apply separately for guest and admin. IPv6 clients are
  bucketed per /64, because a single host usually controls the whole prefix and
  could otherwise rotate addresses to escape the limit.
- **No query strings in the application log**, since the `?key=` fallback would
  otherwise write API keys to disk. Your reverse proxy needs the equivalent
  filter — see _Reverse proxy requirements_ — or drop the fallback from
  `auth.ts` if no client needs it.
- **No stack traces** in responses, no `X-Powered-By`, `helmet` enabled.
- **systemd hardening**: `ProtectSystem=strict`, dedicated user, only `data/`
  writable.

Distribute guest keys over a channel you trust, and keep `ADMIN_KEY` out of the
repository and out of any spreadsheet cell.

What a guest key does **not** restrict: it is not bound to a SteamID, so anyone
holding one can value any public inventory, not just their own. If that matters,
either lower `GUEST_RATE_MAX` or extend `GUEST_KEYS` to carry an allowed
SteamID per key.

## Google Sheets integration

`apps-script/Code.gs` is an optional client. Google's servers cannot reach
Steam, but they can reach your server.

1. In the spreadsheet, open _Extensions -> Apps Script_ and paste the file.
2. Adjust the constants at the top: sheet names, column letters, your SteamID64.
3. Run `setup()` once and enter the base URL (`https://.../api`) and the admin
   key. Both go into Script Properties, not into a cell.
4. Reload the spreadsheet — a "CS Prices" menu appears.

Menu actions:

- **Refresh prices in the purchase log** — reads the name column of your
  existing log, fetches prices in batches, and writes market price and net
  proceeds into two columns. Your purchase prices are never touched.
- **Reload inventory** — writes current holdings and totals into a separate
  sheet. That sheet is cleared on every run, so keep manual notes elsewhere.

`installDailyTrigger()` optionally schedules the price refresh once a day.

Names in your log must match the Steam `market_hash_name` exactly, including the
wear in parentheses. Unmatched rows are left empty rather than zeroed, and are
reported in the toast message.

> The menu labels and default sheet names in `Code.gs` are German. Change the
> strings at the top of the file and in `onOpen()` for another language.

## Known limitations

- Prices are market averages, not quotes for your specific item. Float value,
  pattern, rare stickers and name tags are not reflected — for knives and
  expensive skins the deviation can be substantial.
- The bulk dump is a third-party service. If it goes down, the last known prices
  stay in the cache and responses are flagged `pricesStale: true`. A second
  adapter can be added in `src/sources/` following the same shape.
- The inventory must be public, otherwise Steam answers `inventory_private`.
- A request needing many direct Steam lookups can take a minute or more
  (`STEAM_FALLBACK_MAX_PER_REQUEST` x `STEAM_FALLBACK_DELAY_MS`).

## Project layout

```
src/
  server.ts            Express app, middleware, timers, graceful shutdown
  routes.ts            All HTTP endpoints and rate limiters
  auth.ts              Key extraction, constant-time verification, levels
  config.ts            Environment parsing and validation
  db.ts                SQLite schema and prepared statements
  prices.ts            Price cache: refresh loop, lookups, fee maths
  fx.ts                USD->EUR rate, cached 12h with a static fallback
  steamInventory.ts    Steam inventory fetch, pagination, aggregation, cache
  valuation.ts         Inventory x prices -> totals, plus CSV output
  cli-refresh.ts       One-off refresh (npm run refresh)
  sources/
    bulkDump.ts        Bulk catalogue dump adapter
    steamMarket.ts     Throttled direct Steam priceoverview adapter
apps-script/Code.gs    Optional Google Sheets client
deploy/                systemd unit
```
