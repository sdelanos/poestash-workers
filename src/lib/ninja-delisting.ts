/**
 * Marking the ninja_prices rows poe.ninja no longer lists.
 *
 * The refresh never deletes a row and rewrites one only when its data changed
 * (./ninja-upsert.ts), so `updated_at` can't tell a dropped item from one whose
 * figures stood still (most base types and gems sit unchanged for days). After
 * the upsert, each feed (source + type) poe.ninja answered in full marks the
 * league's rows of that feed it left out: `delisted_at = now`. The app reads a
 * price only while `delisted_at` is null. A row that comes back is cleared by
 * the upsert itself (`delisted_at` is a data column there, written null).
 *
 * A short answer must not delist half a type, so a feed marks nothing when its
 * answer is empty or holds fewer than `minRatio` of the rows the type has
 * listed now; that hold is logged. A wrong mark only lasts until the next
 * answer that holds the row again, one refresh later.
 */

import type postgres from "postgres";
import type { NinjaFetchedItem, NinjaSource } from "./ninja-types";

/** One poe.ninja response: a source's feed for one type (`ninjaCategory`). */
export interface NinjaFeed {
  source: NinjaSource;
  category: string;
}

/** Below this share of a type's listed rows, an answer is taken as partial. */
export const DELIST_MIN_RATIO = 0.5;

/** `NINJA_DELIST_MIN_RATIO` when set to a number from 0 to 1, else the default.
 *  0 is the one-off backfill: every non-empty answer marks (README). */
export function delistMinRatio(raw: string | undefined): number {
  const ratio = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return ratio >= 0 && ratio <= 1 ? ratio : DELIST_MIN_RATIO;
}

const feedKey = (source: string, category: string) => `${source}:${category}`;

/** What one league's refresh marks and holds back, worked out from what poe.ninja
 *  answered and what the table lists. */
export interface DelistingPlan {
  /** A feed to mark: its rows whose details_id isn't in `keep`. */
  mark: (NinjaFeed & { keep: string[] })[];
  /** A feed that answered short: nothing marked, logged. */
  held: (NinjaFeed & { got: number; listed: number })[];
}

/**
 * The feeds to mark for one league. `answered`: the feeds whose request
 * succeeded (a failed one is never here). `rows`: everything fetched, before
 * deduplication, so each feed's own answer is counted. `listed`: the league's
 * rows not marked, per `source:category`, read after the upsert.
 */
export function planDelisting(
  answered: readonly NinjaFeed[],
  rows: readonly Pick<NinjaFetchedItem, "source" | "ninjaCategory" | "detailsId">[],
  listed: ReadonlyMap<string, number>,
  minRatio = DELIST_MIN_RATIO,
): DelistingPlan {
  const ids = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = feedKey(r.source, r.ninjaCategory);
    const set = ids.get(key) ?? new Set<string>();
    set.add(r.detailsId);
    ids.set(key, set);
  }
  const plan: DelistingPlan = { mark: [], held: [] };
  const seen = new Set<string>();
  for (const feed of answered) {
    const key = feedKey(feed.source, feed.category);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = listed.get(key) ?? 0;
    // Nothing listed: nothing to mark, and no hold worth a line.
    if (count === 0) continue;
    const keep = ids.get(key) ?? new Set<string>();
    if (keep.size === 0 || keep.size < minRatio * count) {
      plan.held.push({ ...feed, got: keep.size, listed: count });
      continue;
    }
    plan.mark.push({ ...feed, keep: [...keep] });
  }
  return plan;
}

/** Marks the rows poe.ninja left out, per ./planDelisting, and logs each feed
 *  held back. Run after the upsert. Returns how many rows it marked. */
export async function markDelisted(
  sql: postgres.Sql,
  game: string,
  league: string,
  answered: readonly NinjaFeed[],
  rows: readonly Pick<NinjaFetchedItem, "source" | "ninjaCategory" | "detailsId">[],
  now: Date,
  minRatio = DELIST_MIN_RATIO,
): Promise<number> {
  const counts = await sql<{ source: string; ninja_category: string; n: number }[]>`
    SELECT source, ninja_category, count(*)::int AS n FROM ninja_prices
    WHERE game = ${game} AND league = ${league} AND delisted_at IS NULL
    GROUP BY source, ninja_category
  `;
  const listed = new Map(counts.map((c) => [feedKey(c.source, c.ninja_category), c.n]));
  const plan = planDelisting(answered, rows, listed, minRatio);
  for (const h of plan.held) {
    console.log(
      `  delisting held back for ${h.source}:${h.category}: ${h.got} in poe.ninja's answer, ${h.listed} listed (under ${minRatio * 100}%)`,
    );
  }
  let marked = 0;
  for (const m of plan.mark) {
    const result = await sql`
      UPDATE ninja_prices SET delisted_at = ${now}
      WHERE game = ${game} AND league = ${league} AND source = ${m.source}
        AND ninja_category = ${m.category} AND delisted_at IS NULL
        AND NOT (details_id = ANY(${sql.array(m.keep)}::text[]))
    `;
    marked += result.count;
  }
  if (marked > 0) console.log(`  ${marked} rows poe.ninja no longer lists marked delisted`);
  return marked;
}
