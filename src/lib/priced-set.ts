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
}

export interface PricedSetOptions {
  /** Drop the permanent Hardcore league. gem-usage sets this: poe.ninja keeps
   *  no build snapshot for permanent Hardcore. The Hardcore *challenge* variant
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
  const challenges = all.filter(
    (l) =>
      !PERMANENT_PRICED.includes(l.name as (typeof PERMANENT_PRICED)[number]) &&
      !isExcluded(l.name) &&
      !hasEnded(l.endAt, now),
  );

  for (const l of challenges) {
    if (l.name.startsWith("Hardcore ")) continue;
    out.push(l.name);
    const hcName = `Hardcore ${l.name}`;
    if (present(hcName)) out.push(hcName);
  }

  return out;
}
