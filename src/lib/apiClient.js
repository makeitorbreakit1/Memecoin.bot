"use strict";

/**
 * apiClient.js
 * ------------------------------------------------------------------
 * Thin wrappers around external data sources used to build a
 * TokenSnapshot. Includes robust error handling for 410, 401, and 429.
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

async function withRetry(fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRateLimited = err?.status === 429;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, isRateLimited ? delay * 3 : delay));
      }
    }
  }
  throw lastErr;
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getDexScreenerPairs(tokenAddress) {
  return withRetry(async () => {
    const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new HttpError(`DexScreener ${res.status}`, res.status);
    const data = await res.json();
    return Array.isArray(data?.pairs) ? data.pairs : [];
  });
}

async function getBirdeyeOverview(tokenAddress, apiKey) {
  if (!apiKey) return null;
  try {
    return await withRetry(async () => {
      const url = `${BIRDEYE_BASE}/defi/token_overview?address=${tokenAddress}`;
      const res = await fetchWithTimeout(url, {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
        },
      });
      if (!res.ok) {
        if (res.status === 429) return null; // Silently bypass rate limits to keep logs clean
        throw new HttpError(`Birdeye ${res.status}`, res.status);
      }
      const data = await res.json();
      return data?.data ?? null;
    });
  } catch (err) {
    return null;
  }
}

async function getBirdeyeHolderMetrics(tokenAddress, apiKey) {
  if (!apiKey) return null;
  try {
    return await withRetry(async () => {
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
  } catch (err) {
    return null;
  }
}

async function getHeliusAssetInfo(tokenAddress, apiKey) {
  if (!apiKey) return null;
  try {
    return await withRetry(async () => {
      // Updated to use the Helius DAS endpoint structure to prevent 410 errors
      const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "my-id",
          method: "getAsset",
          params: { id: tokenAddress },
        }),
      });
      if (!res.ok) throw new HttpError(`Helius RPC ${res.status}`, res.status);
      const data = await res.json();
      return data?.result ?? null;
    });
  } catch (err) {
    return null;
  }
}

async function discoverNewTokens({ chainId = "solana" } = {}) {
  return withRetry(async () => {
    const url = `https://api.dexscreener.com/token-profiles/latest/v1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new HttpError(`DexScreener discovery ${res.status}`, res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    return list.filter((t) => t.chainId === chainId).map((t) => t.tokenAddress);
  });
}

async function getSolanaAccountInfoParsed(address, rpcUrl) {
  return withRetry(async () => {
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
    if (!res.ok) throw new HttpError(`Solana RPC ${res.status}`, res.status);
    const data = await res.json();
    if (data?.error) throw new HttpError(`Solana RPC error: ${data.error.message}`, 500);
    return data?.result?.value ?? null;
  });
}

async function getRugCheckReport(tokenAddress, apiKey) {
  try {
    return await withRetry(
      async () => {
        const url = `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`;
        const headers = {};
        // Only attach Authorization header if a valid key is actually provided
        if (apiKey && apiKey.trim() !== "") {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        const res = await fetchWithTimeout(url, { headers });
        if (!res.ok) return null; // Gracefully degrade if endpoint errors out
        return await res.json();
      },
      { retries: 1 }
    );
  } catch (err) {
    return null;
  }
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
