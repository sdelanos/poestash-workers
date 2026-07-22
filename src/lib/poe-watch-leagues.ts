/**
 * Discover the leagues poe.watch currently serves, from its /leagues endpoint.
 * Lets the ultimatum worker follow league rollovers with no code change: when
 * a new challenge league launches and poe.watch indexes it, it shows up here
 * and the next run prices it.
 *
 * poe.watch marks a league with no end date using a "0001-01-01" sentinel. We
 * normalise it to null so the priced-set classifier reads it as open-ended.
 */

import { type LeagueLike } from "./priced-set";

const POE_WATCH_BASE = "https://api.poe.watch";

interface PoeWatchLeague {
  name: string;
  end_date: string;
}

/** poe.watch's "no end date" sentinel. */
const NO_END_SENTINEL_YEAR = "0001";

const normaliseEndDate = (d: string | null | undefined): string | null => {
  if (!d || d.startsWith(NO_END_SENTINEL_YEAR)) return null;
  return d;
};

/** Fetch poe.watch's current league list. Throws on a non-OK response so a
 *  genuine poe.watch outage fails loudly rather than looking like an empty
 *  (between-leagues) result. */
export async function discoverPoeWatchLeagues(): Promise<LeagueLike[]> {
  const res = await fetch(`${POE_WATCH_BASE}/leagues`);
  if (!res.ok) {
    throw new Error(`poe.watch /leagues ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as PoeWatchLeague[] | null;
  return (data ?? []).map((l) => ({
    name: l.name,
    endAt: normaliseEndDate(l.end_date),
  }));
}
