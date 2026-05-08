/**
 * Fetches Inscribed Ultimatum prices from poe.watch and stores them in the database.
 *
 * Usage:
 *   npx tsx src/refresh-ultimatum-prices.ts [league]
 *
 * Options:
 *   league    League name (default: Mirage)
 *
 * Designed to run hourly via GitHub Actions cron.
 * Each run does a full refresh: fetch from poe.watch, batch upsert.
 *
 * Rows are never deleted by this worker. poe.watch serves combos
 * intermittently based on liquidity — keeping the last-known price is
 * strictly better than serving 0c during a refresh gap. League-level
 * staleness is implicit in updated_at on individual rows.
 *
 * Requires DATABASE_URL environment variable.
 */

import "dotenv/config";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;
const POE_WATCH_BASE = "https://api.poe.watch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoeWatchInscribed {
  challenge: string;
  reward: string;
  reward_amount: string;
  reward_price: number;
  sacrifice: string;
  sacrifice_amount: string;
  sacrifice_price: number;
  divine: number;
  mean: number;
  low_confidence: boolean;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const COLUMNS = [
  "league", "combo_key", "challenge", "reward", "reward_amount",
  "sacrifice", "sacrifice_amount", "mean_chaos", "divine_value",
  "reward_price", "sacrifice_price", "low_confidence", "updated_at",
] as const;

function buildComboKey(item: PoeWatchInscribed): string {
  return `${item.challenge}|${item.sacrifice}|${item.sacrifice_amount}|${item.reward}|${item.reward_amount}`;
}

function toDbRow(item: PoeWatchInscribed, league: string, now: Date) {
  return {
    league,
    combo_key: buildComboKey(item),
    challenge: item.challenge,
    reward: item.reward,
    reward_amount: item.reward_amount,
    sacrifice: item.sacrifice,
    sacrifice_amount: item.sacrifice_amount,
    mean_chaos: item.mean,
    divine_value: item.divine,
    reward_price: item.reward_price,
    sacrifice_price: item.sacrifice_price,
    low_confidence: item.low_confidence,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const league = process.argv[2] ?? "Mirage";

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

  // 1. Fetch from poe.watch
  console.log(`Fetching ${league} Inscribed Ultimatum prices from poe.watch...`);
  const url = `${POE_WATCH_BASE}/inscribed?league=${encodeURIComponent(league)}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`poe.watch returned ${res.status} ${res.statusText}`);
    await sql.end();
    process.exit(1);
  }

  const items: PoeWatchInscribed[] | null = await res.json();

  if (!items || items.length === 0) {
    console.log(`No Inscribed Ultimatum data for ${league} — skipping`);
    await sql.end();
    return;
  }

  const fetchMs = Date.now() - start;
  const highConf = items.filter((i) => !i.low_confidence).length;
  console.log(`Fetched ${items.length} items (${highConf} high confidence) in ${fetchMs}ms`);

  // 2. Batch upsert
  const now = new Date();
  const totalBatches = Math.ceil(items.length / BATCH_SIZE);

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const dbRows = batch.map((item) => toDbRow(item, league, now));

    await sql`
      INSERT INTO ultimatum_prices ${sql(dbRows, ...COLUMNS)}
      ON CONFLICT (league, combo_key) DO UPDATE SET
        challenge = EXCLUDED.challenge,
        reward = EXCLUDED.reward,
        reward_amount = EXCLUDED.reward_amount,
        sacrifice = EXCLUDED.sacrifice,
        sacrifice_amount = EXCLUDED.sacrifice_amount,
        mean_chaos = EXCLUDED.mean_chaos,
        divine_value = EXCLUDED.divine_value,
        reward_price = EXCLUDED.reward_price,
        sacrifice_price = EXCLUDED.sacrifice_price,
        low_confidence = EXCLUDED.low_confidence,
        updated_at = EXCLUDED.updated_at
    `;

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    if (batchNum % 5 === 0 || batchNum === totalBatches) {
      console.log(`  Upserted batch ${batchNum}/${totalBatches}`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s — ${items.length} upserted`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
