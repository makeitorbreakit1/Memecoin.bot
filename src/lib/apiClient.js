"use strict";

/**
 * apiClient.js
 * ------------------------------------------------------------------
 * Thin wrappers around external data sources used to build a
 * TokenSnapshot. Each function degrades gracefully: on failure or
 * missing fields it returns `null` for that field rather than
 * throwing, so the scoring engine can track "missing data" instead
 * of the whole pipeline crashing.
 * ------------------------------------------------------------------
 */

const fetch = require("node-fetch");

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const HELIUS_BASE = "https://api.helius.xyz/v0";

const DEFAULT_TIMEOUT_MS = 8000;

/** Wrap fetch with a timeout so a hung request can't stall the poll loop. */
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

/** Simple retry wrapper for transient network/5xx/429 failures. */
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

/**
 * DexScreener: no API key required. Good primary source for
 * pair-level price/liquidity/volume/txn data on Solana.
 */
async function getDexScreenerPairs(tokenAddress) {
  return withRetry(async () => {
    const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new HttpError(`DexScreener ${res.status}`, res.status);
    const data = await res.json();
    return Array.isArray(data?.pairs) ? data.pairs : [];
  });
}

/**
 * Birdeye: requires BIRDEYE_API_KEY. Used for token overview
 * (market cap, holders where available) to cross-check DexScreener.
 */
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

/**
 * Helius: requires HELIUS_API_KEY. Used to discover newly created
 * mints (e.g. via getAsset / recent mint list) and, where available,
 * holder counts. This function is intentionally a thin example —
 * swap in your preferred Helius endpoint (webhooks, DAS API, etc.)
 * for production-grade new-mint discovery.
 */
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

/**
 * Discover freshly created Pump.fun-style tokens via DexScreener's
 * token-profiles / latest-boosted search endpoints, filtered by age.
 * This is a pragmatic discovery source that requires no API key.
 * For higher-throughput discovery, replace with a Helius webhook
 * that pushes new mint events to a queue.
 */
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

module.exports = {
  getDexScreenerPairs,
  getBirdeyeOverview,
  getHeliusAssetInfo,
  discoverNewTokens,
  HttpError,
};
