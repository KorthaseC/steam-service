# Steam Service

A self-hosted HTTP API around public Steam data. Two feature sets share one
process, one database and one deployment:

- **Inventory valuation** — values public CS2 inventories against current Steam
  Market prices from a local cache. Ships with an example Google Apps Script
  client so a spreadsheet can pull live prices into a buy/sell log.
- **Library and completion times** — resolves a Steam profile, lists the games
  it owns, and matches them against HowLongToBeat, so the question _"I have
  eight hours, which of my games can I actually finish?"_ has an answer. This is
  the backend for the Steam Expander Overviewer web frontend, which lives in its
  own repository.

They share the demand-driven caching approach described below, and either can be
switched off through configuration without touching the other.

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
| Custom user agent naming this service                                        | 429    |
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

## Steam libraries and completion times

Reading a library needs the official Web API (`STEAM_API_KEY`): resolving a
vanity name, reading a profile and listing owned games all require a key, and
none of those endpoints send CORS headers, which is the whole reason a browser
frontend needs this server at all.

Completion times come from **HowLongToBeat, which has no public API**. What this
does instead is what their own web app does, verified against the live site:

1. `GET /api/search/site/init` returns `{ token, hpKey, hpVal }`.
2. `POST /api/search/site` sends that token as `x-auth-token`, the `hpKey` and
   `hpVal` pair as _both_ headers and a field inside the JSON body — sending it
   in only one of the two places is rejected — and gets back search results.
3. A `403` means the token expired: fetch a new one and retry once.

The token encodes the caller's IP address **and** User-Agent, so the init call
and the search using it have to present the same `User-Agent` header.

This is scraping and it will break. All of it lives in
`src/sources/howLongToBeat.ts`, `HLTB_ENABLED=false` turns it off without a
deploy, and a failure degrades to "no completion times" rather than to a failed
request for the whole library.

### Matching a Steam game to a HowLongToBeat entry

Getting this wrong is silent — a mismatched game shows plausible but wrong
times. Matching therefore runs cheapest-first and only escalates when unsure:

1. Exact comparison of normalised titles, against the title and HLTB's alias
   field. Normalising folds accents, spells out `&`, drops punctuation, and
   strips `™`/`®` **before** Unicode normalisation, which would otherwise expand
   `™` into the letters `TM` and turn `PAYDAY™ 2` into `paydaytm 2`.
2. The same comparison with edition wording removed, since Steam writes
   _Skyrim Special Edition_ where HowLongToBeat writes _Skyrim_. Only a second
   attempt, because _Remastered_ can be a genuinely separate entry.
3. Still ambiguous: fetch the candidate's detail page and compare its
   `profile_steam` field against the Steam AppID. That is authoritative. Capped
   at two candidates so an unmatchable library cannot triple the request volume.

In practice nearly everything resolves at step 1 for a single request per game.
A game that resolves to nothing is cached as _unmatched_ — remembering the miss
is what stops a library full of multiplayer titles from being searched forever.

### Why the times arrive late

A library of several hundred games cannot be resolved inside one request:
throttled lookups would take far longer than any sensible timeout. So the
library endpoint answers immediately with `hltb: null` for anything uncached,
records those games, and a background worker fills them in — the same
demand-driven shape as pricing. The frontend polls until nothing is pending.
At the default settings a 500-game library completes in roughly 25 minutes.

### Why the store details do not

Store tags, review summaries and capsule image paths look like a second case of
the same problem and are not one. All three come from a single call to the API
the Steam store front-end itself uses, which answers **200 AppIDs in about half
a second** — a 500-game library is three requests and roughly a second and a
half, so they are resolved inside the library request with no worker, no queue
and nothing to poll.

The endpoint is undocumented and needs no API key. That combination argues for
treating everything from it as a garnish: a failure empties tags and reviews,
falls back to derived image URLs and is logged, but never fails the library
request, and `STORE_TAGS_ENABLED=false` turns the whole thing off with the same
visible result. Records are refreshed at the shorter of `STORE_TAG_MAX_AGE_DAYS`
and `STORE_REVIEW_MAX_AGE_DAYS`, since both parts arrive together. Tag names are localised
and cached per language; the vocabulary is one 16 kB request for about 450
tags, refreshed monthly and skipped entirely when Steam's `version_hash` has
not moved.

