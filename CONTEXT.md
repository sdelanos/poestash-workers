# PoEStash Workers

Scheduled price/data refresh workers for PoEStash. Each worker pulls from a
third-party source (poe.ninja, poe.watch, the PoE trade API, GGG) and upserts
into the shared database the app reads from.

## Language

### Leagues

**Priced set**:
The leagues a price worker refreshes: Standard, Hardcore, every live challenge
league, and each one's Hardcore variant. SSF and Ruthless variants are never
priced. Some workers narrow it (gem-usage drops permanent Hardcore, poe.ninja
keeps no build snapshot for it).

**Challenge league**:
A temporary league (e.g. "Mirage"). Formally: a listed league that isn't
permanent, isn't an SSF/Ruthless variant, and hasn't ended. More than one can be
live at once (see Dual-list window), and all live ones are priced.
_Avoid_: temp league, seasonal league.

**Between-leagues gap**:
The window where no challenge league is live, one has ended and the next hasn't
launched. Expected, not an error: workers price only the permanent leagues and
exit cleanly.

**Dual-list window**:
The rollover window where the source lists both the old and the new challenge
league at once. Both are still live, so both are priced. The same applies to a
standalone event running alongside the main league.

### Discovery

**Per-source discovery**:
Each worker asks its own upstream which leagues exist right now, rather than
reading a central list. A worker only ever prices leagues its own source can
actually serve. See ADR 0001.

**Current challenge league**:
The single league the trade-API workers (cluster jewels, split bases, Roast
rares) price: the newest live challenge league, softcore only. Distinct from the
priced set — these spend one rate-limited trade request per row, so they commit
to one league instead of refreshing all. Resolved from GGG's league list, gated
on poe.ninja having priced it (chaos conversion). See ADR 0002.

**Player-seeded keyspace**:
A universe this repo does not enumerate. The cluster and split workers own their
catalogues (a combo list, a base list) and seed rows themselves; the Roast rare
worker prices only rows the *app* wrote when a player pasted a build guide, and
never invents one. Demand is the enumeration, so the keyspace tracks what people
actually play — and a row retires on a `last_seen_at` sweep once nobody pastes
that guide any more.

**Three-tier failure contract**:
How a worker decides between exiting quietly and failing loud. Discovery call
fails (upstream down) → fail loud. Discovery returns no challenge league
(between-leagues) → skip quietly. A single discovered league has no data yet
(404 / "doesn't exist" / empty) → skip that league, keep going, still exit 0.

### Prices

**Two-sided quote**:
The `pay` / `receive` pair poe.ninja publishes on its stash currency feed, and
only there — Currency and Fragment, nothing else. The receive side is what an
instant buyer pays; the pay side is what an instant seller gets. Either can be
absent, and often is: 36 of 68 lines were receive-only in the 2026-08-15
Allflame capture. The gap between the two sides is the app's **Spread**
(ADR 0042 in the app repo).

**Inverted units**:
The trap in that feed, and the reason `stash-currency-rows.ts` exists.
`receive.value` is chaos per unit; `pay.value` is **units per chaos** — the
same quote upside down. Divine Orb reads 0.0055 against a 185-chaos orb.
Left alone the pay side is wrong by a factor of the price squared and looks
like a plausible small number, so the inversion is killed at the ingestion
boundary, in a pure function, pinned by tests against a captured payload.
Nothing downstream of this worker ever sees a per-chaos rate.

**Ingestion reports, the strategy judges**:
The spread columns are written verbatim. The live feed carries 90%-plus
spreads on vendor-tier currency, crossed quotes on thin pairs (Ancient Orb:
pay 6.0c above receive 5.0c), and occasional garbage rows — all real, all
stored. The volume floor and the exchange-feed referee that throw those out
live in the app, where the hourly volume they need actually exists. A worker
that quietly dropped them would hide the data the guards are calibrated on.

### The river

**Public stash river**:
GGG's `/public-stash-tabs` — one append-only stream of every public stash tab
edit in the game, addressed by an opaque change id. It is a *separate budget*
from the trade API: its own policy (`Ip=2:1:60`, two requests a second per IP)
on a `service:psapi` token, so reading it costs none of ADR 0022's 30-per-300s
trade window that four other workers share.
_Avoid_: "the stash API" (that is the per-account one the app uses); "the feed".

**Synthetic change id**:
Five identical numbers where a real change id has five shard counters. GGG
accepts one and seeks to the nearest real position, which is the only reason a
river consumer here is possible: a run bisects to the live tail in about twelve
requests instead of walking the stream from 2013.

**The tail**:
The live end of the river, found by bisection **every run** and never
hardcoded. It moves, and it moves in both directions: a head measured at
`5.2e9` returned an empty page days later, with the live tail at `3.47e9`. A
stale position fails silently, because an empty page is not an error.

**Sample, not stream**:
This repo's posture toward the river. A run seeks, drains a bounded number of
pages, and stops; no cursor is persisted. So a late, interrupted or repeated
run samples a *later slice of the same market* rather than falling behind —
there is no catch-up debt and no staleness bug, which is what makes the Warrant
corpus unusually tolerant of a missed schedule. Idempotence within a run comes
from deduping on GGG's item id, because a tab crossing the river twice
republishes every item in it.

**Listing note**:
Where the river carries a price, since it has no price field. GGG's convention
verbatim: `~b/o N currency` or `~price N currency`, in the item's own `note` or,
for a whole tab priced at once, in the stash tab's name. The item's note wins.
Two traps, both live-measured: sellers append prose (`~price 3 chaos Bulk
Sales`), and `~price N offer` is a **Currency Exchange** listing whose number is
a ratio, not an amount — read as one it makes a 1-chaos Warrant, so it is
dropped rather than parsed.

### The Warrant corpus

**Corpus row**:
One `(game, league, support_hash, tier)` contrast — never one row per observed
Warrant. A per-observation log would be ~1.25M rows and ~500MB a day at the
measured rate; the pair key collapses that to a few hundred rows a league,
overwritten in place, flat however long the worker runs.

**Separation (AUC)**:
The probability that a sampled Warrant carrying a (support, tier) pair is priced
above one that is not, ties counted as half. **0.5 means the axis separates
nothing.** It is a rank statistic because a ratio of medians is useless here:
Warrants are priced in round divine, 6,967 live listings had a median of exactly
one divine and so did nearly every subgroup, so a ratio could only ever return
1.00 or 2.00. Only readable next to `sample_count` — a pair seen four times has
an AUC and it means nothing.
_Avoid_: calling it a price, a premium, or a multiplier.

**Stratum**:
One identical skill set, and the population a (support, tier) contrast is
actually drawn inside. Comparing across the whole league is confounded — a
support rolls on some builds and not others, so "every Warrant without it" is a
different population rather than the same one minus the support. This is not a
technicality: `Return T3` reads 0.574 league-wide, which is noise, and 0.668
stratified. **The pooled figure hid a real effect**, so `stratified_auc` is the
column to read and `separation_auc` is kept beside it because the gap between
them is the finding.

**The answer it gave**:
One axis separates price, and only under stratification. `Return T3`, at 0.668
across 28 strata and favoured in 26 of them (p = 0.0033 against its own
permutation null). Nothing else clears its own null, and the Archetype's
Infamous strain — already ruled out by app ADR 0060 — sits at 0.544. That clears
the bar ADR 0060 set for narrowing a Warrant query, without settling whether the
query should change. Write-up in the app repo at
`docs/research/warrant-support-price-separation.md`.
