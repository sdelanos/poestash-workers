import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPacedFetch } from "./paced-fetch";

// A stand-in for the trade API: advertises one request per 300ms, so the
// pacer's interval is longer than the request timeouts used below — the shape
// of production, where it paces 36s against a 15s timeout.
let server: Server;
let url: string;
const hits: number[] = [];

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits.push(Date.now());
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Rate-Limit-Rules": "ip",
      "X-Rate-Limit-Ip": "1:0.3:60",
    });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("createPacedFetch", () => {
  // The cluster worker slept its interval *after* the response arrived and
  // before the caller read the body. Once the interval outgrew the request's
  // AbortSignal.timeout, the abort fired mid-sleep and every body read threw
  // "Body is unusable" — 100% of combos, from August to October.
  it("hands back a readable body when the interval outlasts the request timeout", async () => {
    const pacedFetch = createPacedFetch(0, 100);
    const res = await pacedFetch(url);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  // The other half of the same trap: a timeout built by the caller starts
  // ticking before the pacer waits its turn, so the next request in line was
  // aborted while still queued. The timeout has to start when the request does.
  it("does not count the wait for its turn against the request timeout", async () => {
    const pacedFetch = createPacedFetch(0, 100);
    await (await pacedFetch(url)).json();
    const res = await pacedFetch(url);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns as soon as the response arrives, without sleeping the interval", async () => {
    const pacedFetch = createPacedFetch(0);
    const started = Date.now();
    await pacedFetch(url);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("spaces consecutive requests by the advertised interval", async () => {
    const pacedFetch = createPacedFetch(0);
    hits.length = 0;
    await pacedFetch(url);
    await pacedFetch(url);
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(290);
  });
});
