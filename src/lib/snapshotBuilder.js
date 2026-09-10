"use strict";

/**
 * snapshotBuilder.js
 * ------------------------------------------------------------------
 * Merges DexScreener, Birdeye, Helius, and RugCheck responses into one
 * normalized TokenSnapshot object covering all 12 tracked metrics.
 * ------------------------------------------------------------------
 */

const {
  getDexScreenerPairs,
  getBirdeyeOverview,
  getBirdeyeHolderMetrics,
  getHeliusAssetInfo,
  getRugCheckReport,
} = require("./apiClient");

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

async function buildSnapshot(tokenAddress, keys = {}) {
  const [pairs, birdeye, birdeyeHolders, helius, rugCheck] = await Promise.all([
    getDexScreenerPairs(tokenAddress).catch(() => []),
    getBirdeyeOverview(tokenAddress, keys.birdeyeApiKey),
    getBirdeyeHolderMetrics(tokenAddress, keys.birdeyeApiKey).catch(() => null),
    getHeliusAssetInfo(tokenAddress, keys.heliusApiKey),
    getRugCheckReport(tokenAddress, keys.rugcheckApiKey).catch(() => null),
  ]);

  const pair = pickBestPair(pairs);

  const topHolders = rugCheck?.topHolders ?? [];
  const insiderHoldings = topHolders
    .filter(h => h.insider || h.owner === rugCheck?.creator)
    .reduce((sum, h) => sum + Number(h.pct || 0), 0);

  const snapshot = {
    tokenAddress,
    name: pair?.baseToken?.name ?? helius?.onChainMetadata?.metadata?.data?.name ?? null,
    symbol: pair?.baseToken?.symbol ?? helius?.onChainMetadata?.metadata?.data?.symbol ?? null,
    dexUrl: pair?.url ?? null,
    priceUsd: pair?.priceUsd ? Number(pair.priceUsd) : null,

    marketCap: pair?.fdv ?? birdeye?.mc ?? rugCheck?.marketCap ?? null,
    liquidityUsd: pair?.liquidity?.usd ?? (rugCheck?.totalLPProviders ? Number(rugCheck.totalLPProviders) : null),
    volume24hUsd: pair?.volume?.h24 ?? birdeye?.v24hUSD ?? null,

    tokenAgeSeconds: ageSecondsFromPairCreatedAt(pair) ?? (rugCheck?.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(rugCheck.createdAt).getTime()) / 1000)) : null),

    buys: pair?.txns?.h24?.buys ?? null,
    sells: pair?.txns?.h24?.sells ?? null,
    totalTrades:
      pair?.txns?.h24?.buys != null && pair?.txns?.h24?.sells != null
        ? pair.txns.h24.buys + pair.txns.h24.sells
        : null,

    holders: birdeye?.holderCount ?? rugCheck?.holderCount ?? null,
    uniqueWallets: birdeyeHolders?.total ?? null,
    bundleData: rugCheck?.bundler ? true : (rugCheck?.risks?.some(r => r.name?.toLowerCase().includes("bundle")) ? "Detected" : null),
    devHoldingsPct: rugCheck?.creatorBalancePct ?? null,
    insiderHoldingsPct: insiderHoldings > 0 ? insiderHoldings : (rugCheck?.insiderPercentage ?? null),

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
