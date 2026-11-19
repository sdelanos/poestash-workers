/**
 * Reduce a data source's raw league list to the "priced set": the leagues
 * a price worker should actually refresh.
 *
 *   priced set = Standard + Hardcore + every live challenge league + each
 *                one's Hardcore variant.
 *
 * SSF and Ruthless variants are never priced (no meaningful trade economy).
 * Only names present in the input are returned, so a source that hasn't
 * indexed a league yet won't have it fabricated, and the caller can't try to
 * fetch a league its own upstream doesn't serve.
 *
 * More than one challenge league can be live at once: a rollover briefly lists
 * the old and new leagues together, and a standalone event can run alongside
 * the main league. We price all of them rather than guess which is "the"
 * league, so the main economy is never dropped. Sources may or may not expose
 * dates; when an endAt is present and in the past that league is treated as
 * ended and skipped.
 *
 * This is the one piece of league logic shared across the heterogeneous
 * workers (poe.watch, poe.ninja index-state, ...), so it takes a minimal shape
 * and works on names alone.
 */

export interface LeagueLike {
  name: string;
  /** ISO date. Optional. A value in the past means the league has ended;
   *  null or absent means open-ended (or the source doesn't expose it). */
  endAt?: string | null;
  /** ISO date the league goes live. Optional; only sources that expose start
   *  dates (GGG's `/leagues`) set it. Used to order co-listed challenge
   *  leagues during a rollover, so it is only read by
   *  `selectCurrentChallengeLeague`. */
  startAt?: string | null;
}

export interface PricedSetOptions {
  /** Drop the permanent Hardcore league. gem-usage (stopped, see README)
   *  sets this: poe.ninja kept no build snapshot for permanent Hardcore. The Hardcore *challenge* variant
   *  (e.g. "Hardcore Mirage") is unaffected. */
  includePermanentHardcore?: boolean;
  /** Override "now" for tests. */
  now?: number;
}

/** Permanent trade leagues we price, in output order. */
const PERMANENT_PRICED = ["Standard", "Hardcore"] as const;

/** A league whose name contains any of these is never priced. */
const EXCLUDED_SUBSTRINGS = ["SSF", "Solo Self-Found", "Ruthless"];

const isExcluded = (name: string): boolean =>
  EXCLUDED_SUBSTRINGS.some((s) => name.includes(s));

const hasEnded = (endAt: string | null | undefined, now: number): boolean =>
  endAt != null && Date.parse(endAt) <= now;

const startsLater = (
  startAt: string | null | undefined,
  now: number,
): boolean => startAt != null && Date.parse(startAt) > now;

/** A live challenge league: not permanent, not an SSF/Ruthless variant, not
 *  ended. Shared by both selectors so they agree on what a challenge league is;
 *  each then narrows further (Hardcore variants, start dates). */
const isLiveChallenge = (l: LeagueLike, now: number): boolean =>
  !PERMANENT_PRICED.includes(l.name as (typeof PERMANENT_PRICED)[number]) &&
  !isExcluded(l.name) &&
  !hasEnded(l.endAt, now);

export function selectPricedSet(
  leagues: LeagueLike[],
  opts: PricedSetOptions = {},
): string[] {
  const now = opts.now ?? Date.now();
  const includePermanentHardcore = opts.includePermanentHardcore ?? true;

  // Dedup by name, first occurrence wins.
  const byName = new Map<string, LeagueLike>();
  for (const l of leagues) if (!byName.has(l.name)) byName.set(l.name, l);
  const all = [...byName.values()];
  const present = (name: string) => byName.has(name);

  const out: string[] = [];

  // 1. Permanent trade leagues, only if the source lists them.
  if (present("Standard")) out.push("Standard");
  if (includePermanentHardcore && present("Hardcore")) out.push("Hardcore");

  // 2. Every live challenge league: anything that isn't a permanent priced
  //    league, isn't an SSF/Ruthless variant, and hasn't ended. Each softcore
  //    league pulls in its Hardcore variant; the "Hardcore ..." entries are
  //    added that way, so skip them on their own pass.
  const challenges = all.filter((l) => isLiveChallenge(l, now));

  for (const l of challenges) {
    if (l.name.startsWith("Hardcore ")) continue;
    out.push(l.name);
    const hcName = `Hardcore ${l.name}`;
    if (present(hcName)) out.push(hcName);
  }

  return out;
}

/**
 * Pick the single softcore challenge league to price, or null when none is
 * live.
 *
 * `selectPricedSet` is for workers that can afford to price every live league
 * from a bulk feed. The trade-API workers (cluster jewels, split bases) cannot:
 * they spend one rate-limited search per row and need hours to clear a single
 * league, so they must commit to exactly one. This is that choice, and it
 * deliberately mirrors the app's `detectDefaultLeague` so the league a worker
 * writes is the league the selector defaults to.
 *
 * Returns null rather than falling back to Standard. Between leagues there is
 * no challenge economy, and quietly pricing Standard would burn the whole rate
 * limit budget writing rows no page asks for.
 */
export function selectCurrentChallengeLeague(
  leagues: LeagueLike[],
  opts: PricedSetOptions = {},
): string | null {
  const now = opts.now ?? Date.now();

  const challenges = leagues.filter(
    (l) =>
      isLiveChallenge(l, now) &&
      !l.name.startsWith("Hardcore ") &&
      // GGG publishes the next league before it goes live. Pricing it early
      // means querying trade for a league that has no listings yet.
      !startsLater(l.startAt, now),
  );

  // Newest start date wins: during a rollover GGG lists the ending and the
  // starting league together, and the new one is what players are in. Sources
  // that expose no dates leave us with the first listed challenge league.
  const withStart = challenges.filter(
    (l): l is LeagueLike & { startAt: string } => Boolean(l.startAt),
  );
  const pick =
    withStart.length > 0
      ? withStart.reduce((a, b) => (b.startAt > a.startAt ? b : a))
      : challenges[0];

  return pick?.name ?? null;
}
