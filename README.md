# CS Price Service

A self-hosted HTTP API that values public CS2 Steam inventories and serves
current Steam Market prices from a local cache. Ships with an example Google
Apps Script client so a spreadsheet can pull live prices into a buy/sell log.

- **Runtime:** Node.js 20+ (tested on 22), TypeScript, Express
- **Storage:** SQLite (`better-sqlite3`), a single file, no external database
- **Deployment:** binds to loopback, meant to sit behind a reverse proxy

## How pricing works

Steam has no bulk price feed. The endpoints that exist are strictly limited:
`priceoverview` answers for one item at a time, and the market search that
returns 100 items per call gets throttled after a handful of pages. Crawling
the roughly 35,000 item CS2 catalogue is not viable — a full pass would take
the better part of a day and keep the server permanently rate limited.

So pricing is **demand driven**:

- Every item name that appears in a request is recorded in `tracked_items`.
- A background cycle refreshes the oldest tracked prices, a batch at a time,
  serialised with a delay between lookups.
- Requests are answered from SQLite. Names with no price yet are looked up
  immediately, up to a small per-request budget; the rest arrive with the next
  cycle.
- Names that fail repeatedly (medals, coins, badges — items that have no market
  listing at all) drop out of the queue instead of being retried forever.

The practical effect: a few hundred names, not tens of thousands, and each one
stays current within `PRICE_MAX_AGE_HOURS`.

## Talking to Steam

Steam answers `429` based on **who is asking**, not only how often. This cost
hours to work out, so it is worth writing down:

| Client identity                                                              | Result |
| ---------------------------------------------------------------------------- | ------ |
| No user agent                                                                | 429    |
| Custom user agent (`cs-price-service/1.0`)                                   | 429    |
| Known tool signature (`curl/8.5.0`, `Wget/1.21.4`, `python-requests/2.31.0`) | 200    |
| Browser user agent, nothing else                                             | 429    |
| Browser user agent plus the matching browser headers                         | 200    |

A browser string on its own is the worst of both worlds. `src/steamHeaders.ts`
therefore sends a coherent set — user agent, client hints, `Sec-Fetch-*` — and
both Steam clients use it. `Accept-Encoding` is deliberately left out: Node
sets and handles it itself, and overriding it risks a compressed body that
never gets unpacked.

`STEAM_USER_AGENT` and `STEAM_SEC_CH_UA` are configurable and belong together —
the client hint has to name the same major version as the user agent. If Steam
starts refusing the pair, bump both.

## How a request flows

```
GET /api/inventory/:steamId
  |- rate limit  per client address (IPv6 bucketed per /64), pre-auth
  |- auth        verify API key (constant-time), assign guest/admin level
  |- rate limit  per key, guest and admin budgets kept apart
  |- inventory   SQLite cache hit? -> use it
  |              otherwise fetch steamcommunity.com/inventory, paginated in
  |              small pages, join assets <-> descriptions, aggregate
  |- tracking    every name is recorded for future refresh cycles
  |- pricing     bulk SELECT from the prices table
  |              names still missing: throttled direct lookups, capped
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

# Seed the tracking list from your own inventory and price it. The first pass
# takes a few minutes; it can be re-run safely and picks up where it stopped.
node dist/cli-refresh.js <your-steamid64>

npm start
```

For development: `npm run dev` (tsx watch mode).

### Running as a service

`deploy/cs-price-service.service` is a systemd unit to start from.

```bash
sudo useradd --system --home /opt/cs-price-service --shell /usr/sbin/nologin csprices
sudo mkdir -p /opt/cs-price-service
# copy the project there, then:
sudo chown -R csprices:csprices /opt/cs-price-service

sudo cp deploy/cs-price-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cs-price-service
sudo journalctl -u cs-price-service -f
```

The unit expects the app at `/opt/cs-price-service` running as user `csprices`,
with `data/` as the only writable path — adjust both if you deploy elsewhere.

