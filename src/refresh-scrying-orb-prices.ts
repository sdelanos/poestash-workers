/**
 * Fetches Scrying Orb prices from poe.watch and stores them in the database.
 *
 * Usage:
 *   npx tsx src/refresh-scrying-orb-prices.ts [league] [--dry-run]
 *
 * With no league argument the worker discovers the priced set from poe.watch
 * itself (Standard, Hardcore, the live challenge league + its HC variant) and
 * refreshes each, so it follows league rollovers with no workflow edit. Pass an
 * explicit league name for an ad-hoc run. --dry-run resolves and fetches
 * without writing to the database.
 *
 * Designed to run daily via GitHub Actions cron. One poe.watch currency call
 * per league; the ~100 "Scrying Orb (<map area>)" variants become one row per
 * (league, map_name) in scrying_orb_prices.
 *
 * Orbs are not Currency Exchange items, so poe.ninja never carries them —
 * poe.watch is the sole source. Rows are never deleted by this worker: a
 * poe.watch outage leaves prior rows intact and exits non-zero for visibility,
 * and staleness is surfaced app-side from last_refreshed_at.
 *
 * Requires DATABASE_URL environment variable (not needed for --dry-run).
 */

import "dotenv/config";
import postgres from "postgres";
import { discoverPoeWatchLeagues } from "./lib/poe-watch-leagues";
import { selectPricedSet } from "./lib/priced-set";
import {
  selectScryingOrbRows,
  type PoeWatchCurrencyItem,
  type ScryingOrbRow,
} from "./lib/scrying-orbs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POE_WATCH_BASE = "https://api.poe.watch";

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const COLUMNS = [
  "league", "map_name", "mean_chaos", "daily_sold", "low_confidence",
  "last_refreshed_at",
] as const;

function toDbRow(row: ScryingOrbRow, league: string, now: Date) {
  return {
    league,
    map_name: row.mapArea,
    mean_chaos: row.mean,
    daily_sold: row.daily,
    low_confidence: row.lowConfidence,
    last_refreshed_at: now,
  };
}

// ---------------------------------------------------------------------------
// Per-league refresh
// ---------------------------------------------------------------------------

/**
 * Fetch + upsert one league's Scrying Orb prices. Returns the number of rows
 * written (or, in dry-run, that would be written), or null when poe.watch has
 * no orb data for the league yet — a league it just rolled, or one it lists
 * but hasn't priced. That is absence, not an outage, so we skip and keep
 * going. Throws on a genuine poe.watch error so the run fails loud.
 */
async function refreshOneLeague(
  sql: postgres.Sql | null,
  league: string,
): Promise<number | null> {
  const url = `${POE_WATCH_BASE}/get?category=currency&league=${encodeURIComponent(league)}`;
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

  const items: PoeWatchCurrencyItem[] | null = await res.json();
  const rows = selectScryingOrbRows(items ?? []);
  if (rows.length === 0) {
    console.log(`  ${league}: no Scrying Orb data, skipping`);
    return null;
  }

  const highConf = rows.filter((r) => !r.lowConfidence).length;
  console.log(`  ${league}: fetched ${rows.length} orb variants (${highConf} high confidence)`);

  // No sql handle means a dry run: report the count without writing.
  if (!sql) return rows.length;

  const now = new Date();
  const dbRows = rows.map((row) => toDbRow(row, league, now));

  await sql`
    INSERT INTO scrying_orb_prices ${sql(dbRows, ...COLUMNS)}
    ON CONFLICT (league, map_name) DO UPDATE SET
      mean_chaos = EXCLUDED.mean_chaos,
      daily_sold = EXCLUDED.daily_sold,
      low_confidence = EXCLUDED.low_confidence,
      last_refreshed_at = EXCLUDED.last_refreshed_at
  `;

  return rows.length;
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
        prepare: false,
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