It is GET-only, and the request is a JSON blob in a query parameter, so the
batch ceiling is URL length rather than a documented item count: 240 AppIDs
still answer, 300 come back `414 URI Too Long`. `STORE_TAG_BATCH_SIZE` defaults
to 200 and is clamped to 240 in code.

### Why images need the store lookup

The obvious capsule URL, `store_item_assets/steam/apps/<appid>/capsule_231x87.jpg`,
only exists for older store art. Art uploaded or replaced more recently lives
below a content hash — `steam/apps/<appid>/<hash>/capsule_231x87.jpg` — and the
AppID-derived URL returns a 404 for those games, which is most of what was
released in the last couple of years. The hash cannot be derived; the store
lookup reports it in `assets.asset_url_format` plus a filename.

`capsuleUrl` therefore uses the reported path when there is one and the derived
URL otherwise. A game that has left the store usually has neither, so each game
also carries `iconUrl`, the square community icon addressed by the hash
`GetOwnedGames` sends. The frontend walks that chain on image errors. Reported
paths are validated strictly before use — relative, image extension, no `..`,
no scheme — and stored relative to `STORE_ASSET_BASE`, so a move of the asset
host is a configuration change rather than a refetch.

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

```
GET /api/steam/library/:ref
  |- rate limit  per client address, pre-auth
  |- auth        bearer key, else signed session cookie -> guest level
  |- rate limit  per key or session label
  |- parse       :ref -> SteamID64 or vanity name, anything else refused
  |- resolve     vanity -> SteamID64 via the Web API, cached both ways
  |              (a remembered miss stops a typo hitting Steam every reload)
  |- refresh     ?refresh=1 and outside the per-SteamID cooldown?
  |              -> skip the profile and library caches below
  |- profile     SQLite cache hit? -> use it, otherwise GetPlayerSummaries
  |              (public: PROFILE_CACHE_MINUTES, private: seconds only)
  |              private profile -> 403 before any library call happens
  |- library     SQLite cache hit? -> use it, otherwise GetOwnedGames
  |- tracking    every AppID is recorded for the completion-time worker
  |- times       bulk SELECT from hltb_games; unknown games stay null
  |- store       cached tags, reviews, image paths; missing ones fetched now,
  |              200 AppIDs a request
  |              (failure here empties the field, it never fails the request)
  |- kick        worker started in the background if anything is pending
  |- JSON response, immediately
```

## Installation

```bash
git clone <this-repo> steam-service
cd steam-service

npm install
npm run build

cp .env.example .env
openssl rand -hex 32        # -> ADMIN_KEY
openssl rand -hex 24        # -> one GUEST_KEY per person
openssl rand -hex 32        # -> SESSION_SECRET, if you run the web frontend
$EDITOR .env

# For the library features, add a Steam Web API key from
# https://steamcommunity.com/dev/apikey  ->  STEAM_API_KEY
# and one ACCESS_CODES entry per person who should reach the frontend.

# Seed the tracking list from your own inventory and price it. The first pass
# takes a few minutes; it can be re-run safely and picks up where it stopped.
node dist/cli-refresh.js <your-steamid64>

npm start
```

For development: `npm run dev` (tsx watch mode).

### Running as a service

`deploy/steam-service.service` is a systemd unit to start from.

```bash
sudo useradd --system --home /opt/steam-service --shell /usr/sbin/nologin csprices
sudo mkdir -p /opt/steam-service
# copy the project there, then:
sudo chown -R csprices:csprices /opt/steam-service

sudo cp deploy/steam-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now steam-service
sudo journalctl -u steam-service -f
```

The unit expects the app at `/opt/steam-service` running as user `csprices`,
with `data/` as the only writable path — adjust both if you deploy elsewhere.

The three paths in the unit and the directory you actually deploy to have to
match; nothing else depends on the name. An installation that predates the
rename to `steam-service` keeps working under its old path and unit name — there
is no need to migrate it, and `git pull` into the old directory is unaffected.

Update routine, in this order: `git pull`, `npm run build`,
`chown -R csprices:csprices .`, `systemctl restart steam-service`. The chown
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

