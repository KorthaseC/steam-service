# Backend contract — Steam library and completion times

The authoritative description of the endpoints the _Steam Expander Overviewer_
frontend consumes. Copy this file into the frontend repo; `http-library.ts` is
the only file there that should need to know any of it.

Base path is `/api`. Frontend and API are served from the same origin, so there
is **no CORS** and no `Access-Control-*` header anywhere — see _Development
setup_ at the bottom for how that works on localhost.

## Units and null

Two conventions that are easy to get wrong:

- **Every duration is minutes.** `playtimeMinutes` comes from Steam that way,
  and the HowLongToBeat figures are converted to match. Divide by 60 for hours
  in the UI; do not assume seconds anywhere.
- **`hltb: null` and `matched: false` are different things.** `null` means
  nobody has looked this game up yet — show a skeleton, and expect it to be
  filled in by polling. `matched: false` means HowLongToBeat was searched and
  knows no such game — show "no data" and stop waiting.
- **Tags are not a loading phase.** `hltb` fills in over minutes; `tags` arrives
  complete with the first response. Do not build a polling or skeleton path for
  it — see _Store tags_ below.

## Authentication

The browser cannot hold a bearer key, so it trades an access code for a signed
`HttpOnly` cookie. Send `credentials: 'same-origin'` (the default) on every
request; nothing else is needed, because the cookie rides along automatically.

### `POST /api/auth/session`

```jsonc
// request
{ "code": "the access code the user typed" }

// 200
{ "ok": true, "label": "chris" }
```

Sets `Set-Cookie: sxo_session=…; Path=/api; HttpOnly; SameSite=Lax; Secure;
Max-Age=2592000`. The cookie is not readable from script, by design — do not try
to inspect it; call the status endpoint instead.

| Status | Body                  | Meaning                                  |
| ------ | --------------------- | ---------------------------------------- |
| 400    | `invalid_body`        | No `code` string in the body             |
| 403    | `invalid_access_code` | Wrong code                               |
| 429    | `rate_limited`        | 10 attempts per 15 minutes per address   |
| 503    | `feature_disabled`    | No access codes configured on the server |

### `GET /api/auth/session`

```jsonc
{ "authenticated": true, "label": "chris", "loginRequired": true }
```

Open endpoint, safe to call on app boot to decide between the login screen and
the app. `loginRequired: false` means the server has no access codes configured
at all.

### `DELETE /api/auth/session`

Clears the cookie. Always `{ "ok": true }`.

## Library

### `GET /api/steam/library/:ref`

`:ref` is the user's raw input, URL-encoded. A SteamID64, a
`steamcommunity.com/profiles/…` or `/id/…` link (with or without scheme), or a
bare vanity name all work — `encodeURIComponent` the whole thing and the server
decodes it. The server re-parses it independently of the frontend, so anything
outside those shapes is refused rather than passed on to Steam.

**Answers immediately.** Games whose completion times are not cached yet come
back with `hltb: null` and are queued for the background worker.

