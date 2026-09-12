"use strict";

const {
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getDexTokenPairs,
  rpcCall,
  getHeliusAsset,
  getHeliusHolderCount,
} = require("./apiClient");

const WSOL = "So11111111111111111111111111111111111111112";
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function bestPair(pairs) {
  return [...pairs].sort((a, b) => (num(b?.liquidity?.usd) ?? -1) - (num(a?.liquidity?.usd) ?? -1))[0] || null;
}

function looksLikeSolanaAddress(address) {
  return SOLANA_ADDRESS_RE.test(address) && !/^0x[0-9a-f]{40}$/i.test(address);
}

async function buildSnapshot(address, opts = {}) {
  if (!address || typeof address !== "string") throw new Error("Invalid token address");
  address = address.trim();

  // V6 first asks DexScreener for the token across ALL supported chains.
  // This is the key change that makes on-demand radar multi-chain.
  const allPairs = await getDexTokenPairs(address);
  const pair = bestPair(allPairs);
  if (!pair) throw new Error("No DEX pair found for that token address");

  const chain = String(pair.chainId || "unknown").toLowerCase();
  const isSolana = chain === "solana";
  const rpcUrl = isSolana ? (opts.rpcUrl || (opts.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}` : null)) : null;

  let overview = null;
  let security = null;
  let supply = null;
  let largest = null;
  let mintAccount = null;
  let heliusAsset = null;
  let heliusHolderCount = null;

  if (isSolana) {
    // Keep Helius/RPC calls serialized by apiClient's V6 rate limiter.
    [supply, largest, mintAccount, heliusAsset, heliusHolderCount] = await Promise.all([
      rpcCall(rpcUrl, "getTokenSupply", [address]),
      rpcCall(rpcUrl, "getTokenLargestAccounts", [address]),
      rpcCall(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]),
      getHeliusAsset(address, opts.heliusApiKey),
      getHeliusHolderCount(address, opts.heliusApiKey),
    ]);
    [overview, security] = await Promise.all([
      getBirdeyeOverview(address, opts.birdeyeApiKey),
      getBirdeyeSecurity(address, opts.birdeyeApiKey),
    ]);
  }

  const pairCreatedAt = num(pair.pairCreatedAt);
  const tokenAgeSeconds = pairCreatedAt ? Math.max(0, Math.floor(Date.now() / 1000 - pairCreatedAt / 1000)) : null;
  const tx24 = pair.txns?.h24 || {};
  const supplyValue = supply?.value;
  const largestAccounts = largest?.value || [];
  const decimals = num(supplyValue?.decimals) ?? num(heliusAsset?.token_info?.decimals) ?? num(overview?.decimals) ?? num(pair.baseToken?.decimals);
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
  const mintAuthority = isSolana ? (parsedMint.mintAuthority ?? heliusAsset?.token_info?.mint_authority ?? security?.mintAuthority ?? null) : null;
  const freezeAuthority = isSolana ? (parsedMint.freezeAuthority ?? heliusAsset?.token_info?.freeze_authority ?? security?.freezeAuthority ?? null) : null;
  const holderCount = num(heliusHolderCount) ?? num(overview?.holder) ?? num(overview?.holders) ?? num(overview?.holderCount) ?? num(pair.baseToken?.holders) ?? null;
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

  const parsedMintHasAuthorityFields = Object.prototype.hasOwnProperty.call(parsedMint, "mintAuthority") || Object.prototype.hasOwnProperty.call(parsedMint, "freezeAuthority");
  const authorityDataAvailable = isSolana && (
    parsedMintHasAuthorityFields ||
    heliusAsset?.token_info?.mint_authority !== undefined ||
    heliusAsset?.token_info?.freeze_authority !== undefined ||
    security?.mintAuthority !== undefined ||
    security?.freezeAuthority !== undefined
  );

  let verificationConfidencePct = 0;
  if (pair && liquidityUsd != null && marketCap != null && vol24 != null) verificationConfidencePct += 45;
  if (isSolana && heliusAsset) verificationConfidencePct += 10;
  if (holderCount != null) verificationConfidencePct += 15;
  if (totalSupply != null && topHolderPct != null) verificationConfidencePct += 10;
  if (authorityDataAvailable) verificationConfidencePct += 10;
  if (buy24 != null && sell24 != null) verificationConfidencePct += 10;
  verificationConfidencePct = Math.min(100, verificationConfidencePct);

  return {
    address,
    name: pair.baseToken?.name ?? overview?.name ?? heliusAsset?.content?.metadata?.name ?? "Unknown Token",
    symbol: pair.baseToken?.symbol ?? overview?.symbol ?? heliusAsset?.content?.metadata?.symbol ?? "UNKNOWN",
    chain,
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
    missingMetricCount: Object.values(metrics).filter((v) => v == null).length,
    metrics,
    dexPair: pair,
    birdeyeOverview: overview,
    birdeyeSecurity: security,
    heliusAsset,
    rpcSupply: supplyValue ?? null,
    solanaEnhanced: isSolana,
  };
}

module.exports = { buildSnapshot, WSOL, looksLikeSolanaAddress };
