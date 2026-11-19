/**
 * Discover the poe.ninja leagues to refresh, per game, from poe.ninja's
 * documented economy leagues endpoint (`/<game>/api/economy/leagues`,
 * https://poe.ninja/docs/api). Lets the hourly refresh follow league
 * rollovers with zero code changes: when a new challenge league launches, it
 * shows up here automatically and the next run prices it.
 *
 * Until 2026-11-19 this read `/<game>/api/data/index-state`, an internal
 * endpoint poe.ninja's docs put outside the supported surface. The documented
 * one answers a plain `{ id, name }[]`, the first entry the current challenge
 * league, and `id` is what the overview endpoints take as `league`. It carries
 * no `hardcore` or `isPrivate` flag, so PoE 2's filter reads the name.
 *
 *   - PoE 2: we price every softcore public challenge league listed
 *     (`poe2LeaguesToPrice`). poe.ninja keeps the previous league listed
 *     while its economy feed still prices it (Forbidden Rites beside Runes of
 *     Aldur in 2026-11), and filtering on index-state's old `indexed` flag
 *     once froze that league's prices for two months. A listed league with no
 *     trades yet answers an empty feed, which the fetcher already skips.
 *     Between leagues only the permanent leagues are left, so this returns []
 *     and the caller exits cleanly.
 *   - PoE 1: the list is already the priced set (Standard, Hardcore, plus the
 *     live challenge league and its HC variant). So we return them all. The
 *     permanent leagues are always present, so PoE 1 discovery is never
 *     empty.
 */
import { ninjaFetch } from "./ninja-http";

const LEAGUES_URL = (game: "poe1" | "poe2") =>
  `https://poe.ninja/${game}/api/economy/leagues`;

interface EconomyLeague {
  /** The league parameter of the overview endpoints. */
  id: string;
  name: string;
}

/** Name parts of a variant with no trade economy worth pricing. */
const NO_ECONOMY = ["SSF", "Solo Self-Found", "Ruthless"];

/** Hardcore by name: the permanent `Hardcore`, `HC <league>`, `Hardcore <league>`. */
const isHardcore = (name: string) => /^(HC|Hardcore)\b/.test(name);

/** A private league's name ends in its id, as `My League (PL12345)`. */
const isPrivate = (name: string) => /\(PL\d+\)$/.test(name);

/** PoE 2's leagues to price: every public softcore challenge league, by id.
 *  Standard, Hardcore and the HC/SSF/Ruthless variants stay out. Pure. */
export function poe2LeaguesToPrice(leagues: EconomyLeague[]): string[] {
  return leagues
    .filter(
      (l) =>
        l.name !== "Standard" &&
        !isHardcore(l.name) &&
        !isPrivate(l.name) &&
        !NO_ECONOMY.some((s) => l.name.includes(s)),
    )
    .map((l) => l.id);
}

/** Fetch the economy leagues for a game. Throws on a non-OK response or an
 *  unexpected shape, so a genuine poe.ninja outage or an API change fails
 *  loudly rather than looking like an empty (between-leagues) result. */
async function fetchEconomyLeagues(game: "poe1" | "poe2"): Promise<EconomyLeague[]> {
  const url = LEAGUES_URL(game);
  const res = await ninjaFetch(url);
  if (!res.ok) {
    throw new Error(`poe.ninja ${game} economy leagues ${res.status}: ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data) || data.some((l) => typeof l?.id !== "string")) {
    throw new Error(`poe.ninja ${game} economy leagues: unexpected shape from ${url}`);
  }
  return data as EconomyLeague[];
}

/** PoE 2: the public softcore challenge leagues poe.ninja lists
 *  (`poe2LeaguesToPrice`). Empty between leagues. */
export async function discoverPoe2Leagues(): Promise<string[]> {
  return poe2LeaguesToPrice(await fetchEconomyLeagues("poe2"));
}

/** PoE 1: every league listed (already the priced set: Standard, Hardcore,
 *  the current challenge league and its HC variant). */
export async function discoverPoe1Leagues(): Promise<string[]> {
  const leagues = await fetchEconomyLeagues("poe1");
  return leagues.map((l) => l.id);
}
