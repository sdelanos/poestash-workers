import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllNinjaPrices } from "./ninja-fetcher";

// A poe.ninja stand-in: every exchange category answers with one line, the
// stash feed 404s (as 14 of its categories really do), and the exchange
// Currency feed carries no Divine Orb unless asked to.
function stubNinja({ divine, failing }: { divine: boolean; failing?: string }) {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    const type = url.searchParams.get("type");
    if (type === failing) return new Response("bad gateway", { status: 502 });
    if (url.pathname.includes("/stash/")) return new Response("", { status: 404 });
    const name = type === "Currency" && divine ? "Divine Orb" : `${type} item`;
    return Response.json({
      lines: [{ primaryValue: 300 }],
      items: [{ name, image: null, detailsId: `${type}-1` }],
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchAllNinjaPrices", () => {
  it("treats a 404 as an empty category, not a failure", async () => {
    stubNinja({ divine: true });
    const { failedCategories, rows } = await fetchAllNinjaPrices("poe1", "Hardcore");
    expect(failedCategories).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  // Every category error used to be caught and turned into [], so half of
  // poe.ninja could be down and the run still ended green.
  it("reports a category that fails for any other reason", async () => {
    stubNinja({ divine: true, failing: "Scarab" });
    const { failedCategories } = await fetchAllNinjaPrices("poe1", "Hardcore");
    expect(failedCategories.sort()).toEqual(["exchange:Scarab", "stash:Scarab"]);
  });

  // Permanent Hardcore misses both divine lookups about 4 runs in 10; the run
  // then wrote divine_rate = 0 over the good stored rate.
  it("keeps the last known divine rate when poe.ninja gives none", async () => {
    stubNinja({ divine: false });
    const { divineRate, rows } = await fetchAllNinjaPrices("poe1", "Hardcore", 250);
    expect(divineRate).toBe(250);
    expect(rows.every((r) => r.divineValue === 300 / 250)).toBe(true);
  });
});
