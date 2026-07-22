# Workers discover leagues per-source, not from the shared cache

## Context

Each price worker needs to know which leagues to refresh (the priced set). The
obvious choice is to read the current challenge league from `poe_leagues_cache`,
the table the leagues worker populates from GGG and the app reads for its league
selector. We deliberately do not do this.

## Decision

Every price worker discovers its leagues from its own upstream:

- ultimatum → poe.watch `/leagues`
- gem-usage → poe.ninja's index-state for the current leagues, then its build
  snapshot list for each one's version (the snapshot list is historical, so it
  answers "what version" but not "what's live")
- ninja → poe.ninja's index-state (pre-existing)
- temple → `ninja_price_meta` (the set the ninja worker actually priced)

Each then reduces that list to the priced set (`lib/priced-set.ts`) and applies
the three-tier failure contract: skip a league its upstream doesn't yet serve,
fail only on a genuine upstream outage.

## Considered options

Reading the challenge league from `poe_leagues_cache` (GGG) was rejected. GGG
lists a new challenge league during the dual-list window hours-to-days before
poe.watch and poe.ninja index it. A cache-driven worker would take the new name
from GGG, query poe.watch, get `400 "league doesn't exist"`, and fail, every
rollover. "Can league X be priced from source Y" is only ever answered truthfully
by source Y. This is exactly the incident that motivated the change: `Mirage`
was hardcoded, the league ended, poe.watch returned 400, and the ultimatum job
failed hourly.

## Consequences

- Rollovers need no workflow edit. Workers follow their source automatically.
- The `poe_leagues_cache` table stays the app's concern, not the workers'.
- `lib/priced-set.ts` prices *every* live challenge league rather than picking
  one. The app selector still resolves to a single "current" league (newest by
  start date), but a worker that dropped a co-live league would silently stop
  pricing a real economy during an event or rollover, so it prices them all.
  The classifier is unit-tested against those multi-league cases.
