# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices** (`refresh-ninja-prices.yml`): fetches all poe.ninja prices every 20 minutes
- **Cluster prices** (`refresh-cluster-prices.yml`): fetches cluster jewel combo prices from PoE trade API every 6 hours
