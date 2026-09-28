/**
 * Builds the Warrant price corpus from the public stash river.
 *
 * Usage:
 *   npx tsx src/refresh-warrant-corpus.ts [--dry-run] [--pages N]
 *                                         [--behind N] [--raw-out FILE]
 *
 * A Warrant is never priced, because every copy is a distinct combination of
 * Mercenary skills, supports and tiers and nothing aggregates it. The obvious
 * fix — enumerating combinations against the trade API — is arithmetically
 * impossible: ADR 0022 pins that budget at 30 requests per 300s across the
 * whole application, against hundreds of supports and tiers.
 *
 * The river sidesteps it. ~2-3% of every item crossing the public stash stream
 * is a Warrant (measured: 714 in 24,628 items, in 29 seconds), most carry a
 * price, and the whole listed market cycles past in minutes. So the
 * combinations sample *themselves*, nothing is enumerated, and the river's
 * rate limit is a separate and generous policy that costs zero trade budget.
 *
 * **The run is a sample, never a stream.** It seeks to the live tail by
 * bisection (see `lib/stash-river.ts`), steps back a fixed distance to give
 * itself a backlog to drain at full pace, drains a bounded number of pages,
 * and stops. No cursor is persisted, so a late, interrupted or repeated run
 * samples a later slice of the same market rather than falling behind — there
 * is no catch-up debt and no staleness bug.
 *
 * **What is written is the aggregate, never the observations.** At ~866 listed
 * Warrants a minute, logging each one is ~1.25M rows and ~500MB a day, which
 * would double the database inside a week. The worker aggregates in memory and
 * writes one row per (league, support, tier) — a few thousand per league,
 * overwritten in place, bounded however long it runs. The raw sample goes to
 * an NDJSON file the workflow keeps as a free Actions artifact, which is where
 * anything wanting to re-analyse the corpus reads it from.
 *
 * This worker ships no player-facing figure. It exists to answer ADR 0060's
 * open question — whether a (support, tier) axis separates Warrant prices —
 * with the market measurement that ADR demanded of anyone narrowing the query.
 *
 * Requires POE_CLIENT_ID and POE_CLIENT_SECRET; DATABASE_URL unless --dry-run.
 */

import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import postgres from "postgres";
import { getRiverToken, StashRiver, syntheticChangeId, seekToTail } from "./lib/stash-river";
import { toChaos } from "./lib/listing-price";
import {
  readWarrantObservations,
  WARRANT_BASE_TYPE,
  type WarrantObservation,
} from "./lib/warrant-observation";
import { buildCorpus, dedupeObservations, type PricedObservation } from "./lib/warrant-corpus";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Pages to drain. ~30 stashes and ~28 priced Warrants a page near the tail. */
const DEFAULT_PAGES = 300;
/** Change-id units to step back from the tail, so there is a backlog to drain
 *  at full pace instead of idling on the live edge. ~2e6 held a drain busy for
 *  well past 25 pages when measured. */
const DEFAULT_BEHIND = 2_000_000;
/** Wall-clock ceiling, so the run ends on time even if pages come slowly. */
const MAX_ELAPSED_MS = 12 * 60_000;
/** Below this, a league's sample is noise and no row is written for it. This
 *  is what keeps private leagues (`Some League (PL12345)`) out on their own. */
const MIN_LEAGUE_SAMPLE = 100;

const BATCH_SIZE = 500;

/** GGG's price slug → the poe.ninja `item_name` that carries its chaos rate.
 *  Only what actually shows up on Warrants: chaos, divine and mirror were the
 *  whole distribution in a 714-Warrant sample, with exalted and annul added
 *  because they cost nothing to support. Anything else is counted and dropped
 *  rather than converted at a guessed rate. */
const CURRENCY_SLUGS: Record<string, string> = {
  chaos: "chaos orb",
  divine: "divine orb",
  exalted: "exalted orb",
  mirror: "mirror of kalandra",
  annul: "orb of annulment",
};

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

const COLUMNS = [
  "league", "support_hash", "support_name", "tier", "sample_count",
  "median_chaos", "p25_chaos", "p75_chaos", "baseline_count",
  "baseline_median_chaos", "separation_auc", "stratified_auc", "strata_count",
  "strata_above", "league_sample_count", "updated_at",
] as const;

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

interface DrainResult {
  observations: WarrantObservation[];
  pages: number;
  stashes: number;
  items: number;
  /** Warrants seen at all, priced or not — the denominator for the price rate. */
  warrants: number;
}

/**
 * Drain forward from `from`, keeping only Warrants. Stops on the page budget,
 * the wall clock, or a stream that has run dry — whichever comes first.
 *
 * Raw observations are appended to `rawOut` as they are read rather than held
 * and written at the end, so an interrupted run still leaves the slice it did
 * manage to sample.
 */
