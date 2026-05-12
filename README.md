# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): refreshes poe.ninja PoE 1 prices every 20 minutes.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): refreshes poe.ninja PoE 2 prices every 20 minutes.
- **Cluster prices** (`refresh-cluster-prices.yml`): refreshes cluster jewel combo prices every 6 hours.
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): refreshes Inscribed Ultimatum prices hourly.
- **Gem usage** (`refresh-gem-usage.yml`): refreshes per-gem player counts every 6 hours.
- **Temple prices** (`refresh-temple-prices.yml`): refreshes Temple of Atzoatl room prices hourly.
