"use strict";

const {
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getBirdeyePrice,
  getDexPairs,
  getDexTokenData,
  rpcCall,
} = require("./apiClient");

const WSOL = "So11111111111111111111111111111111111111112";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function bestPair(pairs) {
  return [...pairs].sort((a, b) => (num(b?.liquidity?.usd) ?? -1) - (num(a?.liquidity?.usd) ?? -1))[0] || null;
}

async function buildSnapshot(address, opts = {}) {
  if (!address || typeof address !== "string") throw new Error("Invalid token address");

  const rpcUrl = opts.rpcUrl || (opts.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}` : null);

  const [pairs, dexTokenData, overview, security, price, supply, largest, mintAccount] = await Promise.all([
    getDexPairs(address).catch(() => []),
    getDexTokenData(address).catch(() => []),
    getBirdeyeOverview(address, opts.birdeyeApiKey),
    getBirdeyeSecurity(address, opts.birdeyeApiKey),
    getBirdeyePrice(address, opts.birdeyeApiKey),
    rpcCall(rpcUrl, "getTokenSupply", [address]),
    rpcCall(rpcUrl, "getTokenLargestAccounts", [address]),
    rpcCall(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]),
  ]);

  const pair = bestPair(pairs.length ? pairs : dexTokenData);
  if (!pair) throw new Error("No Solana DEX pair found");

  const pairCreatedAt = num(pair.pairCreatedAt);
  const tokenAgeSeconds = pairCreatedAt ? Math.max(0, Math.floor(Date.now() / 1000 - pairCreatedAt / 1000)) : null;
  const tx24 = pair.txns?.h24 || {};
  const tx1h = pair.txns?.h1 || {};
  const tx5m = pair.txns?.m5 || {};
  const vol24 = num(pair.volume?.h24) ?? num(overview?.v24hUSD) ?? null;
  const liquidityUsd = num(pair.liquidity?.usd) ?? num(overview?.liquidity) ?? null;
  const marketCap = num(pair.marketCap) ?? num(pair.fdv) ?? num(overview?.mc) ?? null;
  const priceUsd = num(pair.priceUsd) ?? num(price?.value) ?? null;

  const supplyValue = supply?.value;
  const largestAccounts = largest?.value?.accounts || [];
  const totalSupply = num(supplyValue?.uiAmountString ?? supplyValue?.uiAmount);
  let topHolderPct = null;
  if (totalSupply > 0 && largestAccounts.length) {
    const top = largestAccounts.slice(0, 10).reduce((sum, x) => sum + (num(x?.uiAmount) ?? num(x?.amount) / Math.pow(10, supplyValue?.decimals || 0)), 0);
    topHolderPct = Math.min(100, (top / totalSupply) * 100);
  }

  const parsedMint = mintAccount?.value?.data?.parsed?.info || {};
  const mintAuthority = parsedMint.mintAuthority ?? security?.mintAuthority ?? null;
  const freezeAuthority = parsedMint.freezeAuthority ?? security?.freezeAuthority ?? null;

  const holderCount = num(overview?.holder) ?? num(overview?.holders) ?? num(overview?.holderCount) ?? null;
  const decimals = num(supplyValue?.decimals) ?? num(overview?.decimals) ?? null;
  const buy24 = num(tx24.buys);
  const sell24 = num(tx24.sells);
  const buySellRatio24 = buy24 != null && sell24 != null ? buy24 / Math.max(1, sell24) : null;

  // Exactly 12 primary tracked metrics. Safety/metadata fields remain available separately.
  const metrics = {
    tokenAgeSeconds,
    liquidityUsd,
    marketCapUsd: marketCap,
    volume24hUsd: vol24,
    priceChange5mPct: num(pair.priceChange?.m5),
    priceChange1hPct: num(pair.priceChange?.h1),
    priceChange6hPct: num(pair.priceChange?.h6),
    priceChange24hPct: num(pair.priceChange?.h24),
    buys24h: buy24,
    sells24h: sell24,
    buySellRatio24,
    holderCount,
  };

  const missingMetricCount = Object.values(metrics).filter((v) => v == null).length;
  const verificationConfidencePct = Math.round(((12 - missingMetricCount) / 12) * 100);

  return {
    address,
    name: pair.baseToken?.name ?? overview?.name ?? "Unknown Token",
    symbol: pair.baseToken?.symbol ?? overview?.symbol ?? "UNKNOWN",
    chain: "solana",
    dexId: pair.dexId ?? null,
    pairAddress: pair.pairAddress ?? null,
    pairUrl: pair.url ?? null,
    priceUsd,
    liquidityUsd,
    liquidityUsd: liquidityUsd,
    marketCapUsd: marketCap,
    fdvUsd: num(pair.fdv),
    volume24hUsd: vol24,
    priceChange5mPct: metrics.priceChange5mPct,
    priceChange1hPct: metrics.priceChange1hPct,
    priceChange6hPct: metrics.priceChange6hPct,
    priceChange24hPct: metrics.priceChange24hPct,
    buys24h: buy24,
    sells24h: sell24,
    buySellRatio24,
    holderCount,
    topHolderPct,
    totalSupply,
    decimals,
    mintAuthority,
    freezeAuthority,
    liquidityLockedPct: num(security?.lpLockedPct) ?? num(security?.lpLockedPercentage) ?? null,
    securityScore: num(security?.score),
    tokenAgeSeconds,
    pairCreatedAt,
    verificationConfidencePct,
    missingMetricCount,
    metrics,
    dexPair: pair,
    birdeyeOverview: overview,
    birdeyeSecurity: security,
    rpcSupply: supplyValue ?? null,
  };
}

module.exports = { buildSnapshot, WSOL };
