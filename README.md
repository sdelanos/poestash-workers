# PoeStash Workers

Background workers for [PoeStash](https://www.poestash.com). Runs via GitHub Actions on a schedule.

- **Ninja prices, PoE 1** (`refresh-ninja-prices.yml`): fetches all poe.ninja PoE 1 prices every 20 minutes, ~40 categories per league across Mirage/HC Mirage/Standard/Hardcore.
- **Ninja prices, PoE 2** (`refresh-ninja-prices-poe2.yml`): fetches all poe.ninja PoE 2 prices every 20 minutes. 13 verified exchange-source categories (Currency, Fragments, Abyssal Bones, Uncut Gems, Lineage Gems, Essences, Soul Cores, Idols, Runes, Omens, Expedition, Liquid Emotions, Catalysts). Active leagues discovered at runtime via `https://poe.ninja/poe2/api/data/index-state` so league rollovers are zero-touch. PoE 2 currency primary is divine (vs PoE 1's chaos), so the fetcher multiplies `primaryValue` by `core.rates.chaos` to populate the canonical `chaos_value` column.
- **Cluster prices** (`refresh-cluster-prices.yml`): fetches cluster jewel combo prices from PoE trade API every 6 hours
- **Ultimatum prices** (`refresh-ultimatum-prices.yml`): fetches Inscribed Ultimatum mean prices from poe.watch hourly
- **Gem usage** (`refresh-gem-usage.yml`): scrapes per-gem player counts from poe.ninja's builds page every 6 hours. Used by the gem-leveling calculator to filter / de-rank niche gems whose price data exists but whose player demand is too thin to be reliable. Three HTTP requests per league (~225 KB), decodes the protobuf manifest + gem dictionary, upserts ~800 rows into `ninja_gem_usage`.
- **Temple prices** (`refresh-temple-prices.yml`): fetches Temple of Atzoatl gem-room t3 (Doryani's Institute, the double-corrupt gem room) prices from the PoE trade API hourly. Two trade calls per league (search + fetch), median of the cheapest 10 online listings, upserts one row per league into `temple_prices`. Powers the Lapidary Lens (LQD) strategy on the gem-leveling page.
