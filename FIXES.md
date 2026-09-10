# Bug fixes — Robinhood discovery + null/0 holder confusion

## 1. Robinhood auto-discovery never found anything (critical)

`lib/robinhoodClient.js` → `discoverRobinhoodLaunches()` was calling two URLs
that do not exist on launchpad.meme:

- `https://launchpad.meme/token-list/robinhood.json`
- `https://launchpad.meme/api/public/tokens/new?chain=robinhood`

Verified against launchpad.meme's own published API docs
(`https://launchpad.meme/api/robinhood/docs`) and their live status endpoint
(`https://launchpad.meme/api/evm/robinhood/status`): the real API only exposes
per-token lookups (`GET /api/v1/robinhood/tokens/{address}`) and
launch-creation endpoints. There is no bulk "list new launches" feed.

Both guessed URLs 404 on every poll, the failure is caught silently, discovery
always returns `[]`, and `robinhoodWatchlist.pollOnce()` exits immediately
(`if (!launches.length) return;`) — so the automatic scanner never evaluates
a single Robinhood token, ever. Manual `/rh-radar <address>` and `/radar
<address>` still worked because they call `getRobinhoodTokenData()` directly
on the address you supply, bypassing discovery.

**Fix applied:** `discoverRobinhoodLaunches()` now pulls from DexScreener's
public `token-profiles/latest/v1` and `token-boosts/latest/v1` feeds, filtered
to `chainId === "robinhood"` (DexScreener does index Robinhood Chain under
that slug — confirmed live). This is the same discovery pattern already used
for Solana elsewhere in this project.

**Known limitation of the fix:** this only surfaces tokens that have a
submitted DexScreener profile or an active boost — not literally every
Robinhood Chain launch. For complete coverage, watch the launch factory
(`0xfb21934bb01b4d7b83beb8af6e6fd553f049e632`) directly via `eth_getLogs` on
`ROBINHOOD_RPC_URL` for its creation event. That's a larger change (needs the
factory's ABI/event signature) — flag if you want it built out.

## 2. `null` holder/holder-distribution data displayed as "0" / "unavailable" mismatch

`lib/robinhoodRisk.js`, `lib/robinhoodScoring.js`, and `lib/snapshotBuilder.js`
each had:

```js
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
```

`Number(null)` evaluates to `0` in JavaScript (not `NaN`), so `num(null)`
incorrectly returned `0` instead of `null`. Whenever holder count (or
top-10%, largest-holder%, etc.) was genuinely unresolved, this silently
turned it into `0`, causing the risk assessor to report **"Only 0 holders"**
as if that were a confirmed fact, while the embed's main stats (which read
the raw field directly) correctly showed "N/A" — the exact mismatch visible
in the screenshot.

**Fix applied:** all three `num()`/inline equivalents now check `v == null`
before calling `Number()`, so a genuinely missing value stays `null` and a
genuinely-zero value still reads as `0`. Verified with test fixtures: a
`null` holder count now reports "Holder count unavailable" / "Top-holder
distribution unavailable"; a real low count (e.g. 12) still correctly flags
"Only 12 holders".

This also affects `snapshotBuilder.js`'s `missingMetricCount` and
verification-confidence math on the **Solana** side — it was quietly
under-counting missing fields for the same reason.
