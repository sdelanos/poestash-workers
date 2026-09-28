/**
 * Prices the rare slots of the build guides players paste into a Roast, into
 * `roast_reference_prices` (poestash #127, app ADR 0022).
 *
 * A Roast tells a player which rares to buy. Pricing them inside the request is
 * arithmetically impossible — ten slots at one trade request per ten seconds is
 * a hundred seconds of the *platform's entire* trade budget for one page load —
 * so the app never queries trade at all. It writes a row per rare slot of the
 * guide, keyed on a fingerprint of that guide, and this worker fills in the
 * figures. The first Roast against an unseen guide therefore shows labelled
 * estimate bands and asks for it to be priced; every later Roast against the
 * same guide reads what this run left behind.
 *
 * That works because a Reference is a repeat entity: most players follow one of
 * a few dozen popular guides, so the keyspace is small, shared and — unlike the
 * cluster and split catalogues — *self-enumerating*. The app seeds every row it
 * wants priced. This worker never invents one.
 *
 * Usage:
 *   npx tsx src/refresh-roast-rare-prices.ts [league] [--limit=N]
 *
 * With no league argument the worker resolves the current challenge league at
 * run time (see lib/trade-league.ts), so it follows league rollovers with no
 * workflow edit. Pass an explicit league name for an ad-hoc run.
 *
 * **Sharing the budget.** This is the fourth consumer of a quota metered on our
 * whole application identity at roughly six requests a minute, and the other
 * three can each run for hours. So it deliberately yields rather than competes:
 * it paces slower than they do, caps how many markets one run will touch, and
 * abandons the run entirely after a handful of rate-limit hits instead of
 * fighting for the window. Nothing here is urgent — a guide priced two runs
 * late costs one player one banded row.
 *
 * Requires DATABASE_URL and POE_CLIENT_ID.
 */

import "dotenv/config";
import postgres from "postgres";
import { ladderFloorChaos, type ListingPrice } from "./lib/split-ladder";
import { resolveTradeLeague } from "./lib/trade-league";
import { buildRareSearchQuery, type RoastRareMarket } from "./lib/roast-rare-query";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADE_BASE = "https://www.pathofexile.com/api/trade";

/** Rate limits: 5/10s, 15/60s, 30/300s. 30/300s binds at one request per ~10s
 *  for a worker running alone. This one is not alone — see the header — so it
 *  takes 15s and leaves the difference to the workers that serve every user. */
const PAUSE_MS = 15_000;

/** Cheapest listings fetched per market, for the ladder floor. */
const SAMPLE_SIZE = 10;

/** Markets one run will price. Two requests each, at PAUSE_MS apart, so this is
 *  about 15 minutes of trade calls — a short visit to a window the long cluster
 *  and split runs occupy most of, rather than a second long occupant of it. A
 *  longer queue simply finishes next run: unpriced rows sort first, so nothing
 *  starves. */
const MAX_MARKETS_PER_RUN = 30;

/** Rate-limit hits after which the run gives up and leaves the window to
 *  whoever else is in it. Backing off is the whole strategy. */
const MAX_RATE_LIMIT_HITS = 5;

/** How stale a figure may get before it is re-sampled. Matches the 24h window
 *  the cluster and split workers use for a live market. */
const FRESH_MS = 24 * 3_600_000;

/** A guide nobody has pasted in this long stops being priced and is dropped.
 *  Mirrors `REFERENCE_SEEN_RETENTION_MS` in the app, which writes the
 *  `last_seen_at` this reads. */
const SEEN_RETENTION_DAYS = 30;

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

/** poe.ninja currency names → trade API currency slugs, same set as the other
 *  trade workers so the conversion table stays consistent across the repo. */
const CURRENCY_SLUGS: Record<string, string> = {
  chaos: "chaos orb",
  divine: "divine orb",
  exalted: "exalted orb",
  mirror: "mirror of kalandra",
};

// ---------------------------------------------------------------------------
// Trade API
// ---------------------------------------------------------------------------

interface SampleResult {
  listingCount: number;
  floorChaos: number | null;
  /** Seconds to wait, when the platform told us to wait. */
  rateLimited?: number;
}