async function drain(
  river: StashRiver,
  from: string,
  maxPages: number,
  deadline: number,
  rawOut: string | null,
): Promise<DrainResult> {
  const observations: WarrantObservation[] = [];
  let cursor = from;
  let pages = 0;
  let stashes = 0;
  let items = 0;
  let warrants = 0;

  while (pages < maxPages && Date.now() < deadline) {
    const page = await river.page(cursor);
    pages++;

    stashes += page.stashes.length;
    for (const s of page.stashes) {
      for (const it of s.items ?? []) {
        items++;
        if (it.baseType === WARRANT_BASE_TYPE) warrants++;
      }
    }

    const found = readWarrantObservations(page.stashes);
    observations.push(...found);
    if (rawOut && found.length > 0) {
      appendFileSync(rawOut, found.map((o) => JSON.stringify(o)).join("\n") + "\n");
    }

    if (pages % 25 === 0) {
      console.log(
        `  page ${pages}/${maxPages}: ${items} items, ${warrants} Warrants, ` +
          `${observations.length} priced`,
      );
    }

    // No next id, or one that does not advance, means the stream has nothing
    // more to give this run. That is the sample ending, not a failure.
    if (!page.nextChangeId || page.nextChangeId === cursor) {
      console.log(`  stream caught up after ${pages} pages`);
      break;
    }
    cursor = page.nextChangeId;
  }

  return { observations, pages, stashes, items, warrants };
}

// ---------------------------------------------------------------------------
// Chaos conversion
// ---------------------------------------------------------------------------

/** Per-league `slug → chaos` rates, from the same `ninja_prices` feed the
 *  other trade workers convert against. Leagues poe.ninja has not priced get
 *  no entry, and their Warrants leave the corpus — which is also what keeps
 *  private leagues out. */
