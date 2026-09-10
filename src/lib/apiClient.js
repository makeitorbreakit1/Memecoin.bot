"use strict";

/**
 * apiClient.js
 * ------------------------------------------------------------------
 * Thin API wrappers for DexScreener, Birdeye, Solana RPC, and RugCheck.
 * Configured with proper auth headers and silent fallback controls.
 * ------------------------------------------------------------------
 */

const fetch = require("node-fetch");

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const BIRDEYE_BASE = "https://public-api.birdeye.so";

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function withSilentRetry(fn, { retries = 1, delayMs = 400 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) return null;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getDexScreenerPairs(tokenAddress) {
  const data = await withSilentRetry(async () => {
    const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return await res.json();
  });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

async function getBirdeyeOverview(tokenAddress, apiKey) {
  if (!apiKey) return null;
  return await withSilentRetry(async () => {
    const url = `${BIRDEYE_BASE}/defi/token_overview?address=${tokenAddress}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data ?? null;
  });
}

async function getBirdeyeHolderMetrics(tokenAddress, apiKey) {
  if (!apiKey) return null;
  return await withSilentRetry(async () => {
    const url = `${BIRDEYE_BASE}/defi/v3/token/holder-list?address=${tokenAddress}&limit=10`;
    const res = await fetchWithTimeout(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data ?? null;
  });
}

async function getHeliusAssetInfo(tokenAddress, apiKey, rpcUrl) {
  if (!rpcUrl) return null;
  return await withSilentRetry(async () => {
    const res = await fetchWithTimeout(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: tokenAddress },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.result ?? null;
  });
}

async function discoverNewTokens({ chainId = "solana" } = {}) {
  const data = await withSilentRetry(async () => {
    const url = `https://api.dexscreener.com/token-profiles/latest/v1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return await res.json();
  });
  const list = Array.isArray(data) ? data : [];
  return list.filter((t) => t.chainId === chainId).map((t) => t.tokenAddress);
}

async function getSolanaAccountInfoParsed(address, rpcUrl) {
  return await withSilentRetry(async () => {
    const res = await fetchWithTimeout(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "jsonParsed" }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.result?.value ?? null;
  });
}

async function getRugCheckReport(tokenAddress, apiKey) {
  return await withSilentRetry(async () => {
    const url = `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`;
    const headers = {};
    if (apiKey) {
      headers["X-API-KEY"] = apiKey; // Supports optional custom or free-tier keys safely
    }
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  });
}

module.exports = {
  getDexScreenerPairs,
  getBirdeyeOverview,
  getBirdeyeHolderMetrics,
  getHeliusAssetInfo,
  discoverNewTokens,
  getSolanaAccountInfoParsed,
  getRugCheckReport,
  HttpError,
};
