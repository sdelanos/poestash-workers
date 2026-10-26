import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeIdPosition, seekToTail, StashRiver, syntheticChangeId } from "./stash-river";

describe("syntheticChangeId", () => {
  it("builds the five-component id GGG seeks on", () => {
    expect(syntheticChangeId(3_450_000_000)).toBe(
      "3450000000-3450000000-3450000000-3450000000-3450000000",
    );
  });

  it("floors a fractional position, since a component is an integer", () => {
    expect(syntheticChangeId(10.9)).toBe("10-10-10-10-10");
  });
});

/** A stream whose stashes run out past `tail`. */
const streamEndingAt = (tail: number) => {
  const probed: number[] = [];
  const hasStashes = async (id: string) => {
    const n = Number(id.split("-")[0]);
    probed.push(n);
    return n <= tail;
  };
  return { hasStashes, probed };
};

describe("seekToTail", () => {
  it("finds the tail within the requested precision", async () => {
    const { hasStashes } = streamEndingAt(3_460_000_000);
    const { position } = await seekToTail(hasStashes, { precision: 5_000_000 });
    expect(position).toBeLessThanOrEqual(3_460_000_000);
    expect(3_460_000_000 - position).toBeLessThanOrEqual(5_000_000);
  });

  it("lands on a position that still has stashes, never past the end", async () => {
    const { hasStashes } = streamEndingAt(3_460_000_000);
    const { position } = await seekToTail(hasStashes);
    expect(await hasStashes(syntheticChangeId(position))).toBe(true);
  });

  it("costs a few dozen probes over the default bracket", async () => {
    // Bisection over 1e9..2e10 to 1e3 is 25 requests: ~12s of budget at 2/s,
    // against a walk from 2013 that would never finish.
    const { probes } = await seekToTail(streamEndingAt(3_460_000_000).hasStashes);
    expect(probes).toBeLessThanOrEqual(25);
  });

  // The regression. At the old 5e6 precision the bracket halved down to a
  // fixed grid of (2e10 - 1e9) / 2^12 ≈ 4.64e6 steps, so every run from
  // 2026-09-26 to 2026-10-26 reported the same grid point, 3477050781, and
  // drained the same historical slice. Both tails below sit on that one cell.
  it("lands within 1e3 of the tail by default, not on a coarse grid", async () => {
    const tail = 3_479_123_456;
    const { position } = await seekToTail(streamEndingAt(tail).hasStashes);
    expect(position).toBeLessThanOrEqual(tail);
    expect(tail - position).toBeLessThanOrEqual(1_000);
  });

  it("moves with a tail that advanced less than the old grid step", async () => {
    const before = await seekToTail(streamEndingAt(3_478_000_000).hasStashes);
    const after = await seekToTail(streamEndingAt(3_479_000_000).hasStashes);
    expect(after.position - before.position).toBeGreaterThan(990_000);
  });

  it("follows a tail that has moved, rather than trusting a past measurement", async () => {
    // The issue measured ~5.2e9; by implementation the live tail was 3.46e9.
    const early = await seekToTail(streamEndingAt(3_460_000_000).hasStashes);
    const later = await seekToTail(streamEndingAt(5_200_000_000).hasStashes);
    expect(later.position).toBeGreaterThan(early.position);
  });

  it("returns the bracket floor when the whole bracket reads empty", async () => {
    const { position } = await seekToTail(async () => false, {
      low: 1_000,
      high: 9_000,
      precision: 100,
    });
    expect(position).toBe(1_000);
  });

  it("honours an explicit bracket", async () => {
    const { position } = await seekToTail(streamEndingAt(500).hasStashes, {
      low: 0,
      high: 1_000,
      precision: 10,
    });
    expect(position).toBeGreaterThan(490);
    expect(position).toBeLessThanOrEqual(500);
  });
});

describe("changeIdPosition", () => {
  it("reads a composite id as its furthest component", () => {
    expect(changeIdPosition("3475050781-3475050781-3475061200-3475050781-3475050790")).toBe(
      3_475_061_200,
    );
  });

  it("is null for an id it cannot read", () => {
    expect(changeIdPosition("")).toBeNull();
    expect(changeIdPosition("abc-def")).toBeNull();
  });
});

// A stand-in for the river: `/` answers a page at once, `/stall` sends its
// headers and never finishes the body.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Rate-Limit-Rules": "Ip",
      // One request per 300ms: an interval longer than the timeouts below,
      // the shape that killed the sibling cluster worker's body reads.
      "X-Rate-Limit-Ip": "1:0.3:60",
    });
    if (req.url?.startsWith("/stall")) {
      res.write("{");
      return;
    }
    res.end(JSON.stringify({ next_change_id: "2-2-2-2-2", stashes: [{ id: "a", items: [] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("StashRiver.page", () => {
  it("gives up on a page that never finishes arriving", async () => {
    const river = new StashRiver("t", "ua", { url: `${base}/stall`, timeoutMs: 200 });
    await expect(river.page("1-1-1-1-1")).rejects.toThrow();
  }, 2_000);

  it("reads every body even when the pacing interval outlasts the timeout", async () => {
    const river = new StashRiver("t", "ua", { url: base, timeoutMs: 100 });
    const first = await river.page("1-1-1-1-1");
    const second = await river.page("2-2-2-2-2");
    expect(first).toEqual({ stashes: [{ id: "a", items: [] }], nextChangeId: "2-2-2-2-2" });
    expect(second.nextChangeId).toBe("2-2-2-2-2");
  });
});
