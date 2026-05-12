/**
 * Fetches poe.ninja prices for one game/league and stores them in the database.
 *
 * Usage:
 *   npx tsx src/refresh-ninja-prices.ts <league> [game]
 *
 *   <league>  League name (e.g. "Mirage", "Fate of the Vaal").
 *             For game=poe2, pass "auto" to discover all currently-indexed
 *             PoE 2 leagues via poe.ninja's index-state endpoint and refresh
 *             each one in series. Zero-touch across league rollovers.
 *   [game]    "poe1" (default) or "poe2".
 *
 * Examples:
 *   npx tsx src/refresh-ninja-prices.ts "Mirage"
 *   npx tsx src/refresh-ninja-prices.ts "Fate of the Vaal" poe2
 *   npx tsx src/refresh-ninja-prices.ts auto poe2
 *
 * Designed to run every ~10 minutes via GitHub Actions cron.
 * Each run does a full refresh: fetch all categories, batch upsert.
 *
 * Rows are never deleted by this worker. poe.ninja serves low-volume
 * items intermittently — a row that drops out of one response is usually
 * back in the next. Keeping the last-known price (with whatever updated_at
 * it has) is strictly better than serving 0c. League-level staleness is
 * tracked in ninja_price_meta.last_refreshed_at.
 *
 * Requires DATABASE_URL environment variable.
 */

import "dotenv/config";
import postgres from "postgres";
import { fetchAllNinjaPrices } from "./lib/ninja-fetcher";
import { fetchAllPoe2Prices } from "./lib/ninja-fetcher-poe2";
import { discoverPoe2Leagues } from "./lib/poe2-leagues";
import type { NinjaFetchedItem } from "./lib/ninja-types";

type Game = "poe1" | "poe2";