```jsonc
{
  "profile": {
    "steamId64": "76561197960287930",
    "personaName": "Rabscuttle",
    "realName": "Gabe Newell", // null when unset or hidden
    "avatarUrl": "https://avatars.steamstatic.com/….jpg",
    "profileUrl": "https://steamcommunity.com/id/gaben/",
    "rawInput": "gaben", // echoed back for the header
  },
  "games": [
    {
      "appId": 620,
      "name": "Portal 2",
      "capsuleUrl": "https://…/store_item_assets/steam/apps/620/<hash>/capsule_231x87.jpg?t=…",
      "iconUrl": "https://…/steamcommunity/public/images/apps/620/<hash>.jpg", // or null
      "playtimeMinutes": 1337,
      "lastPlayed": "2024-11-02T18:20:00.000Z", // null if never played
      "hltb": {
        "mainStory": 515, // minutes; null when HLTB has no figure
        "mainExtra": 826,
        "completionist": 1377,
        "matched": true,
      },
      "tags": ["Rätsel", "Sci-Fi", "Komödie", "Erstperson", "Koop"],
      "reviews": {
        "score": 9, // Steam's verdict, 1-9; 0 = too few reviews
        "percentPositive": 98, // null when Steam reports none
        "count": 412345,
      },
    },
    {
      "appId": 12345,
      "name": "Some Obscure Thing",
      "capsuleUrl": "…", // derived from the AppID; may not load, see "Images"
      "iconUrl": null,
      "playtimeMinutes": 0,
      "lastPlayed": null,
      "hltb": null, // not looked up yet -> poll
      "tags": [], // no tags known - see the `tags` block below
      "reviews": null, // no summary known - same block
    },
  ],
  "hidden": [
    // games this caller hid here, most recent first; see "Hidden games"
    {
      "appId": 440,
      "name": "Team Fortress 2",
      "hiddenAt": "2026-09-10T18:02:11.000Z",
    },
  ],
  "hltb": {
    "total": 512,
    "resolved": 369, // matched, with times
    "unmatched": 22, // searched, no such game
    "pending": 121, // still to do -> keep polling
    "blocked": false, // true: HLTB is refusing, progress stalled
  },
  "tags": {
    "total": 512,
    "known": 512, // games whose tags are settled; not something to poll on
  },
  "meta": {
    "libraryFetchedAt": "2026-09-06T10:15:21.000Z",
    "fromCache": true,
    "refreshAvailableInSeconds": 0, // see "Forced refresh"
  },
}
```

Games are sorted by playtime descending. Sort them however you like in the UI;
the order is only there to make the payload stable.

#### Store tags

`tags` on each game is the Steam store's user tags, already resolved to display
names in the server's configured language (German by default, set through
`STORE_TAG_LANGUAGE`). **The order is Steam's own** — most agreed-upon tag
first — so take the first few rather than sorting alphabetically; the ordering
is the signal. There are at most `STORE_TAGS_PER_GAME` of them, six by default.

**Tags are not a second loading phase.** This is the important difference from
the completion times, and it is worth being explicit because the two look
superficially alike. Tags come back complete with the first response: the store
endpoint answers 200 AppIDs in roughly half a second, so a 500-game library is
three requests and about a second and a half. There is no worker, nothing to
poll, and no skeleton state. `GET /api/steam/library/:ref/hltb` deliberately
does **not** carry tags.

`tags: []` means no tags are known for that game. There is no `null` variant,
because unlike `hltb` there is no in-between state worth rendering differently.
Two things produce an empty list and the per-game field cannot tell them apart:

- The game genuinely carries no store tags, or Steam has delisted it. About 2%
  of a typical library.
- The tag lookup was unavailable when the library was built.

That is what the top-level `tags` block is for. `known` counts the games whose
store details are settled, `total` is the library size. The name is historical:
the same store call delivers tags, `reviews` and the capsule path, so the block
covers all three. When `known` is 0 on a library of
any size, the lookup failed rather than every game being untagged — worth saying
so instead of showing an empty filter. A partial `known` is normal and needs no
message: the remaining games fill in on the next load.

The underlying endpoint is undocumented — it is the API the Steam store front-end
itself calls — so it can start refusing at any time. A failure there never fails
the library request; it only empties this field. The server can also be run with
`STORE_TAGS_ENABLED=false`, which has exactly the same visible effect.

#### Reviews

`reviews` is the store's review summary, the one the store page shows — review
bombs Steam flagged as off-topic are left out. Like tags it arrives complete
with the first response and has no loading phase.

- `score` is Steam's `EUserReviewScore`. Word it in the UI, the server sends no
  label:

  | score | Steam's wording         |
  | ----- | ----------------------- |
  | 9     | Overwhelmingly Positive |
  | 8     | Very Positive           |
  | 7     | Positive                |
  | 6     | Mostly Positive         |
  | 5     | Mixed                   |
  | 4     | Mostly Negative         |
  | 3     | Negative                |
  | 2     | Very Negative           |
  | 1     | Overwhelmingly Negative |
  | 0     | too few reviews for one |