If you also serve the web frontend, serve it from the **same origin** — the
static build at `/`, this service at `/api/*`. That is what the session cookie
assumes, and it means no CORS configuration exists anywhere. Replace the
"404 outside `/api/*`" rule with a file server plus an SPA fallback:

```caddy
handle /api/* {
    reverse_proxy 127.0.0.1:8087
}
handle {
    root * /var/www/steam-expander/browser
    try_files {path} /index.html
    file_server
}
```

For local frontend development, do not add CORS — point the Angular dev server's
`proxyConfig` at `http://localhost:8087` so it stays same-origin, and run the
backend with `COOKIE_SECURE=false`. `docs/backend-contract.md` has the config.

## Configuration

Every option is set through the environment; `.env.example` documents all of
them. The ones you are most likely to change:

| Variable                           | Default    | Purpose                                                            |
| ---------------------------------- | ---------- | ------------------------------------------------------------------ |
| `ADMIN_KEY`                        | _required_ | Full access. Minimum 32 characters.                                |
| `GUEST_KEYS`                       | empty      | `key:label,key:label`. Each key >= 24 characters, labels unique.   |
| `CURRENCY`                         | `EUR`      | `EUR` or `USD`. Steam returns it directly, nothing is converted.   |
| `PRICE_REFRESH_MINUTES`            | `60`       | How often the background cycle runs.                               |
| `PRICE_MAX_AGE_HOURS`              | `12`       | A price older than this is queued for refresh.                     |
| `PRICE_REFRESH_BATCH`              | `150`      | Lookups per cycle. At 4s each, roughly ten minutes.                |
| `MAX_LOOKUP_FAILURES`              | `5`        | Failures in a row before a name leaves the queue.                  |
| `TRACKED_RETENTION_DAYS`           | `30`       | Names nobody asked about are forgotten.                            |
| `STEAM_FALLBACK_DELAY_MS`          | `4000`     | Delay between direct Steam lookups.                                |
| `STEAM_FALLBACK_MAX_PER_REQUEST`   | `15`       | Lookups a single request may trigger.                              |
| `STEAM_USER_AGENT`                 | Chrome 124 | See _Talking to Steam_.                                            |
| `STEAM_SEC_CH_UA`                  | Chrome 124 | Must match the user agent's major version.                         |
| `INVENTORY_PAGE_SIZE`              | `75`       | Items per inventory page.                                          |
| `INVENTORY_MAX_PAGES`              | `40`       | Page size × this is the item ceiling.                              |
| `INVENTORY_CACHE_MINUTES`          | `10`       | Raise this if Steam starts blocking you.                           |
| `STEAM_FEE_DIVISOR`                | `1.15`     | Net proceeds = price / this value.                                 |
| `IP_RATE_MAX`                      | `300`      | Requests per address before auth. Keep above per-key limits.       |
| `GUEST_RATE_MAX`                   | `20`       | Guest requests per rate-limit window.                              |
| `ENABLE_HISTORY`                   | `true`     | Store one price point per item per day.                            |
| `STEAM_API_KEY`                    | empty      | Web API key. Empty disables the library endpoints (503).           |
| `ACCESS_CODES`                     | empty      | `code:label,…` for the frontend login. Each >= 12 characters.      |
| `SESSION_SECRET`                   | empty      | Cookie signing key, >= 32 characters. Required with access codes.  |
| `SESSION_TTL_DAYS`                 | `30`       | Cookie lifetime.                                                   |
| `COOKIE_SECURE`                    | `true`     | Only false for local development over plain http.                  |
| `LOGIN_RATE_MAX`                   | `10`       | Login attempts per address per 15 minutes.                         |
| `SESSION_RATE_MAX`                 | `120`      | Requests per signed-in browser per window.                         |
| `LIBRARY_CACHE_MINUTES`            | `60`       | Libraries change slowly; this saves Web API calls.                 |
| `PRIVATE_PROFILE_CACHE_SECONDS`    | `20`       | How long a private profile stays cached as private.                |
| `LIBRARY_REFRESH_COOLDOWN_SECONDS` | `60`       | Minimum gap between two `?refresh=1` for the same SteamID.         |
| `HLTB_ENABLED`                     | `true`     | Emergency switch for all HowLongToBeat traffic.                    |
| `HLTB_BATCH_SIZE`                  | `40`       | Games per worker cycle. Batch × delay should fit the interval.     |
| `HLTB_DELAY_MS`                    | `3000`     | Delay between HowLongToBeat requests.                              |
| `HLTB_MAX_AGE_DAYS`                | `90`       | Completion times barely change.                                    |
| `STORE_TAGS_ENABLED`               | `true`     | Emergency switch for store tags, reviews and image paths.          |
| `STORE_TAG_LANGUAGE`               | `german`   | Tag names are localised and cached per language.                   |
| `STORE_TAGS_PER_GAME`              | `6`        | Top N tags, in Steam's own agreement order.                        |
| `STORE_TAG_BATCH_SIZE`             | `200`      | AppIDs per request. Clamped to 240: above that Steam answers 414.  |
| `STORE_TAG_MAX_AGE_DAYS`           | `30`       | Tags drift slowly; a game does not change genre.                   |
| `STORE_TAG_BUDGET_MS`              | `8000`     | Time store details may spend in one request before the rest waits. |
| `STORE_REVIEW_MAX_AGE_DAYS`        | `7`        | Review summaries move faster than tags; shorter limit wins.        |
| `STORE_ASSET_BASE`                 | fastly     | Host for the image paths the store lookup reports.                 |
| `STEAM_COMMUNITY_ICON_BASE`        | media      | Host for square community icons, the last image fallback.          |

