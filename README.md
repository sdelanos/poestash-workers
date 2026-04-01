# PoeStash Cluster Prices

Fetches cluster jewel combo prices from the PoE trade API and stores them in Supabase. Runs as a GitHub Actions cron job.

This is a companion repo to [PoeStash](https://www.poestash.com) — separated because the trade API blocks AWS/Vercel IPs but works from GitHub Actions (Azure).

## How it works

1. Reads combo definitions from `cluster_jewel_prices` table (pre-populated by the main app)
2. For each combo, searches the PoE trade API for the cheapest available listing
3. Updates the row with `min_price_chaos`, `listing_count`, and `last_refreshed_at`
4. Paces at 1 request per 10s to stay under trade API rate limits (30/300s)

## Schedule

- **06:00 UTC** — Full pass: all ~5,365 combos (~15h)
- **18:00 UTC** — Quick pass: only combos with listings (~1.5-2h)

Can also be triggered manually from the Actions tab.

## Setup

Add these as GitHub repository secrets:
- `DATABASE_URL` — Supabase PostgreSQL connection string
- `POE_CLIENT_ID` — PoE OAuth client ID (e.g., `poestashapp`)

## Local usage

```bash
cp .env.example .env  # fill in DATABASE_URL and POE_CLIENT_ID
npm install
npm run refresh           # full pass
npm run refresh:quick     # quick pass (listings only)
```
