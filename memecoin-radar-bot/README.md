# Memecoin Radar Bot

A Discord bot that watches newly launched Solana/Pump.fun-style tokens, computes
on-chain strength ratios, runs a transparent rule-based scoring engine, and
posts a formatted "radar" breakdown embed to a channel — plus an on-demand
`/radar <address>` slash command.

**This is a structural data screen, not financial advice or a rug/scam
detector.** It surfaces liquidity, volume, and flow ratios and is explicit
about what it could *not* verify (holders, dev/insider wallets, bundle
detection). Treat every alert as a starting point for your own research, not
a signal to act on.

---

## Project layout

```
memecoin-radar-bot/
├── package.json
├── .env.example
└── src/
    ├── index.js              # Discord client, slash command, poll loop wiring
    └── lib/
        ├── apiClient.js       # DexScreener / Birdeye / Helius HTTP wrappers + retry/timeout
        ├── snapshotBuilder.js # Merges API responses into one TokenSnapshot, tracks missing fields
        ├── scoringEngine.js   # Pure rule-based scoring (no I/O) — ratios, reasons, confidence
        ├── messageFormatter.js# Builds the Discord embed layout
        └── watchlist.js       # Discovery + poll loop + dedupe + alert dispatch
```

---

## 1. Create the Discord bot application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Under **Bot**, click **Add Bot**, then **Reset Token** and copy it — this is your `DISCORD_TOKEN`. Keep it secret; anyone with it can control the bot.
3. Still under **Bot**, you do **not** need Message Content, Server Members, or Presence intents for this bot — it only sends messages and responds to slash commands. Leave privileged intents off unless you extend the bot later.
4. Under **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`, `Use Slash Commands`
   - Open the generated URL and invite the bot to your server.
5. Enable Developer Mode in Discord (User Settings → Advanced), right-click the target channel → **Copy Channel ID** → this is your `CHANNEL_ID`.

## 2. Get data-source API keys

- **DexScreener** — no key required; used as the primary pair/price/liquidity/volume source and for new-token discovery.
- **Birdeye** (optional but recommended) — sign up at https://docs.birdeye.so for an API key. Improves market cap accuracy and adds holder counts where available.
- **Helius** (optional) — sign up at https://www.helius.dev for an API key. The included `getHeliusAssetInfo` call is a starting point; for serious new-mint discovery at scale, replace the DexScreener-based `discoverNewTokens()` in `apiClient.js` with a Helius webhook or the DAS API pushing mint events into a queue.

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal |
| `CHANNEL_ID` | ✅ | Channel to post radar alerts into |
| `PING_ROLE_ID` | optional | Role to `@mention` on score ≥ 70 alerts |
| `BIRDEYE_API_KEY` | optional | Improves MC accuracy / adds holders |
| `HELIUS_API_KEY` | optional | Enables Helius metadata lookups |
| `POLL_INTERVAL_MS` | optional (default 30000) | How often to re-scan for new tokens |
| `MIN_TOKEN_AGE_SECONDS` | optional (default 60) | Skip tokens younger than this (avoid instant-rug noise) |
| `MAX_TOKEN_AGE_SECONDS` | optional (default 21600) | Skip tokens older than this (~6h — no longer "new launch") |
| `MIN_SCORE_TO_ALERT` | optional (default 55) | Minimum radar score (0–100) to post an alert |

## 4. Install & run

```bash
npm install
npm start
```

For local iteration with auto-restart on file changes:

```bash
npm run dev
```

On startup the bot logs in, registers the `/radar` slash command, and starts
polling on the configured interval. Use `Ctrl+C` to shut down cleanly (it
stops the poll loop and logs out before exiting).

---

## How the scoring engine works

`scoringEngine.js` is pure (no network calls) so the rules are easy to read,
test, and tune independently of the API layer. For each snapshot it computes:

- **Liquidity/MC ratio** — flags both healthy (≥8%) and thin (≤3%) liquidity relative to market cap.
- **Volume/MC multiplier** — flags "hot" 24h volume (≥1.5x market cap).
- **Buy share** — `buys / totalTrades`; flags strong buy pressure (≥55%) or sell-heavy flow (≤40%).
- **MC zone** — descriptive "prime" / "secondary" / "sub-prime" / "extended" label based on market-cap bands (tune in `THRESHOLDS`).
- **Age** — flags "very early" tokens (≤15 min old).
- **Price acceleration** — flags a ≥15% 5-minute price move.
- **Trade count floor** — penalizes very low total trade counts as a basic activity sanity check.

Each rule pushes a signed score delta and a human-readable reason string;
the final score is clamped to 0–100. **Verification confidence** is a
separate, honest measure: the percentage of tracked fields (holders, unique
wallets, bundle data, dev/insider holdings, etc.) that were actually resolved
from a live source. Fields that couldn't be resolved are listed explicitly
in the embed rather than silently omitted or assumed benign — that's the
intent behind the disclaimer that missing data doesn't confirm *or* deny
legitimacy.

All thresholds live in `THRESHOLDS` at the top of `scoringEngine.js` — adjust
freely as you tune false-positive/false-negative rates against your own
market observations.

### Extending holder / bundle / dev-wallet detection

`holders`, `uniqueWallets`, `bundleData`, `devHoldingsPct`, and
`insiderHoldingsPct` are left `null` in `snapshotBuilder.js` because they
require deeper on-chain analysis than a single lightweight endpoint
provides (e.g., walking the holder list, clustering wallets funded from a
common source, or tracing the deployer wallet's other launches). Wire in:

- A holders endpoint (Birdeye `/defi/token_holder`, Helius DAS `getTokenAccounts`) for `holders` / `uniqueWallets`.
- A custom heuristic (e.g., wallets funded within N seconds of each other from the same source, holding near-identical amounts) for `bundleData`.
- Deployer/dev wallet tracing via Helius transaction history for `devHoldingsPct` / `insiderHoldingsPct`.

Add the resolved value to the snapshot object and remove it from
`missingFields` in `snapshotBuilder.js` — the scoring engine and formatter
will pick it up automatically since `verificationConfidencePct` is derived
from `TRACKED_FIELDS` vs. `missingFields`.

---

## Error handling & resilience

- All external HTTP calls go through `fetchWithTimeout` (8s abort) and
  `withRetry` (exponential backoff, extra delay on HTTP 429) in `apiClient.js`.
- Per-source failures (Birdeye, Helius) are caught and logged individually —
  a failing optional source degrades that snapshot's data completeness
  rather than crashing the poll cycle.
- `watchlist.js` uses `p-limit` to cap concurrent snapshot builds (default 5)
  so a burst of new tokens doesn't hammer the APIs at once.
- `index.js` attaches `unhandledRejection` / `uncaughtException` handlers and
  logs Discord gateway disconnect/reconnect events so the process keeps
  running through transient network issues instead of crashing silently.
- `SIGINT` (Ctrl+C) stops the poll loop and destroys the Discord client
  cleanly before exiting.

---

## Notes & limitations

- The default `discoverNewTokens()` in `apiClient.js` uses DexScreener's
  token-profiles endpoint as a no-key discovery source. It's a reasonable
  starting point but not a firehose of every Pump.fun mint — for
  higher-throughput discovery, replace it with a Helius webhook subscribed
  to your program(s) of interest.
- In-memory dedupe (`alertedMints`) resets on process restart. Swap in
  SQLite/Redis if you need alerts deduped across restarts.
- This tool does not execute trades and holds no wallet keys — it's
  read-only analytics and alerting.
