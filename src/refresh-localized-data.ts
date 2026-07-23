/**
 * Post-process a `repoe-fork/RePoE --language all` PoE1 run into the tree
 * PoeStash vendors under `docs/repoe-data/`, then gate the result. The heavy
 * extraction (Python/PyPoE reading GGG's patch CDN) runs in the workflow before
 * this; this script owns the shape work and the schema assertions. See ADR 0004
 * / 0005 in the app repo.
 *
 * Usage:
 *   tsx src/refresh-localized-data.ts assemble --src <repoe-data> --out <vendored> [--version 3.28.0.16]
 *   tsx src/refresh-localized-data.ts check    --dir <vendored> [--languages French,Korean]
 *
 * `assemble` writes the vendored tree, stamps version.txt (when --version is
 * given), and fails if the schema gate finds problems. `check` re-runs the gate
 * on an existing tree (defaulting to every language folder it finds).
 */

import { writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { assembleVendoredData, checkVendoredOutput } from "./lib/repoe-assemble";
import { LANGS } from "./lib/repoe-localized";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function require_(name: string): string {
  const v = flag(name);
  if (!v) {
    console.error(`Missing required --${name}`);
    process.exit(2);
  }
  return v;
}

/** Language folders (non-English) actually present under a vendored tree. */
function presentLanguages(dir: string): string[] {
  return LANGS.filter(
    (lang) =>
      lang !== "English" &&
      existsSync(join(dir, lang)) &&
      statSync(join(dir, lang)).isDirectory(),
  );
}

function gate(dir: string, languages: string[]): void {
  const errors = checkVendoredOutput(dir, languages);
  if (errors.length > 0) {
    console.error(`Schema gate failed for [${languages.join(", ")}]:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`Schema gate passed for [${languages.join(", ")}].`);
}

const command = process.argv[2];

if (command === "assemble") {
  const src = require_("src");
  const out = require_("out");
  const version = flag("version");

  const summary = assembleVendoredData(src, out);
  if (version) writeFileSync(join(out, "version.txt"), version);

  console.log(`Assembled ${summary.statEntries} stat entries into ${out}`);
  console.log(`Languages: ${summary.languages.join(", ") || "(none)"}`);
  for (const lang of summary.languages) {
    const n = summary.names[lang];
    console.log(
      `  ${lang}: ${summary.filledStatSlots[lang]} stat slots, ` +
        `${n.bases} bases / ${n.currency} currency / ${n.gems} gems / ${n.uniques} uniques`,
    );
  }
  if (summary.languages.length === 0) {
    console.error("No non-English language folders found — did RePoE run with --language all?");
    process.exit(1);
  }
  gate(out, summary.languages);
} else if (command === "check") {
  const dir = require_("dir");
  const languages = flag("languages")?.split(",").map((s) => s.trim()).filter(Boolean) ?? presentLanguages(dir);
  if (languages.length === 0) {
    console.error(`No language folders found under ${dir}`);
    process.exit(1);
  }
  gate(dir, languages);
} else {
  console.error("Usage: refresh-localized-data.ts <assemble|check> [flags]");
  process.exit(2);
}