Invalid or missing critical values abort startup rather than failing later at
request time. Two exceptions are deliberate: `STEAM_API_KEY` and
`ACCESS_CODES`/`SESSION_SECRET` may be absent, in which case the corresponding
endpoints answer `503 feature_disabled` and everything else keeps working — so
an existing deployment still boots after an update without new configuration.
Setting `ACCESS_CODES` _without_ a long `SESSION_SECRET` is a configuration
error and does abort startup, because it would hand out cookies nobody can
verify.

## API

Authentication: `Authorization: Bearer <key>`. A `?key=<key>` query parameter is
accepted as a fallback for clients that cannot send headers — see the note under
_Security model_ first.

The browser frontend authenticates differently — see _Sessions_ below.

| Method | Path                                    | Access | Purpose                                          |
| ------ | --------------------------------------- | ------ | ------------------------------------------------ |
| GET    | `/api/health`                           | open   | Liveness and cache state                         |
| GET    | `/api/inventory/:steamId`               | guest  | Value a public inventory                         |
| GET    | `/api/portfolio/:steamId`               | admin  | Same data, plus `?format=csv` and `?refresh=1`   |
| POST   | `/api/prices/lookup`                    | admin  | Prices for a list of names (max 500)             |
| POST   | `/api/admin/refresh-prices`             | admin  | Run a refresh cycle now                          |
| GET    | `/api/admin/status`                     | admin  | Cache, tracking and queue state                  |
| POST   | `/api/auth/session`                     | open   | Trade an access code for a session cookie        |
| GET    | `/api/auth/session`                     | open   | Whether the caller is signed in                  |
| DELETE | `/api/auth/session`                     | open   | Sign out                                         |
| GET    | `/api/steam/library/:ref`               | guest  | Profile, owned games, cached times; `?refresh=1` |
| GET    | `/api/steam/library/:ref/hltb`          | guest  | Completion times only, for polling               |
| PUT    | `/api/steam/library/:ref/hidden/:appId` | guest  | Hide a game for this caller                      |
| DELETE | `/api/steam/library/:ref/hidden/:appId` | guest  | Show a hidden game again                         |
| DELETE | `/api/steam/library/:ref/hidden`        | guest  | Show every hidden game again                     |
| GET    | `/api/steam/status`                     | admin  | Completion-time worker progress                  |
| POST   | `/api/admin/refresh-hltb`               | admin  | Run a completion-time cycle now                  |

`docs/backend-contract.md` documents the library endpoints in full — request
shapes, response shapes, error codes and polling behaviour. That file is the one
to hand to the frontend.

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
`invalid_api_key`, `admin_key_required`, `invalid_body`, `too_many_names`,
`invalid_steam_ref`, `vanity_not_found`, `profile_not_found`, `profile_private`,
`library_unavailable`, `invalid_session`, `invalid_access_code`,
`feature_disabled`.