async function sampleMarket(
  league: string,
  market: RoastRareMarket,
  currencyToChaos: Map<string, number>,
): Promise<SampleResult> {
  const headers = { "User-Agent": userAgent, "Content-Type": "application/json" };

  const searchRes = await fetch(`${TRADE_BASE}/search/${encodeURIComponent(league)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRareSearchQuery(market)),
    signal: AbortSignal.timeout(15_000),
  });

  if (searchRes.status === 429) {
    return {
      listingCount: 0,
      floorChaos: null,
      rateLimited: parseInt(searchRes.headers.get("Retry-After") ?? "60", 10),
    };
  }
  if (!searchRes.ok) throw new Error(`Search ${searchRes.status}: ${await searchRes.text()}`);

  const searchData: { id: string; total: number; result: string[] } = await searchRes.json();
  // A guide's rare at the guide's own rolls can genuinely have no listings.
  // That is an answer, not a failure: the app keeps banding the slot.
  if (searchData.total === 0 || searchData.result.length === 0) {
    return { listingCount: 0, floorChaos: null };
  }

  await sleep(PAUSE_MS);

  const ids = searchData.result.slice(0, SAMPLE_SIZE).join(",");
  const fetchRes = await fetch(`${TRADE_BASE}/fetch/${ids}?query=${searchData.id}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (fetchRes.status === 429) {
    return {
      listingCount: searchData.total,
      floorChaos: null,
      rateLimited: parseInt(fetchRes.headers.get("Retry-After") ?? "60", 10),
    };
  }
  if (!fetchRes.ok) throw new Error(`Fetch ${fetchRes.status}: ${await fetchRes.text()}`);

  const fetchData: { result: ({ listing?: { price?: ListingPrice } } | null)[] } =
    await fetchRes.json();
  const listings: ListingPrice[] = [];
  for (const r of fetchData.result ?? []) {
    const price = r?.listing?.price;
    if (price?.amount != null && price.currency) listings.push(price);
  }

  return {
    listingCount: searchData.total,
    floorChaos: ladderFloorChaos(listings, currencyToChaos),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let stopping = false;
process.on("SIGINT", () => { console.log("\nGraceful shutdown (SIGINT)..."); stopping = true; });
process.on("SIGTERM", () => { console.log("\nGraceful shutdown (SIGTERM)..."); stopping = true; });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.find((a) => !a.startsWith("--"));
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const parsedLimit = limitArg ? parseInt(limitArg.split("=")[1], 10) : NaN;
  // A garbled --limit falls back to the cap rather than reaching SQL as NaN.
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? parsedLimit
    : MAX_MARKETS_PER_RUN;

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, {
    idle_timeout: 30,
    max_lifetime: 300,
    prepare: false,
    connect_timeout: 10,
  });

  const league = await resolveTradeLeague(sql, explicit);
  if (!league) {
    await sql.end();
    return;
  }

  // Chaos conversion for listing prices. Currencies only — the whole league
  // feed is ~40k rows and none of the rest is a listing currency.
  const priceRows = await sql<{ item_name: string; chaos_value: number; source: string }[]>`
    SELECT item_name, chaos_value, source FROM ninja_prices
    WHERE game = 'poe1' AND league = ${league} AND ninja_category = 'Currency'
  `;
  const best = new Map<string, number>();
  for (const r of priceRows) {
    // Prefer the exchange source when both exist (matches the app's dedup).
    if (!best.has(r.item_name) || r.source === "exchange") best.set(r.item_name, r.chaos_value);
  }
  const currencyToChaos = new Map<string, number>([["chaos", 1]]);
  for (const [slug, ninjaName] of Object.entries(CURRENCY_SLUGS)) {
    const v = best.get(ninjaName);
    if (v) currencyToChaos.set(slug, v);
  }

  // Eviction. A guide stops being pasted — the league moved on, the build fell
  // out of favour — and its rows would otherwise be refreshed forever. This is
  // what keeps the keyspace bounded by *current* demand.
  const evicted = await sql`
    DELETE FROM roast_reference_prices
    WHERE last_seen_at < now() - ${`${SEEN_RETENTION_DAYS} days`}::interval
  `;
  if (evicted.count > 0) {
    console.log(`Evicted ${evicted.count} rows unseen for ${SEEN_RETENTION_DAYS} days.`);
  }

  // Due: never priced, or priced longer ago than the staleness window. Nulls
  // first, so a guide somebody is waiting on beats a refresh of one already
  // showing a figure — that ordering is the difference between "the second
  // Roast is better" and "the tenth is".
  const due = await sql<
    {
      reference_fingerprint: string;
      slot: string;
      base_type: string;
      ilvl_min: number | null;
      filters: { statId: string; min: number | null }[];
    }[]
  >`
    SELECT reference_fingerprint, slot, base_type, ilvl_min, filters
    FROM roast_reference_prices
    WHERE league = ${league}
      AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - ${`${FRESH_MS} milliseconds`}::interval)
    ORDER BY last_refreshed_at ASC NULLS FIRST, last_seen_at DESC
    LIMIT ${limit}
  `;

  const [{ count: total }] = await sql<{ count: string }[]>`
    SELECT count(*) FROM roast_reference_prices WHERE league = ${league}
  `;

  console.log(
    `Keyspace: ${total} markets in ${league}, ${due.length} due this run ` +
      `(cap ${limit}). ~${((due.length * 2 * PAUSE_MS) / 60_000).toFixed(0)} min at ${PAUSE_MS / 1000}s/request.`,
  );

  let processed = 0;
  let priced = 0;
  let empty = 0;
  let rateLimitHits = 0;
  const startTime = Date.now();

  for (const row of due) {
    if (stopping) break;
    if (rateLimitHits >= MAX_RATE_LIMIT_HITS) {
      console.log(
        `Yielding: ${rateLimitHits} rate-limit hits. The remaining ${due.length - processed} markets stay due.`,
      );
      break;
    }

    const market: RoastRareMarket = {
      referenceFingerprint: row.reference_fingerprint,
      slot: row.slot,
      baseType: row.base_type,
      ilvlMin: row.ilvl_min,
      filters: row.filters ?? [],
    };

    try {
      const sample = await sampleMarket(league, market, currencyToChaos);
      if (sample.rateLimited) {
        rateLimitHits++;
        console.log(`  RATE LIMITED — waiting ${sample.rateLimited}s (hit #${rateLimitHits})`);
        await sleep((sample.rateLimited + 2) * 1000);
        continue;
      }

      // UPDATE, never INSERT: the app owns which markets exist. A row that
      // disappeared mid-run (evicted, league rolled) simply matches nothing.
      await sql`
        UPDATE roast_reference_prices
        SET price_chaos = ${sample.floorChaos},
            listing_count = ${sample.listingCount},
            last_refreshed_at = now()
        WHERE league = ${league}
          AND reference_fingerprint = ${row.reference_fingerprint}
          AND slot = ${row.slot}
      `;

      processed++;
      if (sample.floorChaos != null) priced++;
      else empty++;

      const floor = sample.floorChaos != null ? `${sample.floorChaos.toFixed(0)}c` : "—";
      const label = `${row.base_type} (${row.slot})`.padEnd(40);
      console.log(
        `[${processed}/${due.length}] ${label} ${floor.padStart(9)} (${sample.listingCount} listings)  ${row.reference_fingerprint.slice(0, 8)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${row.base_type} (${row.slot}): ${msg}`);
      // Bump the timestamp so one broken market cannot trap the rotation, and
      // leave the price alone. A transient failure must not wipe a good figure,
      // and a row that never prices keeps reading as an unpriced slot in the
      // app — which is a labelled band, not a wrong number.
      await sql`
        UPDATE roast_reference_prices SET last_refreshed_at = now()
        WHERE league = ${league}
          AND reference_fingerprint = ${row.reference_fingerprint}
          AND slot = ${row.slot}
      `;
      processed++;
    }

    if (!stopping) await sleep(PAUSE_MS);
  }

  const mins = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(
    `\nDone. ${processed} markets in ${mins} min ` +
      `(${priced} priced, ${empty} with no listings, ${rateLimitHits} rate limit hits).`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