Update routine, in this order: `git pull`, `npm run build`,
`chown -R csprices:csprices .`, `systemctl restart cs-price-service`. The chown
matters — a build run as root leaves `dist/` unreadable for the service user.

### Reverse proxy requirements

No proxy configuration is shipped; that part is deployment-specific. Whatever
you put in front of the service has to:

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

| Variable                         | Default    | Purpose                                                          |
| -------------------------------- | ---------- | ---------------------------------------------------------------- |
| `ADMIN_KEY`                      | _required_ | Full access. Minimum 32 characters.                              |
| `GUEST_KEYS`                     | empty      | `key:label,key:label`. Each key >= 24 characters, labels unique. |
| `CURRENCY`                       | `EUR`      | `EUR` or `USD`. Steam returns it directly, nothing is converted. |
| `PRICE_REFRESH_MINUTES`          | `60`       | How often the background cycle runs.                             |
| `PRICE_MAX_AGE_HOURS`            | `12`       | A price older than this is queued for refresh.                   |
| `PRICE_REFRESH_BATCH`            | `150`      | Lookups per cycle. At 4s each, roughly ten minutes.              |
| `MAX_LOOKUP_FAILURES`            | `5`        | Failures in a row before a name leaves the queue.                |
| `TRACKED_RETENTION_DAYS`         | `30`       | Names nobody asked about are forgotten.                          |
| `STEAM_FALLBACK_DELAY_MS`        | `4000`     | Delay between direct Steam lookups.                              |
| `STEAM_FALLBACK_MAX_PER_REQUEST` | `15`       | Lookups a single request may trigger.                            |
| `STEAM_USER_AGENT`               | Chrome 124 | See _Talking to Steam_.                                          |
| `STEAM_SEC_CH_UA`                | Chrome 124 | Must match the user agent's major version.                       |
| `INVENTORY_PAGE_SIZE`            | `75`       | Items per inventory page.                                        |
| `INVENTORY_MAX_PAGES`            | `40`       | Page size × this is the item ceiling.                            |
| `INVENTORY_CACHE_MINUTES`        | `10`       | Raise this if Steam starts blocking you.                         |
| `STEAM_FEE_DIVISOR`              | `1.15`     | Net proceeds = price / this value.                               |
| `IP_RATE_MAX`                    | `300`      | Requests per address before auth. Keep above per-key limits.     |
| `GUEST_RATE_MAX`                 | `20`       | Guest requests per rate-limit window.                            |
| `ENABLE_HISTORY`                 | `true`     | Store one price point per item per day.                          |

Invalid or missing critical values abort startup rather than failing later at
request time.

## API

Authentication: `Authorization: Bearer <key>`. A `?key=<key>` query parameter is
accepted as a fallback for clients that cannot send headers — see the note under
_Security model_ first.

