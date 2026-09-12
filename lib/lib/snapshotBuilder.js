"use strict";

const {
  getDexTokenPairs,
  rpcCall,
} = require("./apiClient");

const WSOL = "So11111111111111111111111111111111111111112";
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function bestPair(pairs) {
  return [...pairs].sort((a, b) =>
    (num(b?.liquidity?.usd) ?? -1) - (num(a?.liquidity?.usd) ?? -1)
  )[0] || null;
}

function looksLikeSolanaAddress(address) {
  return SOLANA_ADDRESS_RE.test(address) && !/^0x[0-9a-f]{40}$/i.test(address);
}

async function buildSnapshot(address, opts = {}) {
  if (!address || typeof address !== "string") throw new Error("Invalid token address");
  address = address.trim();

  // This bot is intentionally Solana-only. DexScreener is used for market data;
  // Helius standard RPC is used only for Solana on-chain data.
  const pairs = await getDexTokenPairs(address);
  const pair = bestPair(pairs);
  if (!pair) throw new Error("No Solana DEX pair found for that token mint");

  const rpcUrl = opts.enableHeliusRpc !== false
    ? (opts.rpcUrl || (opts.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}` : null))
    : null;

  let supply = null;
  let largest = null;
  let mintAccount = null;

  if (rpcUrl) {
    // These are standard Solana RPC calls. apiClient serializes them so they
    // cannot burst against Helius.
    supply = await rpcCall(rpcUrl, "getTokenSupply", [address]);
    largest = await rpcCall(rpcUrl, "getTokenLargestAccounts", [address]);
    mintAccount = await rpcCall(rpcUrl, "getAccountInfo", [
      address,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
  }

  const pairCreatedAt = num(pair.pairCreatedAt);
  const tokenAgeSeconds = pairCreatedAt
    ? Math.max(0, Math.floor(Date.now() / 1000 - pairCreatedAt / 1000))
    : null;

  const tx24 = pair.txns?.h24 || {};
  const supplyValue = supply?.value;
  const largestAccounts = largest?.value || [];
  const decimals = num(supplyValue?.decimals) ?? num(pair.baseToken?.decimals);
  const totalSupply = num(supplyValue?.uiAmountString ?? supplyValue?.uiAmount);

  let topHolderPct = null;
  if (totalSupply > 0 && largestAccounts.length) {
    const top = largestAccounts.slice(0, 10).reduce((sum, x) => {
      const amount = num(x?.uiAmount) ??
        (num(x?.amount) != null && decimals != null ? num(x.amount) / Math.pow(10, decimals) : 0);
      return sum + amount;
    }, 0);
    topHolderPct = Math.min(100, (top / totalSupply) * 100);
  }

  const parsedMint = mintAccount?.value?.data?.parsed?.info || {};
  const authorityDataAvailable = Object.prototype.hasOwnProperty.call(parsedMint, "mintAuthority") ||
    Object.prototype.hasOwnProperty.call(parsedMint, "freezeAuthority");

  const mintAuthority = parsedMint.mintAuthority ?? null;
  const freezeAuthority = parsedMint.freezeAuthority ?? null;
  const holderCount = null; // Detailed holder enumeration is intentionally disabled.

  const buy24 = num(tx24.buys);
  const sell24 = num(tx24.sells);
  const liquidityUsd = num(pair.liquidity?.usd);
  const marketCap = num(pair.marketCap) ?? num(pair.fdv);
  const vol24 = num(pair.volume?.h24);
  const buySellRatio24 = buy24 != null && sell24 != null
    ? buy24 / Math.max(1, sell24)
    : null;

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

  let verificationConfidencePct = 0;
  if (pair && liquidityUsd != null && marketCap != null && vol24 != null) verificationConfidencePct += 45;
  if (totalSupply != null && topHolderPct != null) verificationConfidencePct += 20;
  if (authorityDataAvailable) verificationConfidencePct += 20;
  if (buy24 != null && sell24 != null) verificationConfidencePct += 15;
  verificationConfidencePct = Math.min(100, verificationConfidencePct);

  return {
    address,
    name: pair.baseToken?.name ?? "Unknown Token",
    symbol: pair.baseToken?.symbol ?? "UNKNOWN",
    chain: "solana",
    dexId: pair.dexId ?? null,
    pairAddress: pair.pairAddress ?? null,
    pairUrl: pair.url ?? null,
    priceUsd: num(pair.priceUsd),
    liquidityUsd,
    marketCapUsd: marketCap,
    fdvUsd: num(pair.fdv),
    volume24hUsd: vol24,
    priceChange5mPct: num(pair.priceChange?.m5),
    priceChange1hPct: num(pair.priceChange?.h1),
    priceChange6hPct: num(pair.priceChange?.h6),
    priceChange24hPct: num(pair.priceChange?.h24),
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
    liquidityLockedPct: null,
    securityScore: null,
    tokenAgeSeconds,
    pairCreatedAt,
    verificationConfidencePct,
    missingMetricCount: Object.values(metrics).filter((v) => v == null).length,
    metrics,
    dexPair: pair,
    heliusAsset: null,
    rpcSupply: supplyValue ?? null,
    solanaEnhanced: true,
  };
}

module.exports = { buildSnapshot, WSOL, looksLikeSolanaAddress };