- `percentPositive` is 0–100, or `null` when Steam reports no percentage.
- `count` is the number of reviews the verdict is based on.

`reviews: null` means no summary is known: the game has none (delisted, never
reviewed) or the store lookup was unavailable, which the `tags` block tells
apart. Summaries are refreshed weekly by default (`STORE_REVIEW_MAX_AGE_DAYS`).

#### Images

`capsuleUrl` is never empty, but it is not guaranteed to load. When the store
lookup reported the game's image path, that path is used — newer store art
lives below a content hash that cannot be derived from the AppID. Otherwise the
URL is derived from the AppID, which only older art answers to.

`iconUrl` is the square community icon, or `null` when Steam sends none. It is
the fallback for a capsule that fails to load — typically a game that has left
the store, where the lookup knows nothing. It is square and small (32 px), so
show it letterboxed rather than cropped into the capsule's shape.

Suggested chain: `capsuleUrl`, on `error` → `iconUrl`, on `error` → a
placeholder.

#### Forced refresh

`GET /api/steam/library/:ref?refresh=1` reads profile and owned games from
Steam instead of the cache. It exists for one situation: somebody has just
changed a privacy setting, and the cached library is out of date because of it.
The common case is every playtime reading 0, because "keep my total playtime
private" was still ticked when the library was cached.

It is rationed **per SteamID, not per caller**: at most one forced refresh per
`LIBRARY_REFRESH_COOLDOWN_SECONDS` (60 by default). A `refresh=1` inside that
window is not an error — it is answered from the cache exactly like a normal
request. Two fields tell the client what happened:

- `meta.fromCache: false` — the refresh went through to Steam.
- `meta.refreshAvailableInSeconds` — how long until the next `refresh=1` will
  be honoured, `0` when one is available right now. Use it to disable the
  refresh control rather than letting people press a button that silently
  does nothing. It is relative on purpose: add it to the client's own clock on
  receipt, and a browser whose clock is off does not matter.

A server predating this field omits it and ignores `refresh=1`; treat an
absent `refreshAvailableInSeconds` as "forced refresh not supported".

Completion times and tags are unaffected by `refresh=1`. They belong to a game,
not to a player, and have their own caches.

#### After a privacy error

Neither privacy error lingers in a cache, so retrying after the user has fixed
their settings works without `refresh=1`:

- `profile_private` is remembered for only `PRIVATE_PROFILE_CACHE_SECONDS` (20
  by default). A retry after that asks Steam again.
- `library_unavailable` is never cached. Every retry asks Steam again.

Steam's own Web API may still take a little while to reflect the change. A
client that offers to "check automatically" should retry at a relaxed pace -
every 30 seconds fits well inside the rate limit and outlasts the negative
cache — and give up after a few minutes.

#### Hidden games

`games` holds only what the caller has not hidden, and every figure next to it
is counted without the hidden ones: `hltb.total` and `pending`, `tags.total`,
and the polling endpoint below. A hidden game is not tracked for completion
times and not looked up in the store, so it can never keep a progress bar
waiting. `hidden` lists what was taken out, enough to offer it for restoring.

Hidden games are stored **per caller and per library**. The caller is the label
of the access code (or guest key) that signed the request, so the list follows
a person across devices, and two people looking at the same profile each have
their own. Two people sharing one access code share one list.

```
PUT    /api/steam/library/:ref/hidden/:appId   hide one game
DELETE /api/steam/library/:ref/hidden/:appId   show it again
DELETE /api/steam/library/:ref/hidden          show every hidden game again
```

