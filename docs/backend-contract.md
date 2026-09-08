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
      "capsuleUrl": "https://…/apps/620/capsule_231x87.jpg",
      "playtimeMinutes": 1337,
      "lastPlayed": "2024-11-02T18:20:00.000Z", // null if never played
      "hltb": {
        "mainStory": 515, // minutes; null when HLTB has no figure
        "mainExtra": 826,
        "completionist": 1377,
        "matched": true,
      },
      "tags": ["Rätsel", "Sci-Fi", "Komödie", "Erstperson", "Koop"],
    },
    {
      "appId": 12345,
      "name": "Some Obscure Thing",
      "capsuleUrl": "…",
      "playtimeMinutes": 0,
      "lastPlayed": null,
      "hltb": null, // not looked up yet -> poll
      "tags": [], // no tags known - see the `tags` block below
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
tags are settled, `total` is the library size. When `known` is 0 on a library of
any size, the lookup failed rather than every game being untagged — worth saying
so instead of showing an empty filter. A partial `known` is normal and needs no
message: the remaining games fill in on the next load.

The underlying endpoint is undocumented — it is the API the Steam store front-end
itself calls — so it can start refusing at any time. A failure there never fails
the library request; it only empties this field. The server can also be run with
`STORE_TAGS_ENABLED=false`, which has exactly the same visible effect.

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

| Code                  | Status | Meaning                                                      |
| --------------------- | ------ | ------------------------------------------------------------ |
| `invalid_steam_ref`   | 400    | Not a SteamID64, profile link or vanity name                 |
| `vanity_not_found`    | 404    | Steam knows no profile with that name                        |
| `profile_not_found`   | 404    | No account with that SteamID64                               |
| `profile_private`     | 403    | The profile itself is private                                |
| `library_unavailable` | 403    | Profile is public but **game details are private**           |
| `steam_rate_limited`  | 429    | Steam is throttling the server                               |
| `steam_unavailable`   | 502    | Steam unreachable or answering with errors                   |
| `feature_disabled`    | 503    | `STEAM_API_KEY` not configured on the server                 |
| `missing_api_key`     | 401    | No cookie and no bearer key — show the login screen          |
| `invalid_session`     | 403    | Cookie present but expired or forged — show the login screen |
| `rate_limited`        | 429    | Too many requests                                            |

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
