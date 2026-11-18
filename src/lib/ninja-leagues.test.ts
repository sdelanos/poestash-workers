import { describe, it, expect } from "vitest";
import { poe2LeaguesToPrice } from "./ninja-leagues";

/** poe.ninja's PoE 2 index-state `economyLeagues` as it answered on
 *  2026-11-18: the live league no longer flagged `indexed`, the previous one
 *  still flagged. */
const NOV_2026 = [
  { name: "Forbidden Rites", hardcore: false, indexed: false, isPrivate: false },
  { name: "Runes of Aldur", hardcore: false, indexed: true, isPrivate: false },
  { name: "HC Forbidden Rites", hardcore: true, indexed: false, isPrivate: false },
  { name: "HC Runes of Aldur", hardcore: true, indexed: false, isPrivate: false },
  { name: "Standard", hardcore: false, indexed: false, isPrivate: false },
  { name: "Hardcore", hardcore: true, indexed: false, isPrivate: false },
];

describe("poe2LeaguesToPrice", () => {
  it("prices every softcore challenge league, whatever its indexed flag", () => {
    expect(poe2LeaguesToPrice(NOV_2026)).toEqual(["Forbidden Rites", "Runes of Aldur"]);
  });

  it("between leagues: only permanent leagues listed -> nothing", () => {
    expect(
      poe2LeaguesToPrice([
        { name: "Standard", hardcore: false },
        { name: "Hardcore", hardcore: true },
      ]),
    ).toEqual([]);
  });

  it("leaves out private leagues and SSF/Ruthless variants", () => {
    expect(
      poe2LeaguesToPrice([
        { name: "Forbidden Rites", hardcore: false },
        { name: "My Private League (PL123)", hardcore: false, isPrivate: true },
        { name: "SSF Forbidden Rites", hardcore: false },
        { name: "Ruthless Forbidden Rites", hardcore: false },
      ]),
    ).toEqual(["Forbidden Rites"]);
  });
});
