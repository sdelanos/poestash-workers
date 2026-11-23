import { afterEach, describe, expect, it, vi } from "vitest";
import { NINJA_USER_AGENT, ninjaFetch, resetNinjaPacing, retryAfterMs } from "./ninja-http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetNinjaPacing();
});

describe("retryAfterMs", () => {
  it("reads seconds, defaults when absent or garbled, caps long waits", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(null)).toBe(10_000);
    expect(retryAfterMs("soon")).toBe(10_000);
    expect(retryAfterMs("600")).toBe(60_000);
  });
});

describe("ninjaFetch", () => {
  it("sends the app's User-Agent", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("[]"));
    vi.stubGlobal("fetch", fetch);
    await ninjaFetch("https://poe.ninja/poe1/api/economy/leagues");
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { "User-Agent": NINJA_USER_AGENT } });
  });

  it("sends one request at a time, each start at least 300 ms after the last", async () => {
    resetNinjaPacing(300);
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        starts.push(Date.now());
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response("[]");
      }),
    );
    await Promise.all(Array.from({ length: 4 }, (_, i) => ninjaFetch(`https://poe.ninja/x/${i}`)));
    expect(peak).toBe(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(295);
  });

  it("retries a 429 after its Retry-After, then answers the success", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const pending = ninjaFetch("https://poe.ninja/x");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after two retries and hands back the 429", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "1" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = ninjaFetch("https://poe.ninja/x");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
