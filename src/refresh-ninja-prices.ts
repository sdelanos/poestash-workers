/**
 * Fetches all poe.ninja prices and stores them in the database.
 *
 * Usage:
 *   npx tsx src/refresh-ninja-prices.ts [league]
 *
 * Options:
 *   league    League name (default: Mirage)
 *
 * Designed to run every ~10 minutes via GitHub Actions cron.
 * Each run does a full refresh: fetch all categories, batch upsert, clean stale rows.
 *
 * Requires DATABASE_URL environment variable.
 */

import "dotenv/config";
import postgres from "postgres";
import { fetchAllNinjaPrices } from "./lib/ninja-fetcher";
import type { NinjaFetchedItem } from "./lib/ninja-types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

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
 *  JSONB columns are JSON.stringify'd to avoid postgres.js treating
 *  JS arrays as PostgreSQL arrays instead of JSON arrays. */
function toDbRow(row: NinjaFetchedItem, now: Date) {
  return {
    game: row.game,
    league: row.league,
    item_name: row.itemName,
    chaos_value: row.chaosValue,
    divine_value: row.divineValue,
    listing_count: row.listingCount,
    source: row.source,
    ninja_category: row.ninjaCategory,
    icon: row.icon,
    details_id: row.detailsId,
    sparkline_data: row.sparklineData != null ? JSON.stringify(row.sparklineData) : null,
    total_change: row.totalChange ?? null,
    stack_size: row.stackSize ?? null,
    explicit_modifiers: row.explicitModifiers != null ? JSON.stringify(row.explicitModifiers) : null,
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
    mutated_modifiers: row.mutatedModifiers != null ? JSON.stringify(row.mutatedModifiers) : null,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const league = process.argv[2] ?? "Mirage";
  const game = "poe1";

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

  const start = Date.now();

  // 1. Fetch all prices from poe.ninja
  console.log(`Fetching ${game}/${league} prices from poe.ninja...`);
  const { rows, divineRate } = await fetchAllNinjaPrices(game, league);

  if (rows.length === 0) {
    console.error("No items fetched from poe.ninja — API may be down");
    await sql.end();
    process.exit(1);
  }

  const fetchMs = Date.now() - start;
  console.log(`Fetched ${rows.length} items (divine=${divineRate.toFixed(1)}c) in ${fetchMs}ms`);

  // 2. Batch upsert into ninja_prices
  const now = new Date();
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
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
      console.log(`  Upserted batch ${batchNum}/${totalBatches}`);
    }
  }

  // 3. Upsert price metadata
  await sql`
    INSERT INTO ninja_price_meta (game, league, divine_rate, item_count, last_refreshed_at)
    VALUES (${game}, ${league}, ${divineRate}, ${rows.length}, ${now})
    ON CONFLICT (game, league) DO UPDATE SET
      divine_rate = EXCLUDED.divine_rate,
      item_count = EXCLUDED.item_count,
      last_refreshed_at = EXCLUDED.last_refreshed_at
  `;

  // 4. Delete stale rows not updated in >1 hour
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const deleted = await sql`
    DELETE FROM ninja_prices
    WHERE game = ${game} AND league = ${league} AND updated_at < ${staleThreshold}
  `;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s — ${rows.length} upserted, ${deleted.count} stale deleted, divine=${divineRate.toFixed(1)}c`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
