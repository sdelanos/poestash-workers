/**
 * Fetches per-gem player counts from poe.ninja builds and stores them
 * in the database for the gem-leveling calculator.
 *
 * Usage:
 *   npx tsx src/refresh-gem-usage.ts [league]
 *
 * Options:
 *   league   League name as it appears on poe.ninja (default: Mirage).
 *            Common targets: "Mirage", "Hardcore Mirage", "Standard".
 *            Note: poe.ninja does NOT track builds for permanent "Hardcore"
 *            (no snapshot exists). The worker logs a warning and exits 0
 *            in that case so the workflow still continues.
 *
 * Designed to run every 6 hours via GitHub Actions cron. Each run fetches
 * three URLs from poe.ninja (~225 KB), decodes the protobuf, and upserts
 * ~800 rows into the `ninja_gem_usage` table for one league.
 *
 * Requires DATABASE_URL environment variable.
 */

import "dotenv/config";
import postgres from "postgres";
import {
  fetchGemUsage,
  listBuildLeagues,
  type GemUsageResult,
} from "./lib/poeninja-builds";

const GAME = "poe1";

/** Below this many gems, treat the fetch as suspicious and refuse to prune
 *  stale rows. Empty / tiny responses usually mean poe.ninja shipped a
 *  schema change or is in the middle of a snapshot rebuild. The current
 *  Mirage league returns ~800 gems; new leagues start at ~600+. */
const MIN_PLAUSIBLE_GEM_COUNT = 200;

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------

const COLUMNS = [
  "game", "league", "gem_name", "player_count", "snapshot_version", "refreshed_at",
] as const;

async function upsertGemUsage(
  sql: postgres.Sql,
  game: string,
  league: string,
  snapshotVersion: string,
  counts: Map<string, number>,
  now: Date,
): Promise<number> {
  if (counts.size === 0) return 0;

  const rows = Array.from(counts.entries()).map(([gem_name, player_count]) => ({
    game,
    league,
    gem_name,
    player_count,
    snapshot_version: snapshotVersion,
    refreshed_at: now,
  }));

  // Batch upsert. 800 rows is well under any sane batch limit, single transaction.
  await sql`
    INSERT INTO ninja_gem_usage ${sql(rows, ...COLUMNS)}
    ON CONFLICT (game, league, gem_name) DO UPDATE SET
      player_count = EXCLUDED.player_count,
      snapshot_version = EXCLUDED.snapshot_version,
      refreshed_at = EXCLUDED.refreshed_at
  `;

  return rows.length;
}

/**
 * Drop any rows for this league that weren't part of the latest snapshot.
 * Keeps the table size bounded and prevents stale gems from lingering when
 * GGG retires a transfigured gem mid-league.
 */
async function pruneStale(
  sql: postgres.Sql,
  game: string,
  league: string,
  snapshotVersion: string,
): Promise<number> {
  const result = await sql`
    DELETE FROM ninja_gem_usage
    WHERE game = ${game}
      AND league = ${league}
      AND snapshot_version <> ${snapshotVersion}
  `;
  return result.count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const requestedLeague = process.argv[2] || "Mirage";

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[gem-usage] DATABASE_URL is required");
    process.exit(1);
  }

  // Look up the snapshot version for the requested league.
  console.log(`[gem-usage] resolving snapshot for league=${requestedLeague}`);
  const leagues = await listBuildLeagues();
  const match = leagues.find((l) => l.name === requestedLeague);
  if (!match) {
    // Permanent leagues (Hardcore, SSF Standard, ...) don't always have
    // build snapshots on poe.ninja. Don't fail the workflow for these —
    // log and exit cleanly so the next league can run.
    console.warn(
      `[gem-usage] no build snapshot for league=${requestedLeague}, skipping. available: ${leagues
        .map((l) => l.name)
        .join(", ")}`,
    );
    return;
  }

  console.log(
    `[gem-usage] snapshot version: ${match.version} (league url: ${match.url})`,
  );

  // Fetch + decode. Tolerate 404 — fresh snapshots can lag behind
  // index-state for a few minutes, and poe.ninja occasionally returns
  // 404 for low-population HC variants.
  const t0 = Date.now();
  let result: GemUsageResult;
  try {
    result = await fetchGemUsage(match.name, match.version);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/.test(msg)) {
      console.warn(
        `[gem-usage] snapshot ${match.version} for league=${requestedLeague} returned 404, skipping (likely a low-population variant or a stale index-state). ${msg}`,
      );
      return;
    }
    throw err;
  }
  const fetchMs = Date.now() - t0;
  const totalPlayers = Array.from(result.counts.values()).reduce(
    (s, c) => s + c,
    0,
  );
  console.log(
    `[gem-usage] decoded ${result.counts.size} gems, ${totalPlayers.toLocaleString()} total skill-gem usages, in ${fetchMs}ms`,
  );

  // Sanity guard: a too-small response usually means poe.ninja shipped a
  // schema change or is mid-rebuild. Log + exit 0 without touching DB so
  // we don't accidentally wipe the table via the prune step.
  if (result.counts.size < MIN_PLAUSIBLE_GEM_COUNT) {
    console.warn(
      `[gem-usage] decoded only ${result.counts.size} gems (< ${MIN_PLAUSIBLE_GEM_COUNT} threshold), skipping DB write to avoid pruning healthy data on a flaky response.`,
    );
    return;
  }

  // Upsert
  const sql = postgres(databaseUrl, {
    idle_timeout: 30,
    max_lifetime: 300,
  });

  try {
    const now = new Date();

    const upserted = await upsertGemUsage(
      sql,
      GAME,
      result.league,
      result.snapshotVersion,
      result.counts,
      now,
    );
    console.log(`[gem-usage] upserted ${upserted} rows`);

    const pruned = await pruneStale(
      sql,
      GAME,
      result.league,
      result.snapshotVersion,
    );
    console.log(`[gem-usage] pruned ${pruned} stale rows`);

    // Print top 10 for sanity
    const top = Array.from(result.counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    console.log(`[gem-usage] top 10:`);
    for (const [name, count] of top) {
      console.log(`  ${count.toLocaleString().padStart(8)}  ${name}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[gem-usage] fatal:", err);
  process.exit(1);
});
