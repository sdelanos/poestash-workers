/**
 * Discover the poe.ninja leagues to refresh, per game, from poe.ninja's
 * index-state endpoint. Lets the hourly refresh follow league rollovers
 * with zero code changes: when a new challenge league launches, it shows up
 * here automatically and the next run prices it.
 *
 * The two games expose index-state differently:
 *   - PoE 2: `economyLeagues` lists every known league with an `indexed`
 *     flag. Only `indexed: true` leagues have priced rows; the rest (HC/SSF
 *     variants, Standard between leagues) return empty. So we filter on it.
 *     Between leagues nothing is indexed, so this returns [] — the caller
 *     treats that as "nothing to refresh" and exits cleanly.
 *   - PoE 1: `economyLeagues` is already the currently-priced set (Standard,
 *     Hardcore, plus the live challenge league and its HC variant) with no
 *     `indexed` flag. So we return them all. The permanent leagues are
 *     always present, so PoE 1 discovery is never empty.
 */

const INDEX_STATE_URL = (game: "poe1" | "poe2") =>
  `https://poe.ninja/${game}/api/data/index-state`;

interface IndexStateLeague {
  name: string;
  url: string;
  displayName: string;
  /** PoE 2 only. Absent on PoE 1, where every listed league is priced. */
  indexed?: boolean;
}

interface IndexStateResponse {
  economyLeagues: IndexStateLeague[];
}

/** Fetch the raw `economyLeagues` list for a game. Throws on a non-OK
 *  response so a genuine poe.ninja outage fails loudly rather than looking
 *  like an empty (between-leagues) result. */
async function fetchEconomyLeagues(
  game: "poe1" | "poe2",
): Promise<IndexStateLeague[]> {
  const res = await fetch(INDEX_STATE_URL(game));
  if (!res.ok) {
    throw new Error(`poe.ninja ${game} index-state ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as IndexStateResponse;
  return data.economyLeagues ?? [];
}

/** PoE 2: only the leagues poe.ninja currently prices (`indexed: true`).
 *  Empty between leagues. */
export async function discoverPoe2Leagues(): Promise<string[]> {
  const leagues = await fetchEconomyLeagues("poe2");
  return leagues.filter((l) => l.indexed).map((l) => l.name);
}

/** PoE 1: every league in `economyLeagues` (already the priced set —
 *  Standard, Hardcore, current challenge league + its HC variant). */
export async function discoverPoe1Leagues(): Promise<string[]> {
  const leagues = await fetchEconomyLeagues("poe1");
  return leagues.map((l) => l.name);
}
