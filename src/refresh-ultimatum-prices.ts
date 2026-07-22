/**
 * Fetches Inscribed Ultimatum prices from poe.watch and stores them in the database.
 *
 * Usage:
 *   npx tsx src/refresh-ultimatum-prices.ts [league] [--dry-run]
 *
 * With no league argument the worker discovers the priced set from poe.watch
 * itself (Standard, Hardcore, the live challenge league + its HC variant) and
 * refreshes each, so it follows league rollovers with no workflow edit. Pass an
 * explicit league name for an ad-hoc run. --dry-run resolves and fetches
 * without writing to the database.
 *
 * Designed to run hourly via GitHub Actions cron.
 * Each run does a full refresh: fetch from poe.watch, batch upsert.
 *
 * Rows are never deleted by this worker. poe.watch serves combos
 * intermittently based on liquidity — keeping the last-known price is
 * strictly better than serving 0c during a refresh gap. League-level
 * staleness is implicit in updated_at on individual rows.
 *
 * Requires DATABASE_URL environment variable (not needed for --dry-run).
 */

import "dotenv/config";
import postgres from "postgres";
import { discoverPoeWatchLeagues } from "./lib/poe-watch-leagues";
import { selectPricedSet } from "./lib/priced-set";

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
// Per-league refresh
// ---------------------------------------------------------------------------

/**
 * Fetch + upsert one league's Inscribed Ultimatum prices. Returns the number
 * of rows written (or, in dry-run, that would be written), or null when
 * poe.watch has no data for the league yet, a league it just rolled, or one
 * it lists but hasn't priced. That is absence, not an outage, so we skip and
 * keep going. Throws on a genuine poe.watch error so the run fails loud.
 */
async function refreshOneLeague(
  sql: postgres.Sql | null,
  league: string,
): Promise<number | null> {
  const url = `${POE_WATCH_BASE}/inscribed?league=${encodeURIComponent(league)}`;
  const res = await fetch(url);

  // poe.watch answers a league it doesn't know with 400 "league doesn't
  // exist". Treat that as absence, skip this league rather than fail the run.
  if (res.status === 400) {
    console.log(`  ${league}: not indexed by poe.watch (yet), skipping`);
    return null;
  }
  if (!res.ok) {
    throw new Error(`poe.watch returned ${res.status} ${res.statusText} for ${league}`);
  }

  const items: PoeWatchInscribed[] | null = await res.json();
  if (!items || items.length === 0) {
    console.log(`  ${league}: no Inscribed Ultimatum data, skipping`);
    return null;
  }

  const highConf = items.filter((i) => !i.low_confidence).length;
  console.log(`  ${league}: fetched ${items.length} items (${highConf} high confidence)`);

  // No sql handle means a dry run: report the count without writing.
  if (!sql) return items.length;

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
      console.log(`    ${league}: upserted batch ${batchNum}/${totalBatches}`);
    }
  }

  return items.length;
}

// ---------------------------------------------------------------------------
// League resolution
// ---------------------------------------------------------------------------

/** The leagues to refresh: an explicit name for ad-hoc runs, else the priced
 *  set poe.watch currently serves. Discovery throws on a poe.watch outage, so
 *  a genuine failure is loud; the between-leagues gap resolves to just the
 *  permanent leagues (never empty for PoE 1). */
async function resolveLeagues(explicit: string | undefined): Promise<string[]> {
  if (explicit) return [explicit];

  const discovered = await discoverPoeWatchLeagues();
  const leagues = selectPricedSet(discovered);
  if (leagues.length === 0) {
    console.log(
      "No priced leagues on poe.watch right now (between leagues), nothing to refresh.",
    );
  } else {
    console.log(`Refreshing ${leagues.length} leagues: ${leagues.join(", ")}`);
  }
  return leagues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const explicit = args.find((a) => !a.startsWith("--"));

  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = dryRun
    ? null
    : postgres(process.env.DATABASE_URL!, {
        idle_timeout: 30,
        max_lifetime: 300,
        connect_timeout: 10,
        transform: { undefined: null },
      });

  const start = Date.now();
  let firstError: unknown = null;
  let totalUpserted = 0;

  try {
    const leagues = await resolveLeagues(explicit);

    for (const league of leagues) {
      try {
        const n = await refreshOneLeague(sql, league);
        if (n != null) totalUpserted += n;
      } catch (err) {
        console.error(
          `  ${league} failed:`,
          err instanceof Error ? err.message : err,
        );
        // Keep going so one bad league does not abort the rest of the refresh.
        if (firstError == null) firstError = err;
      }
    }
  } finally {
    if (sql) await sql.end();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const verb = dryRun ? "would upsert" : "upserted";
  console.log(`Done in ${elapsed}s${dryRun ? " (dry-run)" : ""}, ${verb} ${totalUpserted} rows`);

  if (firstError != null) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