`library_unavailable` deserves a friendly message in any client: it means the
profile is public but its **game details** are private, which is a separate
Steam privacy setting and defaults to private for many accounts.

### Hidden games

Somebody looking at a library can hide games they never want to see in it
again. The list lives in SQLite (`hidden_games`), keyed by the label of the
access code or guest key and by the library's SteamID, so it follows a person
across devices and each viewer of a profile keeps their own. People who share
an access code share the list — there are no accounts to tell them apart.

Hidden games are removed before anything else happens to a library: they are
not tracked for completion times, not looked up in the store, and not counted
in `hltb` or `tags`, so they can never be the reason a progress bar is still
running. The response lists them separately under `hidden`.

The hide endpoints only accept a game that is part of the library, and store
the server's copy of its name. They are state-changing endpoints on a cookie
session; the cookie is `SameSite=Lax` and the API sends no CORS headers, so a
cross-site page cannot trigger them.

### After a privacy change

The usual next step after `profile_private` or `library_unavailable` is to fix
the setting and try again, so neither outcome is allowed to linger in a cache:

- A **private profile** is remembered for `PRIVATE_PROFILE_CACHE_SECONDS` (20 by
  default), not for `PROFILE_CACHE_MINUTES`. Public profiles keep the long
  lifetime; they are the ones that barely change.
- **Private game details** are never cached at all: the error is raised before
  anything is written, so the next request asks Steam again.
- A **cached library** that is out of date for privacy reasons, typically every
  playtime reading 0 because "keep my total playtime private" was still ticked,
  is replaced by `GET /api/steam/library/:ref?refresh=1`. That skips the
  profile and library caches, at most once per
  `LIBRARY_REFRESH_COOLDOWN_SECONDS` per SteamID; inside the window the request
  is answered from the cache as usual. `meta.refreshAvailableInSeconds` in
  the response says how long until the next forced refresh is honoured.

The cooldown is kept in memory, keyed by SteamID rather than by caller, so it
bounds Web API usage no matter how many people press the button — and a
restart only ever allows one refresh early.

What none of this controls is Steam itself: the Web API does not always reflect
a privacy change immediately, so a correct setting can still be refused for a
short while.

### Sessions

The web frontend cannot hold a bearer key — anything a page stores is readable
by script on that page, and a stolen key would be permanent. Instead a person
types an access code once and receives a signed `HttpOnly` cookie:

```bash
curl -c jar -X POST https://prices.example.com/api/auth/session \
  -H 'Content-Type: application/json' -d '{"code":"the-access-code"}'

curl -b jar https://prices.example.com/api/steam/library/gaben
```

A session counts as guest access, so it also opens `/api/inventory/:steamId` —
which is what makes it cheap to show inventory values in the frontend later.
Admin endpoints are bearer-only and a cookie never reaches them.

Access codes are read from the environment once, at startup. After adding or
changing one, restart the service; the startup log names the labels it loaded
(`[server] login enabled, 2 access code(s): chris, anna`), which is the quickest
check that the edit reached the running process. All codes belong on a single
`ACCESS_CODES` line - a second line replaces the first rather than extending
it.

The cookie is self-contained: it carries its own expiry inside the signature, so
there is no session table. The flip side is that individual sessions cannot be
revoked — rotating `SESSION_SECRET` signs everybody out at once, and that is the
intended lever.

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
  leading characters of a guessed key were correct. Access codes are compared
  against every entry rather than exiting early, for the same reason.
- **Session cookies are `HttpOnly`**, so no script on the page can read one,
  `SameSite=Lax`, and scoped to `Path=/api` so they are never sent with requests
  for static frontend assets. They are signed with HMAC-SHA256 and carry their
  own expiry inside the signature.
- **Access codes are shorter than guest keys** — 12 characters against 24 —
  because a person types them. That is a real trade-off, paid for by a dedicated
  login limiter of 10 attempts per 15 minutes per address, applied _before_ the
  comparison. If you expose this to the open internet rather than to a handful
  of friends, raise the minimum in `parseAccessCodes` and issue longer codes.
