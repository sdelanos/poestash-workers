/**
 * Fetches the PoE /leagues list for every supported (game, realm) pair
 * and stores it in `poe_leagues_cache`. Each row is keyed on (game,
 * realm) and the app reads from this table instead of hitting GGG on
 * every Vercel render.
 *
 * Usage:
 *   npx tsx src/refresh-leagues.ts
 *
 * Designed to run hourly via GitHub Actions cron. Each run does ONE
 * client-credentials OAuth + FOUR /league calls (poe1 pc/xbox/sony +
 * poe2 pc). PoE 2 console isn't supported by GGG yet so we skip those.
 *
 * Requires DATABASE_URL, POE_CLIENT_ID, and POE_CLIENT_SECRET env vars.
 */

import "dotenv/config";
import postgres from "postgres";

const OAUTH_BASE = "https://www.pathofexile.com";
const API_BASE = "https://api.pathofexile.com";

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

interface LeaguePair {
  game: "poe1" | "poe2";
  realm: "pc" | "xbox" | "sony";
  /** Value to send on the GGG `realm` query param. GGG flattens the
   *  (game, realm) tuple into one enum; PoE 1 PC is "pc", PoE 1 Xbox is
   *  "xbox", PoE 1 PlayStation is "sony", PoE 2 PC is "poe2". Anything
   *  else isn't supported by GGG today. */
  realmParam: string;
}

const PAIRS: LeaguePair[] = [
  { game: "poe1", realm: "pc", realmParam: "pc" },
  { game: "poe1", realm: "xbox", realmParam: "xbox" },
  { game: "poe1", realm: "sony", realmParam: "sony" },
  { game: "poe2", realm: "pc", realmParam: "poe2" },
];

interface PoeLeague {
  id: string;
  realm: string;
  url: string;
  startAt: string;
  endAt: string | null;
  description: string;
  rules: { id: string; name: string; description: string }[];
}

async function getServiceToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "service:leagues service:psapi service:cxapi",
  });
  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Client credentials exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/** Standalone events (Return-of-the-Ancestors-style) live under type=event,
 *  not type=main. Merge them in, but only while live, so the selector shows
 *  the event's league forks without pulling in past or upcoming races. Main
 *  wins on id collision. Duplicated in the app (lib/poe/api.ts) because the
 *  two repos can't import each other. */
function mergeActiveEvents(
  main: PoeLeague[],
  events: PoeLeague[],
): PoeLeague[] {
  const now = Date.now();
  const seen = new Set(main.map((l) => l.id));
  const active = events.filter((l) => {
    if (seen.has(l.id) || !l.startAt) return false;
    const started = Date.parse(l.startAt) <= now;
    const ended = l.endAt ? Date.parse(l.endAt) <= now : false;
    return started && !ended;
  });
  return [...main, ...active];
}

async function fetchLeaguesOfType(
  token: string,
  realmParam: string,
  type: "main" | "event",
): Promise<PoeLeague[]> {
  const url = `${API_BASE}/league?type=${type}&realm=${encodeURIComponent(realmParam)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
    },
  });
  if (!res.ok) {
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new Error(`429 rate-limited (retry-after=${retry ?? "?"}) on ${url}`);
    }
    throw new Error(`fetchLeagues failed (${res.status}) on ${url}: ${await res.text()}`);
  }
  const data = (await res.json()) as { leagues: PoeLeague[] };
  return data.leagues ?? [];
}

async function fetchLeagues(token: string, realmParam: string): Promise<PoeLeague[]> {
  // type=main is load-bearing for the selector, so it throws on failure. The
  // type=event call is best-effort: a flaky response just means no live event
  // merges this cycle, never a broken main list. We merge BEFORE main() trims
  // to {id, startAt} so the active-window filter can still read endAt.
  const events = await fetchLeaguesOfType(token, realmParam, "event").catch(
    (err) => {
      console.error(
        `[leagues] type=event fetch failed for realm=${realmParam}:`,
        err instanceof Error ? err.message : err,
      );
      return [] as PoeLeague[];
    },
  );
  const main = await fetchLeaguesOfType(token, realmParam, "main");
  return mergeActiveEvents(main, events);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const clientId = process.env.POE_CLIENT_ID;
  const clientSecret = process.env.POE_CLIENT_SECRET;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  if (!clientId || !clientSecret) {
    throw new Error("POE_CLIENT_ID and POE_CLIENT_SECRET are required");
  }

  const sql = postgres(dbUrl);
  try {
    const token = await getServiceToken(clientId, clientSecret);

    for (const pair of PAIRS) {
      try {
        const leagues = await fetchLeagues(token, pair.realmParam);
        // Keep startAt so the app can follow the newest challenge league
        // during a rollover, when GGG briefly lists both old and new.
        const minimal = leagues.map((l) => ({ id: l.id, startAt: l.startAt }));
        await sql`
          INSERT INTO poe_leagues_cache (game, realm, leagues, refreshed_at)
          VALUES (${pair.game}, ${pair.realm}, ${sql.json(minimal)}::jsonb, NOW())
          ON CONFLICT (game, realm) DO UPDATE
          SET leagues = EXCLUDED.leagues,
              refreshed_at = NOW()
        `;
        console.log(`[leagues] ${pair.game}/${pair.realm}: ${leagues.length} leagues`);
      } catch (err) {
        console.error(`[leagues] ${pair.game}/${pair.realm} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("refresh-leagues fatal:", err);
  process.exit(1);
});
