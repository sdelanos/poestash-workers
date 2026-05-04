/**
 * poe.ninja builds scraper.
 *
 * The poe.ninja /poe1/builds page exposes per-gem player counts via three
 * HTTP requests, none of which are publicly documented:
 *
 *   1. GET /poe1/api/data/index-state
 *      JSON. Lists current build snapshots with their `version` strings, one
 *      per league + snapshot type ("exp" / "depthsolo" / etc.).
 *
 *   2. GET /poe1/api/builds/{version}/search?overview={league}&type=exp
 *      Protobuf. The "manifest" — per-facet sub-dictionary hashes (class,
 *      gem, item, ...) plus the aggregated per-gem player counts under the
 *      "allgems" facet entry.
 *
 *   3. GET /poe1/api/builds/dictionary/{gem_hash}
 *      Protobuf. Ordered list of 800+ gem display names. The gem index in
 *      the manifest's allgems entries refers to a position in this list.
 *
 * The "filter" URL param is server-ignored - actual filtering happens
 * client-side in WASM. We do not need to filter; we get every gem's count
 * in one manifest fetch.
 *
 * Wire format reference (decoded by hand, no schema available):
 *
 *   manifest top-level:
 *     field 1, msg = inner
 *
 *   inner:
 *     field 2, repeated msg = facet entry (class, gem, allgems, ...)
 *       field 1, str = facet name
 *       field 3, repeated msg (allgems-only): { f1: gem_index (default 0), f2: count }
 *     field 6, repeated msg = dictionary reference
 *       field 1, str = facet name
 *       field 2, str = sha1 hash to fetch under /dictionary/{hash}
 *
 *   gem dictionary:
 *     field 1, str = type label ("gem")
 *     field 2, repeated str = gem display names (indexed)
 */

const POE_NINJA_BASE = "https://poe.ninja";

const USER_AGENT =
  "Mozilla/5.0 (compatible; poestash-workers/1.0; +https://www.poestash.com)";

/** HTTP timeout for every poe.ninja request. The endpoints respond in
 *  milliseconds in normal conditions; 15 s is generous enough to absorb
 *  any cloud blip without letting the workflow hang indefinitely. */
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Tiny protobuf wire-format decoder. No schema, just parses the on-the-wire
// representation: tag-prefixed varint / fixed / length-delimited fields.
// ---------------------------------------------------------------------------

type WireType = 0 | 1 | 2 | 5;

interface ProtoField {
  wire: WireType;
  /** Varint as bigint to handle 64-bit safely. */
  v?: bigint;
  /** Raw bytes for wire type 2. */
  bytes?: Uint8Array;
  /** 32 / 64 bit fixed-width values. */
  fixed?: bigint;
}

function readVarint(buf: Uint8Array, pos: number): { v: bigint; pos: number } {
  let v = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    v |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { v, pos };
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

/**
 * Parse a protobuf message into a map of field number -> array of values.
 * Each value is either { v: bigint } (varint), { bytes: Uint8Array } (length-delimited),
 * or { fixed: bigint } (fixed32/fixed64).
 */
function parseProto(
  buf: Uint8Array,
  start: number,
  end: number,
): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let pos = start;
  while (pos < end) {
    const { v: tag, pos: tagEnd } = readVarint(buf, pos);
    pos = tagEnd;
    const fieldNum = Number(tag >> 3n);
    const wire = Number(tag & 7n) as WireType;
    let entry: ProtoField;
    if (wire === 0) {
      const { v, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      entry = { wire, v };
    } else if (wire === 2) {
      const { v: len, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      const lenN = Number(len);
      if (lenN < 0 || pos + lenN > end) {
        throw new Error(
          `truncated length-delimited field at pos=${pos}, len=${lenN}, end=${end}`,
        );
      }
      entry = { wire, bytes: buf.subarray(pos, pos + lenN) };
      pos += lenN;
    } else if (wire === 1) {
      if (pos + 8 > end) throw new Error("truncated fixed64 field");
      const lo = BigInt(buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24));
      const hi = BigInt(buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24));
      entry = { wire, fixed: lo | (hi << 32n) };
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > end) throw new Error("truncated fixed32 field");
      entry = {
        wire,
        fixed: BigInt(buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)),
      };
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    let arr = fields.get(fieldNum);
    if (!arr) {
      arr = [];
      fields.set(fieldNum, arr);
    }
    arr.push(entry);
  }
  return fields;
}

function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder("utf-8").decode(b);
}

// ---------------------------------------------------------------------------
// HTTP fetch helpers
// ---------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/x-protobuf, application/json, */*",
      Referer: "https://poe.ninja/poe1/builds",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface IndexStateSnapshot {
  url: string;
  type: string;
  name: string;
  version: string;
  snapshotName: string;
}

interface IndexStateResponse {
  snapshotVersions: IndexStateSnapshot[];
  buildLeagues: { name: string; url: string; displayName: string }[];
  oldBuildLeagues?: { name: string; url: string; displayName: string }[];
  economyLeagues?: { name: string; url: string; displayName: string }[];
}

export interface GemUsageResult {
  league: string;
  snapshotVersion: string;
  /** Map of gem display name -> player count, only entries with count > 0 are present. */
  counts: Map<string, number>;
}

