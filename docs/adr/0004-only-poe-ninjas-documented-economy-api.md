# Workers call only poe.ninja's documented economy API, politely

## Context

poe.ninja publishes an API reference (https://poe.ninja/docs/api). The economy
overviews and the economy leagues list are the supported public surface. The
builds / profiles API and every other endpoint (character, Path of Building,
auth, `index-state`) are internal and closed to third parties: builds data is
expensive to serve, and serving it would bypass players' privacy settings.
Clients that misbehave, or use the economy endpoints excessively, get blocked.

On 2026-11-19 the workers broke those rules three ways:

- gem-usage read the builds API. poe.ninja had moved the snapshot version out
  of `index-state` and put the build search behind a Cloudflare challenge on
  2026-11-18, so every run failed from 12:15 UTC.
- League discovery read `/<game>/api/data/index-state`.
- The ninja fetchers sent no User-Agent and fired a league's ~68 requests at
  once. poe.ninja answered 429 on whole leagues in about one PoE 1 run in
  three that day.

The ninja workers price the whole app. A block from poe.ninja takes every price
page down, with no other source ready.

## Decision

- Only the documented economy endpoints. League discovery reads
  `/<game>/api/economy/leagues` (`src/lib/ninja-leagues.ts`).
- Every poe.ninja request goes through `ninjaFetch` (`src/lib/ninja-http.ts`):
  a User-Agent naming the app, its site and contact, at most 2 requests in
  flight, a 429 retried after its `Retry-After`, twice at most.
- Never faster than every 30 minutes, for both games (owner call: one
  cadence, which the app's copy and staleness bars assume), PoE 2 15 minutes
  after PoE 1 so the two never overlap. PoE 1's overviews
  refresh about every 15 minutes, PoE 2's hourly.
- gem-usage is stopped, not deleted: no `repository_dispatch` trigger, job
  `if: false`. Its code waits for a sanctioned source of per-gem player counts.
  Getting past the Cloudflare challenge would be evading poe.ninja's bot
  protection, and is not an option.

## Considered options

- Asking poe.ninja for builds access. Their docs answer it already: closed to
  every third party, "nothing personal".
- GGG's ladder API as the gem source. PoeStash wasn't granted
  `service:leagues:ladder`, and a ladder entry lists no gems.

## Consequences

- The app's per-gem player counts (Earn, Gems) freeze at the last snapshot,
  2026-11-18 06:15 UTC. The app says so on the page.
- A PoE 1 league takes about 3 seconds instead of under 1, well inside the
  5-minute workflow timeout.
- A new poe.ninja call that skips `ninjaFetch`, or reaches past the economy
  API, breaks this ADR.