All three answer `{ "hidden": [ … ] }` — the caller's list as it now stands,
same shape as in the library response. All three are idempotent: hiding a
hidden game keeps its original `hiddenAt`, and showing a game that is not
hidden is not an error.

Hiding needs the game to be part of the library (`404 game_not_in_library`
otherwise); the stored name is the server's, not anything the client sends. A
non-numeric AppID is `400 invalid_app_id`.

The endpoints change nothing but the list. After hiding, drop the row locally.
After showing a game again, read the library again: the row needs its times,
tags and rating, which the hide endpoints do not carry.

They share the library rate limit. With a cookie session they are safe from
cross-site use because the cookie is `SameSite=Lax` and the API sends no CORS
headers.

### `GET /api/steam/library/:ref/hltb`

The polling companion. Same `:ref`. Reads the cached library rather than Steam,
so calling it every few seconds costs one local query.

```jsonc
{
  "hltb": {
    "total": 512,
    "resolved": 400,
    "unmatched": 22,
    "pending": 90,
    "blocked": false,
  },
  "entries": {
    "620": {
      "mainStory": 515,
      "mainExtra": 826,
      "completionist": 1377,
      "matched": true,
    },
    "12345": {
      "mainStory": null,
      "mainExtra": null,
      "completionist": null,
      "matched": false,
    },
  },
}
```

Only resolved games appear in `entries`; merge them into the games you already
hold, keyed by `appId` as a string.

**Suggested polling:** every 5 seconds while `hltb.pending > 0`, and stop when
it reaches 0, when `hltb.blocked` is true, or after a sensible number of tries.
A 500-game library takes roughly 25 minutes to fill on the default worker
settings, so show progress rather than a spinner.

## Errors

Every error is `{ "error": "<code>", "message": "<human readable>" }`.

| Code                  | Status | Meaning                                                       |
| --------------------- | ------ | ------------------------------------------------------------- |
| `invalid_steam_ref`   | 400    | Not a SteamID64, profile link or vanity name                  |
| `vanity_not_found`    | 404    | Steam knows no profile with that name                         |
| `profile_not_found`   | 404    | No account with that SteamID64                                |
| `profile_private`     | 403    | The profile itself is private (cached for seconds, not hours) |
| `library_unavailable` | 403    | Profile is public but **game details are private**            |
| `game_not_in_library` | 404    | Hiding a game the library does not contain                    |
| `invalid_app_id`      | 400    | Hide or show with an AppID that is not a positive integer     |
| `steam_rate_limited`  | 429    | Steam is throttling the server                                |
| `steam_unavailable`   | 502    | Steam unreachable or answering with errors                    |
| `feature_disabled`    | 503    | `STEAM_API_KEY` not configured on the server                  |
| `missing_api_key`     | 401    | No cookie and no bearer key — show the login screen           |
| `invalid_session`     | 403    | Cookie present but expired or forged — show the login screen  |
| `rate_limited`        | 429    | Too many requests                                             |

`library_unavailable` is worth its own message in the UI. It is common and
confusing: the profile looks public, but Steam has a _separate_ "Game details"
privacy setting, and it defaults to private for a lot of accounts. Tell the user
to set Game details to Public in their Steam privacy settings.

## Prices (existing endpoints)

Already implemented, and now reachable with a session cookie too, should the
frontend want to show inventory values later:

- `GET /api/inventory/:steamId` — values a public CS2 inventory
- `GET /api/health` — open, reports cache state

See the main README for their shapes.

## Development setup

The backend has no CORS middleware because production serves both from one
origin. Reproduce that locally with an Angular dev-server proxy rather than
adding CORS:

```json
// proxy.conf.json in the frontend repo
{
  "/api": { "target": "http://localhost:8087", "secure": false }
}
```

```jsonc
// angular.json -> architect.serve.options
"proxyConfig": "proxy.conf.json"
```

Then run the backend with `COOKIE_SECURE=false`, because the dev server speaks
plain http and a `Secure` cookie would never be stored.
