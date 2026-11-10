# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): refreshes poe.ninja PoE 1 prices every 30 minutes.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): refreshes poe.ninja PoE 2 prices every 30 minutes.
- **Cluster prices** (`refresh-cluster-prices.yml`): refreshes cluster jewel combo prices every 6 hours.
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): refreshes Inscribed Ultimatum prices hourly.
- **Gem usage** (`refresh-gem-usage.yml`): refreshes per-gem player counts every 6 hours.
- **Temple prices** (`refresh-temple-prices.yml`): refreshes Temple of Atzoatl room prices hourly.
- **Roast rare prices** (`refresh-roast-rare-prices.yml`): prices the rare slots of build guides players pasted into a Roast, every 3 hours.
- **Scrying Orb prices** (`refresh-scrying-orb-prices.yml`): refreshes per-map Scrying Orb prices from poe.watch daily.
- **Warrant corpus** (`refresh-warrant-corpus.yml`): samples the public stash river every 6 hours for listed Mercenary Warrants, and writes per-(support, tier) price contrasts. Costs no trade budget; keeps the raw sample as an Actions artifact, not in Postgres. `npm run analyse:warrant-corpus -- <ndjson>` re-runs the finding against a kept sample. See ADR 0003.

## Telling the app

After a run that wrote prices, the seven workers whose tables the app's price pages read (both ninja workers, ultimatum, scrying orb, temple, gem usage, cluster) call `POST <POESTASH_APP_URL>/api/revalidate/prices?game=<poe1|poe2>` with `Authorization: Bearer <CRON_SECRET>` (`src/lib/revalidate-app.ts`), so the pages show the new figures now instead of on their cache timer. The cluster worker calls every 30 minutes while it writes, since its run usually ends on the workflow timeout. The others (leagues, warrant corpus, split, Roast rares) write nothing those pages cache.

- `POESTASH_APP_URL` (repository variable, not a secret, so logs stay readable): the app's exact origin, `https://www.poestash.com`. It is the switch: unset, the call is skipped. PoeStash 1.x has no such route, so it is set at 2.0's cut-over. A redirect is not followed (it would drop the header): give the host the app answers on.
- `CRON_SECRET` (repository secret): the app's own `CRON_SECRET`, the value on Vercel. Rotate both sides together.

A failed call (refused secret, 404, timeout, redirect) logs, adds a warning annotation to the run and never fails it: the prices are written, and the app's cache expires on its own.

## Delisted rows

The ninja workers never delete a `ninja_prices` row and rewrite one only when its figures change, so `updated_at` can't tell an item poe.ninja dropped from one whose figures stood still. After each league's upsert, every feed (source and type) poe.ninja answered marks the league's rows of that feed its answer left out: `delisted_at = now()` (`src/lib/ninja-delisting.ts`). The app prices a row only while `delisted_at` is null. A row that comes back is unmarked by the upsert (`delisted_at` is a data column there, written null).

- A failed request marks nothing (it is in the run's failed categories, and the run fails as before). Nor does an empty answer, or one holding under half the rows the type lists now (`NINJA_DELIST_MIN_RATIO`, default 0.5): the run logs `delisting held back for <source>:<type>` with both counts. A wrong mark lasts one refresh: the next answer that holds the row clears it.
- Ships after the app's migration that adds the column (`db/migrations/0037_ninja_prices_delisted.sql` in the app repo): an older database refuses the upsert.
- Backfill: the first run after the deploy marks what is already stale in every type whose answer holds at least half its listed rows. A type held back on that run (its log line says which, typically one with years of dropped items on Standard) is marked by one manual run with the floor at 0: Actions, "Refresh Ninja Prices" (and the PoE 2 one), Run workflow, `delist_min_ratio` 0. An empty answer still marks nothing.