async function loadChaosRates(
  sql: postgres.Sql,
  leagues: string[],
): Promise<Map<string, Map<string, number>>> {
  const names = Object.values(CURRENCY_SLUGS);
  const rows = await sql<{ league: string; item_name: string; chaos_value: number; source: string }[]>`
    SELECT league, item_name, chaos_value, source FROM ninja_prices
    WHERE game = 'poe1' AND league = ANY(${leagues}) AND item_name = ANY(${names})
  `;

  const best = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.league}|${r.item_name}`;
    // Prefer the exchange source when both exist, matching the app's dedup.
    if (!best.has(key) || r.source === "exchange") best.set(key, Number(r.chaos_value));
  }

  const byLeague = new Map<string, Map<string, number>>();
  for (const league of leagues) {
    const rates = new Map<string, number>([["chaos", 1]]);
    for (const [slug, name] of Object.entries(CURRENCY_SLUGS)) {
      const v = best.get(`${league}|${name}`);
      if (v && v > 0) rates.set(slug, v);
    }
    byLeague.set(league, rates);
  }
  return byLeague;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function numericArg(args: string[], flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const maxPages = numericArg(args, "--pages", DEFAULT_PAGES);
  const behind = numericArg(args, "--behind", DEFAULT_BEHIND);
  const rawOutIdx = args.indexOf("--raw-out");
  const rawOut = rawOutIdx === -1 ? null : (args[rawOutIdx + 1] ?? null);

  const clientId = process.env.POE_CLIENT_ID;
  const clientSecret = process.env.POE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("POE_CLIENT_ID and POE_CLIENT_SECRET are required");
    process.exit(1);
  }
  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  if (rawOut) {
    mkdirSync(dirname(rawOut), { recursive: true });
    // Truncate: the file is this run's sample, not an accumulating log.
    writeFileSync(rawOut, "");
  }

  const start = Date.now();
  const deadline = start + MAX_ELAPSED_MS;

  const token = await getRiverToken(clientId, clientSecret, userAgent);
  const river = new StashRiver(token, userAgent);

  const { position, probes } = await seekToTail((id) => river.hasStashes(id));
  console.log(`Tail found at ~${position} in ${probes} probes; stepping back ${behind}`);

  const drained = await drain(
    river,
    syntheticChangeId(position - behind),
    maxPages,
    deadline,
    rawOut,
  );

  // Tier 1 of the failure contract. A drain that saw no items at all means the
  // seek landed somewhere dead or the river stopped serving — and neither
  // announces itself, because an empty page is a 200. Exiting 0 here would
  // report a healthy run that sampled nothing and quietly left the corpus at
  // whatever the last good run wrote, which is the silent staleness ADR 0003
  // exists to prevent.
  if (drained.items === 0) {
    throw new Error(
      `river returned no items at all from ${drained.pages} page(s) at ~${position - behind}; ` +
        `the seek is dead or the stream is empty`,
    );
  }

  const pricedRate =
    drained.warrants > 0 ? (100 * drained.observations.length) / drained.warrants : 0;
  const warrantRate = drained.items > 0 ? (100 * drained.warrants) / drained.items : 0;
  console.log(
    `Drained ${drained.pages} pages / ${drained.stashes} stashes / ${drained.items} items ` +
      `in ${river.requests} requests: ${drained.warrants} Warrants (${warrantRate.toFixed(2)}% ` +
      `of items), ${drained.observations.length} priced (${pricedRate.toFixed(0)}%)`,
  );

  // Deduping is what makes an overlapping or repeated run idempotent: the same
  // tab crossing the river twice must not weight one seller's prices twice.
  const unique = dedupeObservations(drained.observations);
  if (unique.length < drained.observations.length) {
    console.log(`  ${drained.observations.length - unique.length} relistings deduped by item id`);
  }

  const leagues = [...new Set(unique.map((o) => o.league))];
  console.log(`  ${leagues.length} leagues in the sample`);

  // A dry run still reads. Most Warrants are priced in divine, so without the
  // `ninja_prices` rates the sample loses its expensive half and the measurement
  // is not the measurement. --dry-run means "write nothing", not "read nothing".
  const sql = process.env.DATABASE_URL
    ? postgres(process.env.DATABASE_URL, {
        idle_timeout: 30,
        max_lifetime: 300,
        prepare: false,
        connect_timeout: 10,
        transform: { undefined: null },
      })
    : null;

  try {
    const rates = sql
      ? await loadChaosRates(sql, leagues)
      : new Map(leagues.map((l) => [l, new Map([["chaos", 1]])]));

    const priced: PricedObservation[] = [];
    let unconvertible = 0;
    for (const o of unique) {
      const chaos = toChaos(o.price, rates.get(o.league) ?? new Map());
      if (chaos == null) unconvertible++;
      else priced.push({ observation: o, chaos });
    }
    if (unconvertible > 0) {
      console.log(`  ${unconvertible} observations dropped: no chaos rate for their currency`);
    }

    const rows = buildCorpus(priced).filter((r) => r.leagueSampleCount >= MIN_LEAGUE_SAMPLE);
    const kept = [...new Set(rows.map((r) => r.league))];
    console.log(
      `Corpus: ${rows.length} (support, tier) rows across ${kept.length} leagues ` +
        `[${kept.join(", ")}] from ${priced.length} priced Warrants`,
    );

    if (dryRun || !sql) {
      console.log(`Done in ${((Date.now() - start) / 1000).toFixed(0)}s (dry-run), wrote nothing`);
      return;
    }

    const now = new Date();
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE).map((r) => ({
        league: r.league,
        support_hash: r.supportHash,
        support_name: r.supportName,
        tier: r.tier,
        sample_count: r.sampleCount,
        median_chaos: r.medianChaos,
        p25_chaos: r.p25Chaos,
        p75_chaos: r.p75Chaos,
        baseline_count: r.baselineCount,
        baseline_median_chaos: r.baselineMedianChaos,
        separation_auc: r.separationAuc,
        stratified_auc: r.stratifiedAuc,
        strata_count: r.strataCount,
        strata_above: r.strataAbove,
        league_sample_count: r.leagueSampleCount,
        updated_at: now,
      }));

      // Overwrite in place on the natural key. Repeating a run replaces a
      // league's rows with a fresher sample; it never appends, so the table
      // stays bounded by (supports × tiers × leagues) however often it runs.
      // The sweep below finishes the job for pairs this run did not see.
      await sql`
        INSERT INTO warrant_support_price_samples ${sql(batch, ...COLUMNS)}
        ON CONFLICT (league, support_hash, tier) DO UPDATE SET
          support_name = EXCLUDED.support_name,
          sample_count = EXCLUDED.sample_count,
          median_chaos = EXCLUDED.median_chaos,
          p25_chaos = EXCLUDED.p25_chaos,
          p75_chaos = EXCLUDED.p75_chaos,
          baseline_count = EXCLUDED.baseline_count,
          baseline_median_chaos = EXCLUDED.baseline_median_chaos,
          separation_auc = EXCLUDED.separation_auc,
          stratified_auc = EXCLUDED.stratified_auc,
          strata_count = EXCLUDED.strata_count,
          strata_above = EXCLUDED.strata_above,
          league_sample_count = EXCLUDED.league_sample_count,
          updated_at = EXCLUDED.updated_at
      `;
    }

    // Every row of a league must come from ONE drain. Without this, a pair
    // that appeared last run but not this one keeps its old `separation_auc`
    // sitting beside a fresh row's `league_sample_count` — two samples read as
    // one, which is exactly the double-count the corpus is supposed to refuse.
    // Scoped to the leagues this run actually wrote, so a league that was not
    // sampled at all keeps its last good corpus rather than being emptied, and
    // scoped by `updated_at` so an interrupted run deletes nothing.
    let swept = 0;
    for (const league of kept) {
      const gone = await sql`
        DELETE FROM warrant_support_price_samples
        WHERE league = ${league} AND updated_at < ${now}
      `;
      swept += gone.count;
    }

    console.log(
      `Done in ${((Date.now() - start) / 1000).toFixed(0)}s, upserted ${rows.length} rows` +
        (swept > 0 ? `, swept ${swept} pairs this run did not see` : ""),
    );
  } finally {
    if (sql) await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
