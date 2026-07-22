import { describe, it, expect } from "vitest";
import { selectPricedSet, type LeagueLike } from "./priced-set";

const named = (names: string[]): LeagueLike[] => names.map((name) => ({ name }));

const NOW = Date.parse("2026-07-22T00:00:00Z");
const FUTURE = "2026-09-01T00:00:00Z";
const PAST = "2026-06-01T00:00:00Z";

describe("selectPricedSet", () => {
  it("between leagues: only permanent leagues listed -> Standard + Hardcore", () => {
    // The current incident state: no challenge league is live.
    const leagues = named(["Standard", "Hardcore", "Solo Self-Found", "Hardcore SSF"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });

  it("live challenge league: adds the challenge and its Hardcore variant", () => {
    const leagues = named([
      "Standard",
      "Hardcore",
      "Solo Self-Found",
      "Mirage",
      "Hardcore Mirage",
      "SSF Mirage",
      "HC SSF Mirage",
    ]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
    ]);
  });

  it("never prices SSF or Ruthless variants", () => {
    const leagues = named([
      "Standard",
      "Hardcore",
      "Ruthless",
      "Hardcore Ruthless",
      "SSF Ruthless",
      "Mirage",
      "Ruthless Mirage",
      "SSF Mirage",
    ]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
    ]);
  });

  it("includes the challenge even if its Hardcore variant is missing", () => {
    const leagues = named(["Standard", "Hardcore", "Mirage"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
    ]);
  });

  it("dual-list window: old + new challenge both live -> prices both", () => {
    // During a rollover the source briefly lists the outgoing and incoming
    // leagues together. Both are still live, so both are priced.
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: FUTURE },
      { name: "Hardcore Mirage", endAt: FUTURE },
      { name: "Fate of the Vaal", endAt: null },
      { name: "Hardcore Fate of the Vaal", endAt: null },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
      "Fate of the Vaal",
      "Hardcore Fate of the Vaal",
    ]);
  });

  it("event overlap: prices both the challenge league and the event", () => {
    // An Ancestors-style event running next to the main league. Both are live
    // economies, so both are priced. The main league is never dropped.
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: FUTURE },
      { name: "Hardcore Mirage", endAt: FUTURE },
      { name: "Return of the Ancestors", endAt: FUTURE },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
      "Return of the Ancestors",
    ]);
  });

  it("ignores an ended challenge league still listed by the source", () => {
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: PAST },
      { name: "Hardcore Mirage", endAt: PAST },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });

  it("drops permanent Hardcore when asked (gem-usage), keeps the HC challenge", () => {
    const leagues = named(["Standard", "Hardcore", "Mirage", "Hardcore Mirage", "SSF Mirage"]);
    expect(
      selectPricedSet(leagues, { now: NOW, includePermanentHardcore: false }),
    ).toEqual(["Standard", "Mirage", "Hardcore Mirage"]);
  });

  it("names-only input (poe.ninja index-state, no dates): single live challenge", () => {
    const leagues = named(["Standard", "Mirage", "Hardcore Mirage", "SSF Mirage"]);
    expect(selectPricedSet(leagues)).toEqual(["Standard", "Mirage", "Hardcore Mirage"]);
  });

  it("returns only leagues actually present (never fabricates Standard/Hardcore)", () => {
    const leagues = named(["Mirage", "Hardcore Mirage"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Mirage", "Hardcore Mirage"]);
  });

  it("deduplicates repeated names", () => {
    const leagues = named(["Standard", "Standard", "Hardcore"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });
});