function isGame(value: string): value is Game {
  return value === "poe1" || value === "poe2";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

// All columns in ninja_prices, in insertion order.
// Must match the ON CONFLICT SET clause below.
const COLUMNS = [
  "game", "league", "item_name", "chaos_value", "divine_value",
  "listing_count", "source", "ninja_category", "icon", "details_id",
  "sparkline_data", "total_change", "stack_size", "explicit_modifiers",
  "variant", "base_type", "links", "item_class", "item_type",
  "corrupted", "gem_level", "gem_quality", "level_required",
  "exalted_value", "count", "volume", "mutated_modifiers", "updated_at",
] as const;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Maps a fetcher result (camelCase) to a DB row (snake_case).
 *
 *  JSONB columns receive their plain JS array / object values directly.
 *  postgres.js v3 serializes JSONB-typed parameters with `JSON.stringify`
 *  internally — pre-stringifying here would cause it to stringify a
 *  string a second time, storing a JSON string scalar (e.g. `"[{...}]"`)
 *  instead of a JSON array (`[{...}]`). That broke `jsonb_typeof = 'array'`
 *  filtering on the read side and forced a defensive multi-pass parser
 *  in `lib/prices/index.ts`. */
function toDbRow(row: NinjaFetchedItem, now: Date) {
  return {
    game: row.game,
    league: row.league,
    item_name: row.itemName,
    chaos_value: row.chaosValue,
    divine_value: row.divineValue,
    listing_count: row.listingCount ?? 0,
    source: row.source,
    ninja_category: row.ninjaCategory,
    icon: row.icon,
    details_id: row.detailsId,
    sparkline_data: row.sparklineData ?? null,
    total_change: row.totalChange ?? null,
    stack_size: row.stackSize ?? null,
    explicit_modifiers: row.explicitModifiers ?? null,
    variant: row.variant ?? null,
    base_type: row.baseType ?? null,
    links: row.links ?? null,
    item_class: row.itemClass ?? null,
    item_type: row.itemType ?? null,
    corrupted: row.corrupted ?? null,
    gem_level: row.gemLevel ?? null,
    gem_quality: row.gemQuality ?? null,
    level_required: row.levelRequired ?? null,
    exalted_value: row.exaltedValue ?? null,
    count: row.count ?? null,
    volume: row.volume ?? null,
    mutated_modifiers: row.mutatedModifiers ?? null,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function refreshOneLeague(
  sql: postgres.Sql,
  game: Game,
  league: string,
): Promise<{ upserted: number; divineRate: number }> {
  const start = Date.now();

  console.log(`Fetching ${game}/${league} prices from poe.ninja...`);
  const { rows, divineRate } =
    game === "poe2"
      ? await fetchAllPoe2Prices(league)
      : await fetchAllNinjaPrices(game, league);

  if (rows.length === 0) {
    throw new Error(`No items fetched for ${game}/${league} — poe.ninja may be down`);
  }

  // Deduplicate by composite PK (game, league, detailsId, source).
  // poe.ninja can return the same detailsId from multiple categories.
  // PostgreSQL rejects duplicate PK rows within a single INSERT ... ON CONFLICT.
  const seen = new Set<string>();
  const deduped: NinjaFetchedItem[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const key = `${rows[i].detailsId}:${rows[i].source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(rows[i]);
    }
  }
  deduped.reverse();

  // Drop items with null chaosValue (PoE 1's reference currency Chaos Orb
  // arrives with primaryValue=null on the exchange feed). PoE 2 currently
  // emits a concrete value for every reference currency, but the filter
  // is harmless either way.
  const valid = deduped.filter((r) => r.chaosValue != null);

  const fetchMs = Date.now() - start;
  console.log(
    `  ${rows.length} fetched, ${valid.length} valid (divine=${divineRate.toFixed(1)}c) in ${fetchMs}ms`,
  );

  const now = new Date();
  const totalBatches = Math.ceil(valid.length / BATCH_SIZE);

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);
    const dbRows = batch.map((row) => toDbRow(row, now));

    await sql`
      INSERT INTO ninja_prices ${sql(dbRows, ...COLUMNS)}
      ON CONFLICT (game, league, details_id, source) DO UPDATE SET
        item_name = EXCLUDED.item_name,
        chaos_value = EXCLUDED.chaos_value,
        divine_value = EXCLUDED.divine_value,
        listing_count = EXCLUDED.listing_count,
        ninja_category = EXCLUDED.ninja_category,
        icon = EXCLUDED.icon,
        sparkline_data = EXCLUDED.sparkline_data,
        total_change = EXCLUDED.total_change,
        stack_size = EXCLUDED.stack_size,
        explicit_modifiers = EXCLUDED.explicit_modifiers,
        variant = EXCLUDED.variant,
        base_type = EXCLUDED.base_type,
        links = EXCLUDED.links,
        item_class = EXCLUDED.item_class,
        item_type = EXCLUDED.item_type,
        corrupted = EXCLUDED.corrupted,
        gem_level = EXCLUDED.gem_level,
        gem_quality = EXCLUDED.gem_quality,
        level_required = EXCLUDED.level_required,
        exalted_value = EXCLUDED.exalted_value,
        count = EXCLUDED.count,
        volume = EXCLUDED.volume,
        mutated_modifiers = EXCLUDED.mutated_modifiers,
        updated_at = EXCLUDED.updated_at
    `;

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    if (batchNum % 20 === 0 || batchNum === totalBatches) {
      console.log(`    upserted batch ${batchNum}/${totalBatches}`);
    }
  }

  await sql`
    INSERT INTO ninja_price_meta (game, league, divine_rate, item_count, last_refreshed_at)
    VALUES (${game}, ${league}, ${divineRate}, ${valid.length}, ${now})
    ON CONFLICT (game, league) DO UPDATE SET
      divine_rate = EXCLUDED.divine_rate,
      item_count = EXCLUDED.item_count,
      last_refreshed_at = EXCLUDED.last_refreshed_at
  `;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  done in ${elapsed}s — ${valid.length} upserted`);

  return { upserted: valid.length, divineRate };
}

async function resolveLeagues(game: Game, league: string): Promise<string[]> {
  if (game === "poe2" && league === "auto") {
    const leagues = await discoverPoe2Leagues();
    if (leagues.length === 0) {
      throw new Error("poe.ninja index-state returned no indexed PoE 2 leagues");
    }
    console.log(`Discovered ${leagues.length} indexed PoE 2 leagues: ${leagues.join(", ")}`);
    return leagues;
  }
  return [league];
}

async function main() {
  const league = process.argv[2] ?? "Mirage";
  const gameArg = process.argv[3] ?? "poe1";

  if (!isGame(gameArg)) {
    console.error(`Invalid game "${gameArg}". Expected "poe1" or "poe2".`);
    process.exit(1);
  }
  const game: Game = gameArg;

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, {
    idle_timeout: 30,
    max_lifetime: 300,
    connect_timeout: 10,
    transform: { undefined: null },
  });

  const overallStart = Date.now();
  let firstError: unknown = null;

  try {
    const leagues = await resolveLeagues(game, league);

    for (const l of leagues) {
      try {
        await refreshOneLeague(sql, game, l);
      } catch (err) {
        console.error(`Failed ${game}/${l}:`, err);
        // Remember the first failure but keep going so one bad league does
        // not abort the rest of the refresh.
        if (firstError == null) firstError = err;
      }
    }
  } finally {
    await sql.end();
  }

  const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`All done in ${elapsed}s`);

  if (firstError != null) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
