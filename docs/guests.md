# For people I gave access to

Short handout. Two kinds of access exist; you were given one of them.

## An access code (for the web app)

Open the site, type the code once, done. It is remembered for 30 days in a
cookie, so you will occasionally be asked again.

What you can do: look up any **public** Steam profile, see its game library, and
sort it by how long the games take to finish.

Two things that go wrong most often:

- **"This Steam profile is private."** The profile has to be public.
- **"Game details are private."** This one catches nearly everybody. A profile
  can be public while its _game details_ are still private — that is a separate
  switch. In Steam: _Profile → Edit Profile → Privacy Settings → Game details →
  Public_. It can take a minute to take effect.

Completion times fill in gradually after a library loads, a few dozen games per
minute. That is deliberate: the times come from HowLongToBeat, which has no
official API, and asking politely and slowly is what keeps the door open. Leave
the tab open and it will finish on its own.

## A guest key (for scripts and spreadsheets)

Send it as a header:

```bash
curl -H "Authorization: Bearer YOUR_KEY" \
  https://<host>/api/inventory/76561198000000000
```

A `?key=YOUR_KEY` query parameter works too, for clients that cannot set
headers. Prefer the header — query strings end up in browser history, proxy logs
and shoulder-surfing range.

What the key does: values a public CS2 inventory at current Steam Market prices.
Nothing else. It cannot see anything private, and it cannot change anything.

## Please

- **Do not share it.** Each key and code is issued per person and labelled, so
  if one gets abused, that one gets revoked — and I would rather revoke yours
  than everybody's.
- **Do not put it in a public repo, a screenshot, or a spreadsheet cell** other
  people can read.
- There is a rate limit. Normal use will never reach it; a script in a tight
  loop will, and gets `429 rate_limited` for a while.
- Prices are market averages. They ignore float, pattern and stickers, so for
  knives and expensive skins treat them as a rough figure, not a quote.

If something looks broken or you hit a limit you did not expect, tell me rather
than retrying harder.