/**
 * List all current build leagues with snapshot versions for type "exp".
 * The "exp" type is the regular per-character snapshot we want; other types
 * ("depthsolo" for delve, etc.) target different leaderboards.
 */
export async function listBuildLeagues(): Promise<
  { url: string; name: string; version: string }[]
> {
  const idx = await fetchJson<IndexStateResponse>(
    `${POE_NINJA_BASE}/poe1/api/data/index-state`,
  );
  return idx.snapshotVersions
    .filter((s) => s.type === "exp")
    .map((s) => ({ url: s.url, name: s.name, version: s.version }));
}

/**
 * Fetch and decode per-gem player counts for one league snapshot.
 * Issues exactly 2 HTTP requests:
 *   - /poe1/api/builds/{version}/search?overview={overview}&type=exp
 *   - /poe1/api/builds/dictionary/{gem_hash}
 *
 * Note: the `overview` query param is NOT the league.url slug. It's the
 * league.name lowercased with spaces replaced by hyphens. Verified by
 * intercepting the page's actual fetches:
 *   "Mirage"          -> overview=mirage
 *   "Hardcore Mirage" -> overview=hardcore-mirage  (NOT miragehc!)
 *   "SSF Mirage"      -> overview=ssf-mirage
 *   "Standard"        -> overview=standard
 */
export async function fetchGemUsage(
  leagueName: string,
  version: string,
): Promise<GemUsageResult> {
  const overview = leagueName.toLowerCase().replace(/\s+/g, "-");
  // 1. Manifest
  const manifestBuf = await fetchBytes(
    `${POE_NINJA_BASE}/poe1/api/builds/${version}/search?overview=${encodeURIComponent(overview)}&type=exp`,
  );
  const top = parseProto(manifestBuf, 0, manifestBuf.length);
  const innerBytes = top.get(1)?.[0]?.bytes;
  if (!innerBytes) {
    throw new Error("manifest: missing inner field 1");
  }
  const inner = parseProto(innerBytes, 0, innerBytes.length);

  // Find dictionary references (field 6, repeated): { f1: name, f2: hash }
  const dictRefs = new Map<string, string>();
  for (const ent of inner.get(6) ?? []) {
    if (!ent.bytes) continue;
    const sub = parseProto(ent.bytes, 0, ent.bytes.length);
    const name = sub.get(1)?.[0]?.bytes;
    const hash = sub.get(2)?.[0]?.bytes;
    if (name && hash) {
      dictRefs.set(decodeUtf8(name), decodeUtf8(hash));
    }
  }
  const gemHash = dictRefs.get("gem");
  if (!gemHash) {
    throw new Error("manifest: no 'gem' dictionary hash");
  }

  // Find allgems facet entry (field 2, repeated): { f1: facet_name, f3: repeated counts }
  let allgemsEntry: Map<number, ProtoField[]> | null = null;
  for (const ent of inner.get(2) ?? []) {
    if (!ent.bytes) continue;
    const sub = parseProto(ent.bytes, 0, ent.bytes.length);
    const name = sub.get(1)?.[0]?.bytes;
    if (name && decodeUtf8(name) === "allgems") {
      allgemsEntry = sub;
      break;
    }
  }
  if (!allgemsEntry) {
    throw new Error("manifest: no allgems facet");
  }

  // Each f3 entry is { f1: gem_index (default 0), f2: count }
  const indexCounts: { idx: number; count: number }[] = [];
  for (const ent of allgemsEntry.get(3) ?? []) {
    if (!ent.bytes) continue;
    const sub = parseProto(ent.bytes, 0, ent.bytes.length);
    const idx = Number(sub.get(1)?.[0]?.v ?? 0n);
    const count = Number(sub.get(2)?.[0]?.v ?? 0n);
    indexCounts.push({ idx, count });
  }

  // 2. Gem dictionary
  const dictBuf = await fetchBytes(
    `${POE_NINJA_BASE}/poe1/api/builds/dictionary/${gemHash}`,
  );
  const dict = parseProto(dictBuf, 0, dictBuf.length);
  const gemNames: string[] = [];
  for (const ent of dict.get(2) ?? []) {
    if (!ent.bytes) continue;
    gemNames.push(decodeUtf8(ent.bytes));
  }

  // 3. Join
  const counts = new Map<string, number>();
  let outOfRange = 0;
  for (const { idx, count } of indexCounts) {
    if (count <= 0) continue;
    if (idx < 0 || idx >= gemNames.length) {
      outOfRange++;
      continue;
    }
    const name = gemNames[idx];
    // dedupe in case the manifest reports the same gem twice (shouldn't, but be safe)
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  if (outOfRange > 0) {
    // Schema drift signal: poe.ninja is referencing gem indices we don't
    // have in the dictionary we just downloaded. Log so we notice.
    console.warn(
      `[poeninja-builds] ${outOfRange} allgems entries referenced gem indices outside the dictionary (size ${gemNames.length}). poe.ninja may have updated their schema.`,
    );
  }

  return {
    league: leagueName,
    snapshotVersion: version,
    counts,
  };
}
