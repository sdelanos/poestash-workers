/**
 * Re-runs the finding in `docs/research/warrant-support-price-separation.md`
 * (app repo) against a raw corpus sample.
 *
 * Usage:
 *   npx tsx src/analyse-warrant-corpus.ts <observations.ndjson> [league] [--divine N]
 *
 * The NDJSON is what `refresh-warrant-corpus --raw-out` writes and the workflow
 * keeps as an Actions artifact. The chaos rates come from `ninja_prices` via
 * DATABASE_URL, or from `--divine N` when you have the file but no database.
 *
 * **Why this is a separate script and not part of the worker.** The worker
 * stores per-(support, tier) contrasts and nothing else, which is the whole
 * cost argument in ADR 0003. But the *claim* the corpus was built to make —
 * that `Return T3` separates price and nothing else does — rests on things the
 * stored table cannot show: the null controls, the Infamous and support-count
 * reference points, and the within-subgroup selection check. Those are the
 * numbers that amend an ADR, so they have to be re-runnable by someone who
 * doubts them rather than retyped from a CI log. Nothing here writes anything.
 *
 * **What a null control is for.** A deviation from 0.5 is only meaningful
 * against what chance produces at the same shape. Shuffling prices across the
 * same Warrants destroys any real relationship while preserving every sample
 * size and the price distribution exactly, so the largest deviation *it* gives
 * is what "nothing at all" looks like. A real axis has to beat that, not 0.5.
 *
 * Two shuffles, because there are two claims. The corpus-wide null shuffles
 * across the whole league, and its maximum over 130 axes is the bar the
 * league-wide figures have to clear (they do not). The stratified null shuffles
 * *within* each identical skill set, which nulls the within-build relationship
 * while leaving between-build price differences intact — the exact thing
 * `stratified_auc` claims to measure. Each candidate is tested against a null
 * matched to its own strata shape, because a maximum pooled over candidates
 * measured across 5 strata is the wrong yardstick for one measured across 28.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildCorpus, type CorpusRow, type PricedObservation } from "./lib/warrant-corpus";
import { toChaos } from "./lib/listing-price";
import type { WarrantObservation } from "./lib/warrant-observation";

/** Shuffles behind the corpus-wide null. Stated here so the figure is citable. */
const CORPUS_SHUFFLES = 100;
/** Shuffles behind each within-skill-set subgroup's null. */
const SUBGROUP_SHUFFLES = 200;
/** A pair needs this many Warrants on both sides before it is worth reading. */
const MIN_SIDE = 50;
/** And this many measurable strata before its stratified figure means anything. */
const MIN_STRATA = 5;
/** Shuffles behind each stratified candidate's own null. */
const STRATIFIED_SHUFFLES = 300;

const CURRENCY_SLUGS: Record<string, string> = {
  chaos: "chaos orb",
  divine: "divine orb",
  exalted: "exalted orb",
  mirror: "mirror of kalandra",
  annul: "orb of annulment",
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
}

/** The corpus statistic for one hand-made split, reusing nothing from the table. */
function auc(withPair: number[], without: number[]): number {
  if (withPair.length === 0 || without.length === 0) return 0.5;
  const all = [...withPair, ...without].sort((a, b) => a - b);
  const ranks: number[] = [];
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1] === all[i]) j++;
    const shared = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }
  // Walk each value's positions once so ties are consumed, not double-counted.
  const positions = new Map<number, number[]>();
  all.forEach((v, i) => {
    const list = positions.get(v);
    if (list) list.push(i);
    else positions.set(v, [i]);
  });
  const used = new Map<number, number>();
  let rankSum = 0;
  for (const v of withPair) {
    const u = used.get(v) ?? 0;
    rankSum += ranks[positions.get(v)![u]];
    used.set(v, u + 1);
  }
  const n1 = withPair.length;
  const n2 = without.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

/** The same prices, dealt to different Warrants **within their own stratum**.
 *  Destroys any within-skill-set relationship while leaving the between-skill-
 *  set price differences intact — so it nulls exactly what the stratified
 *  statistic claims to measure, and nothing else. */
function shuffledWithinStrata(sample: PricedObservation[]): PricedObservation[] {
  const bySkills = new Map<string, PricedObservation[]>();
  for (const p of sample) {
    const key = p.observation.skillHashes.join(",");
    const bucket = bySkills.get(key);
    if (bucket) bucket.push(p);
    else bySkills.set(key, [p]);
  }
  return [...bySkills.values()].flatMap(shuffledPrices);
}

