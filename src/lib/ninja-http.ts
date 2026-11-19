/**
 * Every request to poe.ninja goes through here.
 *
 * poe.ninja's API reference (https://poe.ninja/docs/api) allows third-party
 * use of the economy endpoints only, asks for a descriptive User-Agent naming
 * the app and a contact, and for reasonable concurrency. Clients that
 * misbehave get blocked, and these feeds price the whole app. The builds /
 * profiles API is closed to third parties: nothing here may call it.
 *
 * Until 2026-11-19 the PoE 1 worker fired a league's ~68 requests at once
 * with Node's default agent, and poe.ninja answered 429 on whole leagues in
 * about one run in three. So requests queue here, `MAX_IN_FLIGHT` at a time,
 * and a 429 waits its `Retry-After` and tries again, `MAX_RETRIES` times.
 */

export const NINJA_USER_AGENT =
  "poestash-workers/1.0 (+https://www.poestash.com; contact@poestash.com)";

const MAX_IN_FLIGHT = 2;
const MAX_RETRIES = 2;
/** The wait when a 429 names none, and the cap on one it names. */
const DEFAULT_RETRY_MS = 10_000;
const MAX_RETRY_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let inFlight = 0;
const queue: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => queue.push(resolve));
  inFlight++;
  try {
    return await run();
  } finally {
    inFlight--;
    queue.shift()?.();
  }
}

/** A 429's wait in ms, from `Retry-After` in seconds, else the default. Pure. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_MS);
}

/** A GET to a poe.ninja economy endpoint, with the app's User-Agent, at most
 *  `MAX_IN_FLIGHT` at a time. A 429 is retried after its `Retry-After`, and
 *  the last answer, 429 or not, goes back to the caller. */
export async function ninjaFetch(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await slot(() =>
      fetch(url, {
        headers: { "User-Agent": NINJA_USER_AGENT, Accept: "application/json" },
      }),
    );
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
    // The wait happens outside the slot, so a backing-off request holds no place in the queue.
    await res.body?.cancel();
    await sleep(retryAfterMs(res.headers.get("retry-after")));
  }
}
