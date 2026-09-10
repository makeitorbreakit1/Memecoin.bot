"use strict";

/**
 * apiClient.js
 * ------------------------------------------------------------------
 * Thin wrappers around external data sources used to build a
 * TokenSnapshot. Includes fallbacks and timeout handling.
 * ------------------------------------------------------------------
 */

const fetch = require("node-fetch");

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const HELIUS_BASE = "https://api.helius.xyz/v0";

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
        await new Promise((r) => setTimeout(r, isRateLimited ? delay * 2 : delay));
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
      if (!res.ok) throw new HttpError(`Birdeye ${res.status}`, res.status);
      const data = await res.json();
      return data?.data ?? null;
    });
  } catch (err) {
    console.warn(`[apiClient] Birdeye overview failed for ${tokenAddress}: ${err.message}`);
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
      if (!res.ok) throw new HttpError(`Birdeye holders ${res.status}`, res.status);
      const data = await res.json();
      return data?.data ?? null;
    });
  } catch (err) {
    console.warn(`[apiClient] Birdeye holder metrics failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

async function getHeliusAssetInfo(tokenAddress, apiKey) {
  if (!apiKey) return null;
  try {
    return await withRetry(async () => {
      const url = `${HELIUS_BASE}/token-metadata?api-key=${apiKey}`;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mintAccounts: [tokenAddress], includeOffChain: true }),
      });
      if (!res.ok) throw new HttpError(`Helius ${res.status}`, res.status);
      const data = await res.json();
      return Array.isArray(data) ? data[0] ?? null : null;
    });
  } catch (err) {
    console.warn(`[apiClient] Helius metadata failed for ${tokenAddress}: ${err.message}`);
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
        const res = await fetchWithTimeout(url, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        if (!res.ok) throw new HttpError(`RugCheck ${res.status}`, res.status);
        return await res.json();
      },
      { retries: 1 }
    );
  } catch (err) {
    console.warn(`[apiClient] RugCheck report failed for ${tokenAddress}: ${err.message}`);
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
