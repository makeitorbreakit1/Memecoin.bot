"use strict";

const {
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getDexPairs,
  getDexTokenData,
  rpcCall,
  getHeliusAsset,
  getHeliusHolderCount,
} = require("./apiClient");

const WSOL = "So11111111111111111111111111111111111111112";
const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

function bestPair(pairs) {
  return [...pairs].sort((a, b) => (num(b?.liquidity?.usd) ?? -1) - (num(a?.liquidity?.usd) ?? -1))[0] || null;
}

async function buildSnapshot(address, opts = {}) {
  if (!address || typeof address !== "string") throw new Error("Invalid token address");
  const rpcUrl = opts.rpcUrl || (opts.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}` : null);

  // DexScreener supplies the core 12 metrics. Do NOT fire three Birdeye requests
  // for every candidate; that is what caused 429s on low-tier plans.
  const [pairs, dexTokenData, supply, largest, mintAccount, heliusAsset, heliusHolderCount] = await Promise.all([
    getDexPairs(address).catch(() => []),
    getDexTokenData(address).catch(() => []),
    rpcCall(rpcUrl, "getTokenSupply", [address]),
    rpcCall(rpcUrl, "getTokenLargestAccounts", [address]),
    rpcCall(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]),
    getHeliusAsset(address, opts.heliusApiKey),
    getHeliusHolderCount(address, opts.heliusApiKey),
  ]);

  const pair = bestPair(pairs.length ? pairs : dexTokenData);
  if (!pair) throw new Error("No Solana DEX pair found");

  const [overview, security] = await Promise.all([
    getBirdeyeOverview(address, opts.birdeyeApiKey),
    getBirdeyeSecurity(address, opts.birdeyeApiKey),
  ]);

  const pairCreatedAt = num(pair.pairCreatedAt);
  const tokenAgeSeconds = pairCreatedAt ? Math.max(0, Math.floor(Date.now() / 1000 - pairCreatedAt / 1000)) : null;
  const tx24 = pair.txns?.h24 || {};
  const supplyValue = supply?.value;
  const largestAccounts = largest?.value || [];
  const decimals = num(supplyValue?.decimals) ?? num(heliusAsset?.token_info?.decimals) ?? num(overview?.decimals);
  const totalSupply = num(supplyValue?.uiAmountString ?? supplyValue?.uiAmount) ?? (num(heliusAsset?.token_info?.supply) != null && decimals != null ? num(heliusAsset.token_info.supply) / Math.pow(10, decimals) : null);

  let topHolderPct = null;
  if (totalSupply > 0 && largestAccounts.length) {
    const top = largestAccounts.slice(0, 10).reduce((sum, x) => {
      const amount = num(x?.uiAmount) ?? (num(x?.amount) != null && decimals != null ? num(x.amount) / Math.pow(10, decimals) : 0);
      return sum + amount;
    }, 0);
    topHolderPct = Math.min(100, (top / totalSupply) * 100);
  }

  const parsedMint = mintAccount?.value?.data?.parsed?.info || {};
  const mintAuthority = parsedMint.mintAuthority ?? heliusAsset?.token_info?.mint_authority ?? security?.mintAuthority ?? null;
  const freezeAuthority = parsedMint.freezeAuthority ?? heliusAsset?.token_info?.freeze_authority ?? security?.freezeAuthority ?? null;
  const holderCount = num(heliusHolderCount) ?? num(overview?.holder) ?? num(overview?.holders) ?? num(overview?.holderCount) ?? null;
  const buy24 = num(tx24.buys);
  const sell24 = num(tx24.sells);
  const liquidityUsd = num(pair.liquidity?.usd);
  const marketCap = num(pair.marketCap) ?? num(pair.fdv);
  const vol24 = num(pair.volume?.h24);
  const buySellRatio24 = buy24 != null && sell24 != null ? buy24 / Math.max(1, sell24) : null;

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

  // Only mark authority data as available when we actually received a real
  // authority field from parsed mint data or an equivalent upstream source.
  // Do this BEFORE verification scoring so an empty `{}` cannot count as data.
  const parsedMintHasAuthorityFields =
    Object.prototype.hasOwnProperty.call(parsedMint, "mintAuthority") ||
    Object.prototype.hasOwnProperty.call(parsedMint, "freezeAuthority");
  const authorityDataAvailable =
    parsedMintHasAuthorityFields ||
    heliusAsset?.token_info?.mint_authority !== undefined ||
    heliusAsset?.token_info?.freeze_authority !== undefined ||
    security?.mintAuthority !== undefined ||
    security?.freezeAuthority !== undefined;

  // This is source/evidence coverage, not a claim that the token is safe.
  // Final verification is completed in watchlist.js after RugCheck + authority checks.
  let verificationConfidencePct = 0;
  if (pair && liquidityUsd != null && marketCap != null && vol24 != null) verificationConfidencePct += 30;
  if (heliusAsset) verificationConfidencePct += 15;
  if (heliusHolderCount != null) verificationConfidencePct += 15;
  if (totalSupply != null && topHolderPct != null) verificationConfidencePct += 10;
  if (authorityDataAvailable) verificationConfidencePct += 20;
  if (buy24 != null && sell24 != null) verificationConfidencePct += 10;
  verificationConfidencePct = Math.min(90, verificationConfidencePct);
  const missingMetricCount = Object.values(metrics).filter((v) => v == null).length;

  return {
    address,
    name: pair.baseToken?.name ?? overview?.name ?? heliusAsset?.content?.metadata?.name ?? "Unknown Token",
    symbol: pair.baseToken?.symbol ?? overview?.symbol ?? heliusAsset?.content?.metadata?.symbol ?? "UNKNOWN",
    chain: "solana",
    dexId: pair.dexId ?? null,
    pairAddress: pair.pairAddress ?? null,
    pairUrl: pair.url ?? null,
    priceUsd: num(pair.priceUsd),
    liquidityUsd,
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
    authorityDataAvailable,
    liquidityLockedPct: num(security?.lpLockedPct) ?? num(security?.lpLockedPercentage),
    securityScore: num(security?.score),
    tokenAgeSeconds,
    pairCreatedAt,
    verificationConfidencePct,
    missingMetricCount,
    metrics,
    dexPair: pair,
    birdeyeOverview: overview,
    birdeyeSecurity: security,
    heliusAsset,
    rpcSupply: supplyValue ?? null,
  };
}

module.exports = { buildSnapshot, WSOL };
