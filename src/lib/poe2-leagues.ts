/**
 * Discover PoE 2 leagues that currently have economy data on poe.ninja.
 *
 * Source of truth: poe.ninja's index-state endpoint, which lists every
 * known league with an `indexed` flag. Only `indexed: true` leagues have
 * priced rows on the exchange endpoints; the others (HC, SSF variants,
 * Standard between leagues) return empty responses.
 *
 * Zero-touch across league rollovers: poe.ninja flips `indexed: true`
 * the moment a new league has enough trade volume to be priced. Polling
 * this endpoint at refresh time means no code change when, e.g., the
 * 2026-05-29 launch supersedes "Fate of the Vaal".
 */

const INDEX_STATE_URL = "https://poe.ninja/poe2/api/data/index-state";

interface IndexStateLeague {
  name: string;
  url: string;
  displayName: string;
  hardcore: boolean;
  indexed: boolean;
}

interface IndexStateResponse {
  economyLeagues: IndexStateLeague[];
}

export async function discoverPoe2Leagues(): Promise<string[]> {
  const res = await fetch(INDEX_STATE_URL);
  if (!res.ok) {
    throw new Error(`poe.ninja index-state ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as IndexStateResponse;
  return data.economyLeagues.filter((l) => l.indexed).map((l) => l.name);
}
