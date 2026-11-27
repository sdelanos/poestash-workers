# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): refreshes poe.ninja PoE 1 prices every hour, on the hour.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): refreshes poe.ninja PoE 2 prices every hour, at half past.
- **Cluster prices** (`refresh-cluster-prices.yml`): refreshes cluster jewel combo prices every 6 hours.
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): refreshes Inscribed Ultimatum prices hourly.
- **Gem usage** (`refresh-gem-usage.yml`): stopped since 2026-11-19, see below. Refreshed per-gem player counts every 6 hours.
- **Roast rare prices** (`refresh-roast-rare-prices.yml`): prices the rare slots of build guides players pasted into a Roast, every 3 hours.
- **Warrant corpus** (`refresh-warrant-corpus.yml`): samples the public stash river every 6 hours for listed Mercenary Warrants, and writes per-(support, tier) price contrasts. Costs no trade budget; keeps the raw sample as an Actions artifact, not in Postgres. `npm run analyse:warrant-corpus -- <ndjson>` re-runs the finding against a kept sample. See ADR 0003.

Retired on 2026-11-16 (the app's decision 545): the temple scan (`refresh-temple-prices`, the trade site's tier 3 rooms) and the Scrying Orb scan (`refresh-scrying-orb-prices`, poe.watch). The ninja worker's `IncursionTemple` and `ScryingOrb` rows price both. Their tables, `temple_prices` and `scrying_orb_prices`, stay until the app's migration drops them.

## poe.ninja's rules

poe.ninja's API reference (https://poe.ninja/docs/api) is the contract, and ADR 0004 the reasons. The ninja workers price the whole app, so a block from poe.ninja would take every price page down with it.

- Only the documented economy endpoints: `/<game>/api/economy/leagues` and the exchange, stash item and stash currency overviews. Never the builds / profiles API, character, PoB or anything else they call internal.
- Every request goes through `src/lib/ninja-http.ts`: the `poestash-workers/1.0` User-Agent with the site and contact, at most 2 requests in flight, and a 429 retried after its `Retry-After`, twice at most. A new poe.ninja call uses `ninjaFetch`, never a bare `fetch`.
- Never faster than every 30 minutes (ADR 0004). Both workers run hourly since the app's decision 643, PoE 1 at :00 and PoE 2 at :30, so their requests never overlap (the app's `vercel.json` crons; the app's copy and staleness bars assume an hour). The overviews refresh about every 15 minutes for PoE 1 and every hour for PoE 2.

### Gem usage is stopped

Every gem-usage run from 2026-11-18 12:15 UTC failed: poe.ninja moved the build snapshot version out of `index-state` and put the build search behind a Cloudflare challenge (`/api/protected/poe1/builds/...`), which answers 403 to any client that isn't a browser. Their docs now close the builds / profiles API to third parties. Getting past that challenge would be evading their bot protection, so the worker is stopped instead: the workflow has no `repository_dispatch` trigger and its job reads `if: false`. The code stays for a workaround from a sanctioned source. `ninja_gem_usage` keeps its last snapshot (2026-11-18 06:15 UTC), which the app's retention never deletes while no newer one exists, and the app says the counts are frozen.

## Telling the app

After a run that wrote prices, the five workers whose tables the app's price pages read (both ninja workers, ultimatum, cluster, and gem usage while it ran) call `POST <POESTASH_APP_URL>/api/revalidate/prices?game=<poe1|poe2>` with `Authorization: Bearer <CRON_SECRET>` (`src/lib/revalidate-app.ts`), so the pages show the new figures now instead of on their cache timer. The cluster worker calls every 30 minutes while it writes, since its run usually ends on the workflow timeout. The others (leagues, warrant corpus, split, Roast rares) write nothing those pages cache.

- `POESTASH_APP_URL` (repository variable, not a secret, so logs stay readable): the app's exact origin, `https://www.poestash.com`. It is the switch: unset, the call is skipped. PoeStash 1.x has no such route, so it is set at 2.0's cut-over. A redirect is not followed (it would drop the header): give the host the app answers on.
- `CRON_SECRET` (repository secret): the app's own `CRON_SECRET`, the value on Vercel. Rotate both sides together.

A failed call (refused secret, 404, timeout, redirect) logs, adds a warning annotation to the run and never fails it: the prices are written, and the app's cache expires on its own.

## Delisted rows

The ninja workers never delete a `ninja_prices` row and rewrite one only when its figures change, so `updated_at` can't tell an item poe.ninja dropped from one whose figures stood still. After each league's upsert, every feed (source and type) poe.ninja answered marks the league's rows of that feed its answer left out: `delisted_at = now()` (`src/lib/ninja-delisting.ts`). The app prices a row only while `delisted_at` is null. A row that comes back is unmarked by the upsert (`delisted_at` is a data column there, written null).

- A failed request marks nothing (it is in the run's failed categories, and the run fails as before). Nor does an empty answer, or one holding under half the rows the type lists now (`NINJA_DELIST_MIN_RATIO`, default 0.5): the run logs `delisting held back for <source>:<type>` with both counts. A wrong mark lasts one refresh: the next answer that holds the row clears it.
- Ships after the app's migration that adds the column (`db/migrations/0037_ninja_prices_delisted.sql` in the app repo): an older database refuses the upsert.
- Backfill: the first run after the deploy marks what is already stale in every type whose answer holds at least half its listed rows. A type held back on that run (its log line says which, typically one with years of dropped items on Standard) is marked by one manual run with the floor at 0: Actions, "Refresh Ninja Prices" (and the PoE 2 one), Run workflow, `delist_min_ratio` 0. An empty answer still marks nothing.
