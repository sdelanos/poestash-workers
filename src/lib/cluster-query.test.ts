import { describe, expect, it } from "vitest";
import { buildComboSearchQuery } from "./cluster-query";

describe("buildComboSearchQuery", () => {
  // Pinned whole rather than field by field. The app builds the same *shape* in
  // clusterCraftTradeUrl, in a different repo where no test can reach it, so
  // this is what makes a change to the shape here a deliberate one rather than
  // a silent drift away from the search the player clicks.
  it("searches uncorrupted non-unique jewels with the notables, cheapest first", () => {
    expect(buildComboSearchQuery("medium", ["enchant.stat_111", "enchant.stat_222"])).toEqual({
      query: {
        status: { option: "securable" },
        type: "Medium Cluster Jewel",
        stats: [
          {
            type: "and",
            filters: [
              { id: "enchant.stat_111" },
              { id: "enchant.stat_222" },
              { id: "enchant.stat_3086156145", value: { min: 4, max: 5 } },
            ],
          },
        ],
        filters: {
          type_filters: { filters: { rarity: { option: "nonunique" } } },
          misc_filters: { filters: { corrupted: { option: "false" } } },
        },
      },
      sort: { price: "asc" },
    });
  });

  // The bug this module exists for: without the passive-count filter the
  // cheapest listing is an off-size jewel carrying the same notables, and the
  // app subtracts a 4-5 (or 8) passive base cost from that jewel's price.
  it.each([
    ["medium" as const, { min: 4, max: 5 }],
    ["large" as const, { min: 8, max: 8 }],
    // A small row from before the per-count split: the size's whole legal
    // range (RePoE min_skills 2, max_skills 3).
    ["small" as const, { min: 2, max: 3 }],
  ])("filters %s combos on the passive count the craft targets", (jewelSize, passives) => {
    const q = buildComboSearchQuery(jewelSize, ["enchant.stat_111"]) as any;
    expect(q.query.stats[0].filters).toContainEqual({
      id: "enchant.stat_3086156145",
      value: passives,
    });
  });

  // A 2 and a 3 passive small sell as different items (poestash decision 569):
  // a small row priced on one count searches that count exactly. The count is
  // a small row's alone: a medium or large keeps its craft window.
  it.each([2, 3])("searches a small row's own passive count exactly: %i", (n) => {
    const q = buildComboSearchQuery("small", ["enchant.stat_111"], n) as any;
    expect(q.query.stats[0].filters).toContainEqual({
      id: "enchant.stat_3086156145",
      value: { min: n, max: n },
    });
    const medium = buildComboSearchQuery("medium", ["enchant.stat_111"], n) as any;
    expect(medium.query.stats[0].filters).toContainEqual({
      id: "enchant.stat_3086156145",
      value: { min: 4, max: 5 },
    });
  });

  // Better a combo the loop logs and skips than one priced against every
  // passive count, which is the bug wearing a disguise.
  it("refuses a jewel size it has no passive window for", () => {
    expect(() => buildComboSearchQuery("gigantic" as any, ["enchant.stat_111"])).toThrow(
      /Unknown jewel size/,
    );
  });

  it.each([
    ["large" as const, "Large Cluster Jewel"],
    ["small" as const, "Small Cluster Jewel"],
  ])("uses the %s jewel type", (jewelSize, type) => {
    const q = buildComboSearchQuery(jewelSize, ["enchant.stat_111"]) as any;
    expect(q.query.type).toBe(type);
  });
});
