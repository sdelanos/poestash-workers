import { afterEach, describe, expect, it, vi } from "vitest";
import { NINJA_USER_AGENT, ninjaFetch, retryAfterMs } from "./ninja-http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("never has more than 2 requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response("[]");
      }),
    );
    await Promise.all(Array.from({ length: 20 }, (_, i) => ninjaFetch(`https://poe.ninja/x/${i}`)));
    expect(peak).toBe(2);
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
