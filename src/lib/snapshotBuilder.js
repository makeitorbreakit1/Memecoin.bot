"use strict";

/**
 * snapshotBuilder.js
 * ------------------------------------------------------------------
 * Merges DexScreener / Birdeye / Helius responses into one
 * normalized TokenSnapshot object. Every field that could not be
 * resolved from any source is left as `null` and pushed onto
 * `missingFields` — the scoring engine uses that list to compute
 * "Verification confidence" and to print missing-data warnings.
 * ------------------------------------------------------------------
 */

const {
  getDexScreenerPairs,
  getBirdeyeOverview,
  getHeliusAssetInfo,
} = require("./apiClient");

// Fields we'd ideally have full confidence on. Anything not resolved
// from a live source gets flagged as missing.
const TRACKED_FIELDS = [
  "marketCap",
  "liquidityUsd",
  "volume24hUsd",
  "tokenAgeSeconds",
  "buys",
  "sells",
  "totalTrades",
  "holders",
  "uniqueWallets",
  "bundleData",
  "devHoldingsPct",
  "insiderHoldingsPct",
];

function pickBestPair(pairs) {
  if (!pairs || pairs.length === 0) return null;
  // Prefer the pair with the highest liquidity — usually the "real" market.
  return pairs.reduce((best, p) => {
    const liq = Number(p?.liquidity?.usd ?? 0);
    const bestLiq = Number(best?.liquidity?.usd ?? 0);
    return liq > bestLiq ? p : best;
  }, pairs[0]);
}

function ageSecondsFromPairCreatedAt(pair) {
  const createdAt = pair?.pairCreatedAt;
  if (!createdAt) return null;
  const createdMs = Number(createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
}

/**
 * Build a normalized snapshot for a single token address.
 * @param {string} tokenAddress
 * @param {{ birdeyeApiKey?: string, heliusApiKey?: string }} keys
 * @returns {Promise<object>} TokenSnapshot
 */
async function buildSnapshot(tokenAddress, keys = {}) {
  const [pairs, birdeye, helius] = await Promise.all([
    getDexScreenerPairs(tokenAddress).catch(() => []),
    getBirdeyeOverview(tokenAddress, keys.birdeyeApiKey),
    getHeliusAssetInfo(tokenAddress, keys.heliusApiKey),
  ]);

  const pair = pickBestPair(pairs);

  const snapshot = {
    tokenAddress,
    name: pair?.baseToken?.name ?? helius?.onChainMetadata?.metadata?.data?.name ?? null,
    symbol: pair?.baseToken?.symbol ?? helius?.onChainMetadata?.metadata?.data?.symbol ?? null,
    dexUrl: pair?.url ?? null,
    priceUsd: pair?.priceUsd ? Number(pair.priceUsd) : null,

    marketCap: pair?.fdv ?? birdeye?.mc ?? null,
    liquidityUsd: pair?.liquidity?.usd ?? null,
    volume24hUsd: pair?.volume?.h24 ?? birdeye?.v24hUSD ?? null,

    tokenAgeSeconds: ageSecondsFromPairCreatedAt(pair),

    buys: pair?.txns?.h24?.buys ?? null,
    sells: pair?.txns?.h24?.sells ?? null,
    totalTrades:
      pair?.txns?.h24?.buys != null && pair?.txns?.h24?.sells != null
        ? pair.txns.h24.buys + pair.txns.h24.sells
        : null,

    // These generally require deeper on-chain analysis (holder
    // snapshots, bundle detection heuristics, dev wallet tracing)
    // that isn't exposed by a single lightweight endpoint. Wire up
    // a holders API (e.g. Birdeye /defi/token_holder or Helius DAS)
    // here when available; left null otherwise so they show up as
    // "missing" rather than silently faked.
    holders: birdeye?.holder ?? null,
    uniqueWallets: null,
    bundleData: null,
    devHoldingsPct: null,
    insiderHoldingsPct: null,

    priceChange5m: pair?.priceChange?.m5 ?? null,
    priceChange1h: pair?.priceChange?.h1 ?? null,

    fetchedAt: Date.now(),
    missingFields: [],
  };

  snapshot.missingFields = TRACKED_FIELDS.filter(
    (field) => snapshot[field] === null || snapshot[field] === undefined
  );

  return snapshot;
}

module.exports = { buildSnapshot, TRACKED_FIELDS };
