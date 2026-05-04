# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices** (`refresh-ninja-prices.yml`): fetches all poe.ninja prices every 20 minutes
- **Cluster prices** (`refresh-cluster-prices.yml`): fetches cluster jewel combo prices from PoE trade API every 6 hours
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): fetches Inscribed Ultimatum mean prices from poe.watch hourly
- **Gem usage** (`refresh-gem-usage.yml`): scrapes per-gem player counts from poe.ninja's builds page every 6 hours. Used by the gem-leveling calculator to filter / de-rank niche gems whose price data exists but whose player demand is too thin to be reliable. Three HTTP requests per league (~225 KB), decodes the protobuf manifest + gem dictionary, upserts ~800 rows into `ninja_gem_usage`.

## Local testing

Set `DATABASE_URL` in a `.env` file (same Supabase pooler URL the main app uses), then:

```
npm run refresh:ninja "Mirage"
npm run refresh:gem-usage "Mirage"
npm run refresh:clusters "Mirage"
```

## Adding a new worker

1. New TS file under `src/`. Import the existing `lib/` helpers when reasonable, follow the upsert + stale-prune pattern from `refresh-ninja-prices.ts`.
2. New entry under `scripts` in `package.json`.
3. New workflow under `.github/workflows/`. Reuse the 4-step pattern (checkout → setup-node → npm ci → run). Set `continue-on-error: true` per league step if poe.ninja is occasionally flaky for that variant.
4. Add a row to the table at the top of this README.
