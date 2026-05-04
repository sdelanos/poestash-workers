# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices** (`refresh-ninja-prices.yml`): fetches all poe.ninja prices every 20 minutes
- **Cluster prices** (`refresh-cluster-prices.yml`): fetches cluster jewel combo prices from PoE trade API every 6 hours
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): fetches Inscribed Ultimatum mean prices from poe.watch hourly
- **Gem usage** (`refresh-gem-usage.yml`): scrapes per-gem player counts from poe.ninja's builds page every 6 hours. Used by the gem-leveling calculator to filter / de-rank niche gems whose price data exists but whose player demand is too thin to be reliable. Three HTTP requests per league (~225 KB), decodes the protobuf manifest + gem dictionary, upserts ~800 rows into `ninja_gem_usage`.
- **Temple prices** (`refresh-temple-prices.yml`): fetches Temple of Atzoatl gem-room t3 (Doryani's Institute, the double-corrupt gem room) prices from the PoE trade API hourly. Two trade calls per league (search + fetch), median of the cheapest 10 online listings, upserts one row per league into `temple_prices`. Powers the Lapidary Lens (LQD) strategy on the gem-leveling page.

## Local testing

Set `DATABASE_URL` in a `.env` file (same Supabase pooler URL the main app uses), then:

```
npm run refresh:ninja "Mirage"
npm run refresh:gem-usage "Mirage"
npm run refresh:clusters "Mirage"
npm run refresh:temple "Mirage"
```

## Schema

The `temple_prices` table is created by:

```sql
CREATE TABLE IF NOT EXISTS temple_prices (
  league             TEXT        NOT NULL,
  room_key           TEXT        NOT NULL,
  trade_stat_id      TEXT        NOT NULL,
  median_price_chaos REAL,
  min_price_chaos    REAL,
  listing_count      INTEGER     NOT NULL DEFAULT 0,
  sample_size        INTEGER     NOT NULL DEFAULT 0,
  last_refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league, room_key)
);
CREATE INDEX IF NOT EXISTS idx_temple_prices_refresh
  ON temple_prices (league, last_refreshed_at);
```

Apply via the Supabase MCP `execute_sql` tool (matches the project's
db-migration workflow), then mirror it into `lib/db/schema.ts` in the main
app so the gem-leveling page can read the live values.

## Adding a new worker

1. New TS file under `src/`. Import the existing `lib/` helpers when reasonable, follow the upsert + stale-prune pattern from `refresh-ninja-prices.ts`.
2. New entry under `scripts` in `package.json`.
3. New workflow under `.github/workflows/`. Reuse the 4-step pattern (checkout → setup-node → npm ci → run). Set `continue-on-error: true` per league step if poe.ninja is occasionally flaky for that variant.
4. Add a row to the table at the top of this README.
