import { describeLimits, sustainableIntervalMs } from "./rate-limit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many 403s in a row mean the runner is blocked rather than one request
 * being refused. On 2026-10-27 Cloudflare denied one GitHub runner's IP
 * outright: the cluster worker logged 1103 "Search 403" errors over three
 * hours, priced nothing, and exited 0. A blocked IP stays blocked for the run,
 * so the only useful thing left to do is fail loud and let the next run land
 * on a different runner.
 */
const MAX_CONSECUTIVE_403 = 5;

/** Thrown when the host keeps answering 403. Callers rethrow it instead of logging per item. */
export class BlockedError extends Error {}

/**
 * A fetch that spaces requests by the interval GGG's rate-limit headers ask
 * for (poestash-workers #7), starting from `defaultIntervalMs` until the first
 * response says otherwise.
 *
 * The wait happens **before the next request, never after this one**. The
 * cluster worker used to sleep the interval between receiving a response and
 * the caller reading its body. Callers pass `AbortSignal.timeout(15_000)`,
 * which also bounds the body read, so once the header-derived interval grew
 * to 36s the abort fired mid-sleep and every body read threw "Body is
 * unusable" — every combo, every run, August to October 2026, unnoticed
 * because the error path also bumped `last_refreshed_at`.
 *
 * The timeout is owned here for the same reason: one the caller builds starts
 * ticking before the wait for this request's turn, and would abort it while
 * still queued. It starts when the request is actually sent.
 */
export function createPacedFetch(defaultIntervalMs: number, timeoutMs = 15_000) {
  let intervalMs = defaultIntervalMs;
  let nextRequestAt = 0;
  let limitsLogged = false;
  let consecutive403 = 0;

  return async function pacedFetch(url: string, init?: RequestInit): Promise<Response> {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);

    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

    const advertised = sustainableIntervalMs(res.headers);
    if (advertised != null) intervalMs = advertised;

    if (!limitsLogged) {
      console.log(`${describeLimits(res.headers)} — pacing ${(intervalMs / 1000).toFixed(1)}s/request`);
      limitsLogged = true;
    }

    // A 429 carries its own Retry-After, which the caller sleeps instead.
    // Adding the interval on top would just delay the retry further.
    nextRequestAt = res.status === 429 ? 0 : Date.now() + intervalMs;

    consecutive403 = res.status === 403 ? consecutive403 + 1 : 0;
    if (consecutive403 >= MAX_CONSECUTIVE_403) {
      throw new BlockedError(`${consecutive403} consecutive 403s from ${new URL(url).host} — runner looks blocked, aborting`);
    }

    return res;
  };
}
