# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): refreshes poe.ninja PoE 1 prices every 30 minutes.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): refreshes poe.ninja PoE 2 prices every 30 minutes.
- **Cluster prices** (`refresh-cluster-prices.yml`): refreshes cluster jewel combo prices every 6 hours.
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): refreshes Inscribed Ultimatum prices hourly.
- **Gem usage** (`refresh-gem-usage.yml`): refreshes per-gem player counts every 6 hours.
- **Temple prices** (`refresh-temple-prices.yml`): refreshes Temple of Atzoatl room prices hourly.
- **Roast rare prices** (`refresh-roast-rare-prices.yml`): prices the rare slots of build guides players pasted into a Roast, every 3 hours.
- **Scrying Orb prices** (`refresh-scrying-orb-prices.yml`): refreshes per-map Scrying Orb prices from poe.watch daily.
- **Warrant corpus** (`refresh-warrant-corpus.yml`): samples the public stash river every 6 hours for listed Mercenary Warrants, and writes per-(support, tier) price contrasts. Costs no trade budget; keeps the raw sample as an Actions artifact, not in Postgres. `npm run analyse:warrant-corpus -- <ndjson>` re-runs the finding against a kept sample. See ADR 0003.