/** The same prices, dealt to different Warrants. Destroys any real signal and
 *  keeps every sample size and the price distribution exactly. */
function shuffledPrices(sample: PricedObservation[]): PricedObservation[] {
  const prices = sample.map((p) => p.chaos);
  for (let i = prices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [prices[i], prices[j]] = [prices[j], prices[i]];
  }
  return sample.map((p, i) => ({ observation: p.observation, chaos: prices[i] }));
}

const deviation = (rows: CorpusRow[]) =>
  Math.max(0, ...rows.filter((r) => r.sampleCount >= MIN_SIDE && r.baselineCount >= MIN_SIDE)
    .map((r) => Math.abs(r.separationAuc - 0.5)));

async function chaosRates(league: string, divineOverride: number | null) {
  if (divineOverride != null) {
    return new Map<string, number>([["chaos", 1], ["divine", divineOverride]]);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL for chaos rates, or pass --divine N");
  }
  const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 10, prepare: false });
  try {
    const rows = await sql<{ item_name: string; chaos_value: number; source: string }[]>`
      SELECT item_name, chaos_value, source FROM ninja_prices
      WHERE game = 'poe1' AND league = ${league}
        AND item_name = ANY(${Object.values(CURRENCY_SLUGS)})
    `;
    const best = new Map<string, number>();
    for (const r of rows) {
      if (!best.has(r.item_name) || r.source === "exchange") {
        best.set(r.item_name, Number(r.chaos_value));
      }
    }
    const rates = new Map<string, number>([["chaos", 1]]);
    for (const [slug, name] of Object.entries(CURRENCY_SLUGS)) {
      const v = best.get(name);
      if (v && v > 0) rates.set(slug, v);
    }
    return rates;
  } finally {
    await sql.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const file = positional[0];
  const league = positional[1] ?? "Allflame";
  const divIdx = args.indexOf("--divine");
  const divine = divIdx === -1 ? null : Number(args[divIdx + 1]);
  if (!file) {
    console.error("Usage: analyse-warrant-corpus.ts <observations.ndjson> [league] [--divine N]");
    process.exit(1);
  }

  const rates = await chaosRates(league, divine);

  // Dedupe here too: the file is append-as-you-drain, so a relisted tab is in
  // it twice and would weight one seller's prices twice.
  const byId = new Map<string, WarrantObservation>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as WarrantObservation;
    if (o.league === league) byId.set(o.itemId, o);
  }

  const sample: PricedObservation[] = [];
  for (const o of byId.values()) {
    const chaos = toChaos(o.price, rates);
    if (chaos != null) sample.push({ observation: o, chaos });
  }
  const prices = sample.map((p) => p.chaos);
  console.log(
    `${league}: ${sample.length} priced Warrants (1 divine = ${rates.get("divine")}c)\n` +
      `  p10=${quantile(prices, 0.1)}c median=${median(prices)}c p90=${quantile(prices, 0.9)}c ` +
      `max=${Math.max(...prices)}c`,
  );

  const corpus = buildCorpus(sample);
  const solid = corpus
    .filter((r) => r.sampleCount >= MIN_SIDE && r.baselineCount >= MIN_SIDE)
    .sort((a, b) => b.separationAuc - a.separationAuc);
  console.log(`\n${corpus.length} pairs, ${solid.length} with >=${MIN_SIDE} Warrants either side`);
  console.log("league-wide (confounded), strongest and weakest:");
  for (const r of [...solid.slice(0, 3), ...solid.slice(-2)]) {
    console.log(
      `  ${`${r.supportName} T${r.tier}`.padEnd(40)} n=${String(r.sampleCount).padStart(4)} ` +
        `auc=${r.separationAuc.toFixed(3)}`,
    );
  }

  // The comparison that matters: inside identical skill sets. `strataAbove` of
  // `strataCount` is the sign test, and it is the more robust of the two.
  const stratified = corpus
    .filter((r) => r.strataCount >= MIN_STRATA)
    .sort((a, b) => Math.abs(b.stratifiedAuc - 0.5) - Math.abs(a.stratifiedAuc - 0.5));
  console.log(`\nstratified within identical skill sets (>=${MIN_STRATA} strata):`);
  for (const r of stratified.slice(0, 6)) {
    console.log(
      `  ${`${r.supportName} T${r.tier}`.padEnd(40)} auc=${r.stratifiedAuc.toFixed(3)} ` +
        `strata=${String(r.strataCount).padStart(2)} above=${String(r.strataAbove).padStart(2)} ` +
        `(league-wide ${r.separationAuc.toFixed(3)})`,
    );
  }

  // Each candidate against a null matched to its OWN strata shape. A single
  // pooled maximum over every pair would be dominated by the 5-strata ones,
  // which is the wrong yardstick for a pair measured across 28.
  console.log(`\nper-pair null (${STRATIFIED_SHUFFLES} within-stratum shuffles each):`);
  for (const r of stratified.slice(0, 3)) {
    const key = `${r.supportHash}:${r.tier}`;
    const real = Math.abs(r.stratifiedAuc - 0.5);
    let atLeast = 0;
    let worst = 0;
    for (let i = 0; i < STRATIFIED_SHUFFLES; i++) {
      const row = buildCorpus(shuffledWithinStrata(sample)).find(
        (x) => `${x.supportHash}:${x.tier}` === key,
      );
      const dev = row ? Math.abs(row.stratifiedAuc - 0.5) : 0;
      worst = Math.max(worst, dev);
      if (dev >= real) atLeast++;
    }
    console.log(
      `  ${`${r.supportName} T${r.tier}`.padEnd(40)} real ${real.toFixed(3)}  ` +
        `null max ${worst.toFixed(3)}  p=${((atLeast + 1) / (STRATIFIED_SHUFFLES + 1)).toFixed(4)}`,
    );
  }

  let nullMax = 0;
  for (let i = 0; i < CORPUS_SHUFFLES; i++) {
    nullMax = Math.max(nullMax, deviation(buildCorpus(shuffledPrices(sample))));
  }
  console.log(
    `\nStrongest real axis:      |auc-0.5| = ${deviation(solid).toFixed(3)}\n` +
      `Strongest under ${String(CORPUS_SHUFFLES).padStart(3)} shuffles: |auc-0.5| = ${nullMax.toFixed(3)}` +
      `  -> ${deviation(solid) > nullMax ? "EXCEEDS chance" : "within chance"}`,
  );

  // The two reference points. Infamous is the one ADR 0060 already ruled out,
  // so it is the bar a support axis has to clear to mean anything new.
  const infamous = sample.filter((p) => p.observation.infamous).map((p) => p.chaos);
  const plain = sample.filter((p) => !p.observation.infamous).map((p) => p.chaos);
  console.log(
    `\nInfamous (ADR 0060's own reference): n=${infamous.length} vs ${plain.length}, ` +
      `auc=${auc(infamous, plain).toFixed(3)}`,
  );
  const pairCount = (p: PricedObservation) => p.observation.supports.length;
  const many = sample.filter((p) => pairCount(p) >= 14).map((p) => p.chaos);
  const few = sample.filter((p) => pairCount(p) <= 11).map((p) => p.chaos);
  console.log(
    `Support count (>=14 vs <=11):        n=${many.length} vs ${few.length}, ` +
      `auc=${auc(many, few).toFixed(3)}`,
  );

  // Within one identical skill set — ADR 0060's actual comparable set — the
  // best support looks spectacular. Each subgroup tests ~30 candidates at
  // n~45, which is the setup that manufactures large effects, so each gets its
  // own null at its own shape.
  console.log(`\nWithin identical skill sets (best of ~30 candidates vs ${SUBGROUP_SHUFFLES} shuffles):`);
  const bySkills = new Map<string, PricedObservation[]>();
  for (const p of sample) {
    const key = p.observation.skillHashes.join(",");
    const bucket = bySkills.get(key);
    if (bucket) bucket.push(p);
    else bySkills.set(key, [p]);
  }
  const groups = [...bySkills.values()]
    .filter((g) => g.length >= 30)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  // A subgroup is far smaller than a league, so the corpus-wide floor of 50
  // would leave no candidates at all; 8 is the smallest side worth an AUC here.
  const subDeviation = (rows: CorpusRow[]) =>
    Math.max(0, ...rows.filter((r) => r.sampleCount >= 8 && r.baselineCount >= 8)
      .map((r) => Math.abs(r.separationAuc - 0.5)));
  for (const group of groups) {
    const real = subDeviation(buildCorpus(group));
    let best = 0;
    for (let i = 0; i < SUBGROUP_SHUFFLES; i++) {
      best = Math.max(best, subDeviation(buildCorpus(shuffledPrices(group))));
    }
    console.log(
      `  n=${String(group.length).padStart(3)}  best real ${real.toFixed(3)}  ` +
        `best shuffled ${best.toFixed(3)}  -> ${real > best ? "EXCEEDS chance" : "within chance"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