- **Cookies never reach admin endpoints.** `requireAdmin` reads bearer keys
  only, so even a mistake in the cookie handling cannot escalate a session into
  administrative access.
- **No SSRF surface.** SteamIDs are validated against `^7656119\d{10}$` before
  anything happens, and the `:ref` path segment is re-parsed server-side by
  `parseSteamRef` — a value that is not a SteamID64, a `steamcommunity.com`
  profile link or a plain vanity name is refused rather than forwarded. No
  parameter lets a caller influence a URL, host or path.
- **The Steam Web API key never appears in a log line or an error message**, and
  URLs are built through `URLSearchParams` so no caller-supplied string is
  interpolated next to it.
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
- Completion times arrive gradually, not with the first response. A 500-game
  library takes roughly 25 minutes to fill at the default worker settings.
- The HowLongToBeat client is scraping an undocumented endpoint. It is expected
  to break at some point; when it does, libraries still load and completion
  times simply stay `null`. Check `GET /api/steam/status` and the logs.
- Matching is by title, confirmed by Steam AppID only when the title is
  ambiguous. A game whose Steam and HowLongToBeat names differ in an unusual way
  can end up unmatched rather than wrong, which is the intended failure
  direction.
- The store lookup for tags, reviews and image paths is likewise undocumented,
  and unlike the price and completion-time paths it needs no API key at all.
  When it breaks, games come back with empty tag lists, no review summary and
  AppID-derived image URLs — which 404 for newer store art — and the response
  says so in `tags.known`; nothing else is affected. `STORE_TAGS_ENABLED=false`
  produces the same result on purpose.
- Review summaries are Steam's own verdict and percentage, refreshed weekly by
  default. A game with few reviews has a score of 0 rather than a verdict.
- Reading a library needs the account's **game details** to be public, which is
  a different Steam setting from the profile being public. After changing it,
  the Web API may take a little while to agree; that delay is Steam's.
- The Steam Web API allows 100,000 calls per day per key. Libraries are cached
  for an hour, so this is not a practical limit for a handful of users.

## Project layout

```
src/
  server.ts            Express app, middleware, timers, graceful shutdown
  routes.ts            All HTTP endpoints and rate limiters
  auth.ts              Key extraction, session lookup, access levels
  session.ts           Signed HttpOnly session cookies, cookie parsing
  config.ts            Environment parsing and validation
  db.ts                SQLite schema, prepared statements, tracking queues
  throttle.ts          Serialised request queue with a circuit breaker
  prices.ts            Price cache: refresh cycle, lookups, fee maths
  hltb.ts              Completion-time cache: refresh cycle and worker
  storeDetails.ts      Store tags, reviews, image paths; fails quietly by design
  steamHeaders.ts      The client identity every steamcommunity request sends
  steamInventory.ts    Inventory fetch, pagination, aggregation, cache
  steamLibrary.ts      Profile + owned games + cached times, and the caches
  steamRef.ts          Parses user input into a SteamID64 or vanity name
  refreshCooldown.ts   Per-key cooldown that rations forced library refreshes
  valuation.ts         Inventory x prices -> totals, plus CSV output
  cli-refresh.ts       Seed and refresh from the command line
  sources/
    steamMarket.ts     Throttled priceoverview lookups
    steamWebApi.ts     ResolveVanityURL, GetPlayerSummaries, GetOwnedGames
    howLongToBeat.ts   Token flow, search, and title matching
    steamStore.ts      Batched store lookups (tags, reviews, image paths), tag vocabulary
  *.test.ts            Unit tests for the pure parts (node:test)
apps-script/Code.gs    Example Google Sheets client
deploy/                systemd unit
docs/backend-contract.md  Endpoint contract for the web frontend
docs/guests.md            Handout for people you give access to
```

## Tests

```bash
npm test        # node:test via tsx, no extra dependency
npm run typecheck
```

Covered: the input parser, session cookie signing and verification, the
refresh cooldown, store response parsing, and title normalisation — the pure
parts, where a mistake is silent. Network code is not covered, which matches how
the rest of this project is verified: by running it.

## License

No license file is included, which means all rights reserved by default. Add one
before publishing if you want others to reuse this.
