/**
 * Fetches per-gem player counts from poe.ninja builds and stores them
 * in the database for the gem-leveling calculator.
 *
 * Usage:
 *   npx tsx src/refresh-gem-usage.ts [league]
 *
 * With no league argument the worker discovers the leagues poe.ninja tracks
 * builds for, reduces them to the priced set (Standard + the challenge league
 * and its HC variant, poe.ninja keeps no permanent-Hardcore snapshot), and
 * refreshes each, so it follows league rollovers with no workflow edit. Pass an
 * explicit league name for an ad-hoc run.
 *
 * Designed to run every 6 hours via GitHub Actions cron. Each run fetches
 * three URLs from poe.ninja per league (~225 KB), decodes the protobuf, and
 * upserts ~800 rows into the `ninja_gem_usage` table.
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
import { discoverPoe1Leagues } from "./lib/ninja-leagues";
import { selectPricedSet } from "./lib/priced-set";

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
// Per-league refresh
// ---------------------------------------------------------------------------

type BuildLeague = { url: string; name: string; version: string };

/**
 * Fetch, decode, and upsert one league's gem usage. Skips (returns without
 * writing) when poe.ninja has no snapshot yet (404) or returns an
 * implausibly small response, both are transient, not run-failing. Throws on
 * a genuine poe.ninja error so the run fails loud.
 */
async function refreshOneLeague(sql: postgres.Sql, match: BuildLeague): Promise<void> {
  console.log(
    `[gem-usage] ${match.name}: snapshot version ${match.version} (url: ${match.url})`,
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
        `[gem-usage] snapshot ${match.version} for league=${match.name} returned 404, skipping (likely a low-population variant or a stale index-state). ${msg}`,
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
    `[gem-usage] ${match.name}: decoded ${result.counts.size} gems, ${totalPlayers.toLocaleString()} total skill-gem usages, in ${fetchMs}ms`,
  );

  // Sanity guard: a too-small response usually means poe.ninja shipped a
  // schema change or is mid-rebuild. Log + skip without touching DB so
  // we don't accidentally wipe the table via the prune step.
  if (result.counts.size < MIN_PLAUSIBLE_GEM_COUNT) {
    console.warn(
      `[gem-usage] ${match.name}: decoded only ${result.counts.size} gems (< ${MIN_PLAUSIBLE_GEM_COUNT} threshold), skipping DB write to avoid pruning healthy data on a flaky response.`,
    );
    return;
  }

  const now = new Date();
  const upserted = await upsertGemUsage(
    sql,
    GAME,
    result.league,
    result.snapshotVersion,
    result.counts,
    now,
  );
  console.log(`[gem-usage] ${match.name}: upserted ${upserted} rows`);

  const pruned = await pruneStale(sql, GAME, result.league, result.snapshotVersion);
  console.log(`[gem-usage] ${match.name}: pruned ${pruned} stale rows`);
}

// ---------------------------------------------------------------------------
// League resolution
// ---------------------------------------------------------------------------

/** The build snapshots to refresh: the one matching an explicit name for
 *  ad-hoc runs, else the priced set for the current leagues.
 *
 *  Which leagues are *current* comes from poe.ninja's index-state
 *  (`discoverPoe1Leagues`), not from the build-snapshot list, the latter is
 *  historical and full of past challenge leagues and private leagues, so it
 *  can't tell you which league is live. The build list is used only to look up
 *  each current league's snapshot version. poe.ninja keeps no
 *  permanent-Hardcore build snapshot, so that is dropped from the priced set. */
async function resolveTargets(explicit: string | undefined): Promise<BuildLeague[]> {
  const buildLeagues = await listBuildLeagues();

  if (explicit) {
    const match = buildLeagues.find((l) => l.name === explicit);
    if (!match) {
      console.warn(
        `[gem-usage] no build snapshot for league=${explicit}, skipping. available: ${buildLeagues
          .map((l) => l.name)
          .join(", ")}`,
      );
      return [];
    }
    return [match];
  }

  const current = await discoverPoe1Leagues();
  const wanted = selectPricedSet(
    current.map((name) => ({ name })),
    { includePermanentHardcore: false },
  );

  const targets: BuildLeague[] = [];
  for (const name of wanted) {
    const match = buildLeagues.find((l) => l.name === name);
    if (!match) {
      // A league can be indexed before its build snapshot lands. Skip it this
      // run, the next one picks it up.
      console.warn(`[gem-usage] ${name}: no build snapshot yet, skipping`);
      continue;
    }
    targets.push(match);
  }

  if (targets.length === 0) {
    console.log(
      "[gem-usage] no priced build leagues right now (between leagues), nothing to refresh.",
    );
  } else {
    console.log(
      `[gem-usage] refreshing ${targets.length} leagues: ${targets.map((t) => t.name).join(", ")}`,
    );
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith("--"));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[gem-usage] DATABASE_URL is required");
    process.exit(1);
  }

  const targets = await resolveTargets(explicit);
  if (targets.length === 0) return;

  const sql = postgres(databaseUrl, {
    idle_timeout: 30,
    max_lifetime: 300,
  });

  let firstError: unknown = null;
  try {
    for (const match of targets) {
      try {
        await refreshOneLeague(sql, match);
      } catch (err) {
        console.error(
          `[gem-usage] ${match.name} failed:`,
          err instanceof Error ? err.message : err,
        );
        // Keep going so one bad league does not abort the rest of the refresh.
        if (firstError == null) firstError = err;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (firstError != null) process.exit(1);
}

main().catch((err) => {
  console.error("[gem-usage] fatal:", err);
  process.exit(1);
});
