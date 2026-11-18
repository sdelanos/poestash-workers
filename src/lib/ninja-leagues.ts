/**
 * Discover the poe.ninja leagues to refresh, per game, from poe.ninja's
 * index-state endpoint. Lets the hourly refresh follow league rollovers
 * with zero code changes: when a new challenge league launches, it shows up
 * here automatically and the next run prices it.
 *
 * The two games expose index-state differently:
 *   - PoE 2: `economyLeagues` lists the current leagues, each with
 *     `hardcore`, `isPrivate` and an `indexed` flag. We price every softcore
 *     public challenge league listed (`poe2LeaguesToPrice`), not only the
 *     `indexed: true` ones: poe.ninja dropped the flag from Forbidden Rites a
 *     week after its launch (2026-09-11) while its economy feed kept pricing
 *     it, and filtering on the flag froze that league's prices for two months.
 *     A listed league with no trades yet answers an empty feed, which the
 *     fetcher already skips. Between leagues only Standard is left, so this
 *     returns [] and the caller exits cleanly.
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
  /** PoE 2 only. Not a reliable "priced" signal: see the header. */
  indexed?: boolean;
  /** PoE 2 only. */
  hardcore?: boolean;
  /** PoE 2 only. */
  isPrivate?: boolean;
}

/** Name parts of a variant with no trade economy worth pricing. */
const NO_ECONOMY = ["SSF", "Solo Self-Found", "Ruthless"];

/** PoE 2's leagues to price from index-state's `economyLeagues`: every
 *  public softcore challenge league, whatever its `indexed` flag. Standard,
 *  Hardcore and the HC/SSF variants stay out, as before. Pure. */
export function poe2LeaguesToPrice(
  leagues: Pick<IndexStateLeague, "name" | "hardcore" | "isPrivate">[],
): string[] {
  return leagues
    .filter(
      (l) =>
        !l.hardcore &&
        !l.isPrivate &&
        l.name !== "Standard" &&
        !NO_ECONOMY.some((s) => l.name.includes(s)),
    )
    .map((l) => l.name);
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

/** PoE 2: the public softcore challenge leagues poe.ninja lists
 *  (`poe2LeaguesToPrice`). Empty between leagues. */
export async function discoverPoe2Leagues(): Promise<string[]> {
  return poe2LeaguesToPrice(await fetchEconomyLeagues("poe2"));
}

/** PoE 1: every league in `economyLeagues` (already the priced set —
 *  Standard, Hardcore, current challenge league + its HC variant). */
export async function discoverPoe1Leagues(): Promise<string[]> {
  const leagues = await fetchEconomyLeagues("poe1");
  return leagues.map((l) => l.name);
}
