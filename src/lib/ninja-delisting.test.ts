import { describe, expect, it } from "vitest";
import { DELIST_MIN_RATIO, delistMinRatio, planDelisting } from "./ninja-delisting";
import type { NinjaSource } from "./ninja-types";

const row = (source: NinjaSource, ninjaCategory: string, detailsId: string) => ({
  source,
  ninjaCategory,
  detailsId,
});
const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe("planDelisting", () => {
  it("marks a full answer's feed, keeping exactly the details ids it holds", () => {
    const plan = planDelisting(
      [{ source: "exchange", category: "DivinationCard" }],
      [row("exchange", "DivinationCard", "the-doctor"), row("exchange", "DivinationCard", "the-hoarder")],
      new Map([["exchange:DivinationCard", 3]]),
    );
    expect(plan.held).toEqual([]);
    expect(plan.mark).toEqual([
      { source: "exchange", category: "DivinationCard", keep: ["the-doctor", "the-hoarder"] },
    ]);
  });

  it("keeps each source apart: a stash answer never keeps the exchange's rows", () => {
    const plan = planDelisting(
      [
        { source: "stash", category: "Currency" },
        { source: "exchange", category: "Currency" },
      ],
      [row("stash", "Currency", "divine-orb"), row("exchange", "Currency", "divine-orb"), row("exchange", "Currency", "exalted-orb")],
      new Map([
        ["stash:Currency", 2],
        ["exchange:Currency", 2],
      ]),
    );
    expect(plan.mark).toEqual([
      { source: "stash", category: "Currency", keep: ["divine-orb"] },
      { source: "exchange", category: "Currency", keep: ["divine-orb", "exalted-orb"] },
    ]);
  });

  it("holds back an empty answer and one under half the listed rows", () => {
    const plan = planDelisting(
      [
        { source: "stash", category: "BaseType" },
        { source: "stash", category: "SkillGem" },
        { source: "stash", category: "UniqueArmour" },
      ],
      [
        ...ids(49, "gem").map((id) => row("stash", "SkillGem", id)),
        ...ids(50, "armour").map((id) => row("stash", "UniqueArmour", id)),
      ],
      new Map([
        ["stash:BaseType", 10_000],
        ["stash:SkillGem", 100],
        ["stash:UniqueArmour", 100],
      ]),
    );
    expect(plan.held).toEqual([
      { source: "stash", category: "BaseType", got: 0, listed: 10_000 },
      { source: "stash", category: "SkillGem", got: 49, listed: 100 },
    ]);
    expect(plan.mark.map((m) => [m.category, m.keep.length])).toEqual([["UniqueArmour", 50]]);
  });

  // A failed request is in failedCategories, never in `answered`: its rows
  // stay as they are whatever the table lists.
  it("marks nothing for a feed that wasn't answered, or with nothing listed", () => {
    const plan = planDelisting(
      [{ source: "stash", category: "Fossil" }],
      [row("stash", "Scarab", "scarab-1")],
      new Map([
        ["stash:Scarab", 40],
        ["stash:Fossil", 0],
      ]),
    );
    expect(plan).toEqual({ mark: [], held: [] });
  });

  it("with a ratio of 0 (the backfill), any non-empty answer marks, an empty one still doesn't", () => {
    const plan = planDelisting(
      [
        { source: "stash", category: "UniqueMap" },
        { source: "stash", category: "Oil" },
      ],
      [row("stash", "UniqueMap", "the-beachhead")],
      new Map([
        ["stash:UniqueMap", 500],
        ["stash:Oil", 30],
      ]),
      0,
    );
    expect(plan.mark.map((m) => m.category)).toEqual(["UniqueMap"]);
    expect(plan.held.map((h) => h.category)).toEqual(["Oil"]);
  });
});

describe("delistMinRatio", () => {
  it("reads a share from 0 to 1, else the default", () => {
    expect(delistMinRatio(undefined)).toBe(DELIST_MIN_RATIO);
    expect(delistMinRatio("")).toBe(DELIST_MIN_RATIO);
    expect(delistMinRatio("0")).toBe(0);
    expect(delistMinRatio("0.8")).toBe(0.8);
    expect(delistMinRatio("2")).toBe(DELIST_MIN_RATIO);
    expect(delistMinRatio("half")).toBe(DELIST_MIN_RATIO);
  });
});
