/**
 * Tells the PoeStash app that a game's prices just changed, so its cached
 * price pages refresh now instead of on their own timer.
 *
 * The app (PoeStash 2.0, from its cut-over) serves its price pages from a
 * cache tagged per game. `POST /api/revalidate/prices?game=<poe1|poe2>` with
 * `Authorization: Bearer <CRON_SECRET>` marks that tag stale: the next request
 * is served the old page and regenerates it, the one after shows the new
 * figures. The route writes nothing and answers `{ revalidated: "prices:poe1" }`,
 * 401 `unauthorized` on a wrong or missing secret, 400 `game` on an unknown
 * game. (App side: `src/server/prices/routes.ts`, decision 140.)
 *
 * The call is a courtesy, never a reason to fail a run. The prices are already
 * in Postgres when it happens, and the app's cache expires on its own TTL
 * anyway, so a failed call costs freshness for a few minutes, not data. It
 * logs, adds a warning annotation on GitHub Actions so a green run still shows
 * it, and returns.
 *
 * Configuration, both from the workflow's env:
 *   - `POESTASH_APP_URL`: the app's canonical origin, e.g.
 *     `https://www.poestash.com` (a path is ignored). It is the switch: unset
 *     means "no app to tell" and the call is skipped quietly, the state before
 *     the cut-over, since PoeStash 1.x has no such route (its pages revalidate
 *     on a 5-minute ISR timer). Give the exact host the app answers on: a
 *     redirect (apex to www) would drop the Authorization header, so one is
 *     reported as a failure, not followed.
 *   - `CRON_SECRET`: the app's own `CRON_SECRET`, the same value as on Vercel.
 */

export type Game = "poe1" | "poe2";

/** What happened, for the caller's tests; callers in workers ignore it. */
export type RevalidateOutcome = "skipped" | "revalidated" | "failed";

export interface RevalidateDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** The whole call, response body included. Well inside a worker's run. */
  timeoutMs?: number;
}

export const REVALIDATE_PATH = "/api/revalidate/prices";

/** Never throws. */
export async function revalidateAppPrices(
  game: Game,
  { env = process.env, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: RevalidateDeps = {},
): Promise<RevalidateOutcome> {
  const appUrl = env.POESTASH_APP_URL?.trim().replace(/\/+$/, "");
  const secret = env.CRON_SECRET?.trim();

  if (!appUrl) {
    console.log(`[revalidate] ${game}: POESTASH_APP_URL not set, no app to tell, skipping`);
    return "skipped";
  }
  if (!secret) {
    warn(env, game, "POESTASH_APP_URL is set but CRON_SECRET is not: skipping the call");
    return "skipped";
  }

  let url: string;
  try {
    url = new URL(`${REVALIDATE_PATH}?game=${game}`, appUrl).toString();
  } catch {
    warn(env, game, `POESTASH_APP_URL is not a URL: ${appUrl}`);
    return "failed";
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();

    if (res.ok) {
      console.log(`[revalidate] ${game}: ${res.status} ${body.slice(0, 200)}`);
      return "revalidated";
    }

    const location = res.headers.get("location");
    const why =
      res.status === 401
        ? "the app refused the secret (CRON_SECRET differs from the app's)"
        : res.status === 404
          ? "the app has no revalidate route (PoeStash 1.x, or the wrong host)"
          : location
            ? `redirected to ${location}: set POESTASH_APP_URL to the host the app answers on`
            : body.slice(0, 200);
    warn(env, game, `${url} answered ${res.status}: ${why}`);
    return "failed";
  } catch (err) {
    warn(env, game, `${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

function warn(env: Record<string, string | undefined>, game: Game, message: string) {
  const line = `[revalidate] ${game}: ${message}. Prices are written; the app's cache refreshes on its own TTL.`;
  console.warn(line);
  // A workflow command makes the miss visible on a run that still ends green.
  if (env.GITHUB_ACTIONS === "true") console.log(`::warning title=App revalidate failed::${line}`);
}
