# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): refreshes poe.ninja PoE 1 prices every 20 minutes.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): refreshes poe.ninja PoE 2 prices every 20 minutes.
- **Cluster prices** (`refresh-cluster-prices.yml`): refreshes cluster jewel combo prices every 6 hours.
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): refreshes Inscribed Ultimatum prices hourly.
- **Gem usage** (`refresh-gem-usage.yml`): refreshes per-gem player counts every 6 hours.
- **Temple prices** (`refresh-temple-prices.yml`): refreshes Temple of Atzoatl room prices hourly.
- **Localized game data** (`refresh-localized-data.yml`): when GGG ships a PoE 1 patch, runs the `repoe-fork/RePoE` extractor headless against the patch CDN for every language and opens a PR against the app repo refreshing `docs/repoe-data/` (filled `stat_translations.json` slots + per-language `{Language}/names.json`). Unlike the other workers this one commits files rather than writing to the database. See ADR 0004 in the app repo. Requires a `POESTASH_REPO_TOKEN` secret (a token with `repo` scope on `sdelanos/poestash`) so the Action can open the cross-repo PR.
