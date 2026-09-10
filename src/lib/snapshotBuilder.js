"use strict";

/**
 * snapshotBuilder.js
 * ------------------------------------------------------------------
 * Merges DexScreener, Birdeye, Helius RPC, and RugCheck responses 
 * into a normalized TokenSnapshot covering all 12 tracked metrics 
 * with fault-tolerant fallbacks.
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
    getHeliusAssetInfo(tokenAddress, keys.heliusApiKey, keys.rpcUrl).catch(() => null),
    getRugCheckReport(tokenAddress).catch(() => null),
  ]);

  const pair = pickBestPair(pairs);

  // Parse top holders safely from RugCheck report if available
  const topHolders = rugCheck?.topHolders ?? [];
  const insiderHoldings = topHolders
    .filter(h => h.insider || h.owner === rugCheck?.creator)
    .reduce((sum, h) => sum + Number(h.pct || 0), 0);

  // Fallback checks for bundle detection across risk flags or explicit properties
  const risks = Array.isArray(rugCheck?.risks) ? rugCheck.risks : [];
  const hasBundleRisk = risks.some(r => r?.name?.toLowerCase().includes("bundle") || r?.description?.toLowerCase().includes("bundle"));
  const bundleDetected = rugCheck?.bundler ? true : (hasBundleRisk ? "Detected" : null);

  const snapshot = {
    tokenAddress,
    name: pair?.baseToken?.name ?? helius?.content?.metadata?.name ?? null,
    symbol: pair?.baseToken?.symbol ?? helius?.content?.metadata?.symbol ?? null,
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
    uniqueWallets: birdeyeHolders?.total ?? birdeyeHolders?.items?.length ?? null,
    bundleData: bundleDetected,
    devHoldingsPct: rugCheck?.creatorBalancePct ?? rugCheck?.creatorPercentage ?? null,
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