| Method | Path                        | Access | Purpose                                        |
| ------ | --------------------------- | ------ | ---------------------------------------------- |
| GET    | `/api/health`               | open   | Liveness and cache state                       |
| GET    | `/api/inventory/:steamId`   | guest  | Value a public inventory                       |
| GET    | `/api/portfolio/:steamId`   | admin  | Same data, plus `?format=csv` and `?refresh=1` |
| POST   | `/api/prices/lookup`        | admin  | Prices for a list of names (max 500)           |
| POST   | `/api/admin/refresh-prices` | admin  | Run a refresh cycle now                        |
| GET    | `/api/admin/status`         | admin  | Cache, tracking and queue state                |

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
    "uniqueItems": 309,
    "totalItems": 596,
    "totalMarketValue": 2069.44,
    "totalNetAfterFee": 1799.7,
    "unpricedItems": 21
  },
  "meta": {
    "inventoryFetchedAt": "2026-09-06T10:15:21.000Z",
    "inventoryFromCache": false,
    "pricesStale": false,
    "lastPriceRefresh": "2026-09-06T10:16:34.000Z"
  },
  "items": [
    {
      "name": "AK-47 | Redline (Field-Tested)",
      "quantity": 2,
      "unitPrice": 12.4,
      "totalPrice": 24.8,
      "netAfterFee": 21.57,
      "marketable": true,
      "priceSource": "steam"
    }
  ]
}
```

`netAfterFee` is what a sale actually pays out after Steam's cut (~15%).
Non-marketable items are listed but excluded from the totals, because they
cannot be sold — medals, coins and badges land here, which is why a healthy
response still reports a handful of `unpricedItems`.

`pricesStale` means the refresh cycle itself has stopped running, not that an
individual price is old.

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
  bucketed per /64, because a single host usually controls the whole prefix.
- **No query strings in the application log**, since the `?key=` fallback would
  otherwise write API keys to disk. Your reverse proxy needs the equivalent
  filter, or drop the fallback from `auth.ts` if no client needs it.
- **No stack traces** in responses, no `X-Powered-By`, `helmet` enabled.
- **systemd hardening**: `ProtectSystem=strict`, dedicated user, only `data/`
  writable.

Distribute guest keys over a channel you trust, and keep `ADMIN_KEY` out of the
repository and out of any spreadsheet cell.

What a guest key does **not** restrict: it is not bound to a SteamID, so anyone
holding one can value any public inventory, not just their own. Everything it
returns is public Steam data, but the requests go out over your server's IP. If
that matters, lower `GUEST_RATE_MAX` or extend `GUEST_KEYS` to carry an allowed
SteamID per key.

## Google Sheets integration

`apps-script/Code.gs` is an **example** client, not a drop-in: Google's servers
cannot reach Steam, but they can reach your server. Expect to adapt it to your
own sheet.

1. In the spreadsheet, open _Extensions -> Apps Script_ and paste the file.
2. Adjust the constants at the top: sheet name, header and first data row,
   column letters, your SteamID64.
3. Run `setup()` from the spreadsheet menu — not from the editor, since it opens
   a dialog. URL and admin key go into Script Properties, not into a cell.
4. Reload the spreadsheet and use the menu.

Two things that will bite otherwise:

- **Script Properties are readable by anyone with edit access** to the
  spreadsheet. They protect the key against viewers, not against collaborators.
- **Generated formulas need the sheet's argument separator.** A locale that
  uses the comma as decimal separator expects `;` between arguments. The script
  has a `FORMULA_SEPARATOR` constant for this; getting it wrong produces a
  parse error in every generated formula.

Names in the log must match the Steam `market_hash_name` exactly, including the
wear in parentheses. Unmatched rows are left empty rather than zeroed, and are
listed after each run.

## Known limitations

- Prices are market averages, not quotes for your specific item. Float value,
  pattern, rare stickers and name tags are not reflected — for knives and
  expensive skins the deviation can be substantial.
- Only names that have been asked about are tracked. A brand new item is
  unpriced on first sight and gets its price during the request or shortly
  after, not instantly.
- The inventory must be public, otherwise Steam answers `inventory_private`.
- A request needing many direct lookups can take a minute or more
  (`STEAM_FALLBACK_MAX_PER_REQUEST` × `STEAM_FALLBACK_DELAY_MS`).

## Project layout

```
src/
  server.ts            Express app, middleware, timers, graceful shutdown
  routes.ts            All HTTP endpoints and rate limiters
  auth.ts              Key extraction, constant-time verification, levels
  config.ts            Environment parsing and validation
  db.ts                SQLite schema, prepared statements, tracking queue
  prices.ts            Price cache: refresh cycle, lookups, fee maths
  steamHeaders.ts      The client identity every Steam request sends
  steamInventory.ts    Inventory fetch, pagination, aggregation, cache
  valuation.ts         Inventory x prices -> totals, plus CSV output
  cli-refresh.ts       Seed and refresh from the command line
  sources/
    steamMarket.ts     Throttled priceoverview lookups
apps-script/Code.gs    Example Google Sheets client
deploy/                systemd unit
docs/guests.md         Handout for people you give a guest key to
```

## License

No license file is included, which means all rights reserved by default. Add one
before publishing if you want others to reuse this.
