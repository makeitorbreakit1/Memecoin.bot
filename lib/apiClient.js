"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helius Free tier currently allows 10 standard RPC requests/sec. We deliberately
// stay far below that limit and serialize every Helius request through one queue.
const HELIUS_RPC_INTERVAL_MS = Math.max(250, Number(process.env.HELIUS_RPC_INTERVAL_MS || 300));
const HELIUS_COOLDOWN_MS = Math.max(10000, Number(process.env.HELIUS_COOLDOWN_MS || 30000));
const HELIUS_CACHE_MS = Math.max(10000, Number(process.env.HELIUS_CACHE_MS || 120000));

let rpcNextAllowedAt = 0;
let rpcCooldownUntil = 0;
let rpcQueue = Promise.resolve();
let last429LogAt = 0;
const heliusCache = new Map();
const rugCheckCache = new Map();

function cacheGet(map, key, ttl) {
  const item = map.get(key);
  if (!item) return undefined;
  if (Date.now() - item.timestamp > ttl) {
    map.delete(key);
    return undefined;
  }
  return item.value;
}

function cacheSet(map, key, value, maxSize = 1000) {
  map.set(key, { timestamp: Date.now(), value });
  while (map.size > maxSize) map.delete(map.keys().next().value);
}

function isHeliusUrl(url) {
  try { return new URL(url).hostname.endsWith("helius-rpc.com"); }
  catch (_) { return false; }
}

function heliusRpcUrl(apiKey) {
  return apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`
    : null;
}

async function requestJson(url, options = {}, timeoutMs = 12000, retries = 0) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) {}

      if (res.ok) return body;

      const err = new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).hostname}`);
      err.status = res.status;
      err.body = body;
      const retryAfter = Number(res.headers.get("retry-after"));
      err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      lastError = err;

      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        const base = err.retryAfterMs || Math.min(30000, 1000 * Math.pow(2, attempt));
        await sleep(base * (0.75 + Math.random() * 0.5));
        continue;
      }
      throw err;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
      await sleep(500 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function scheduleHelius(task) {
  const run = rpcQueue.then(async () => {
    if (Date.now() < rpcCooldownUntil) return null;

    const wait = Math.max(0, rpcNextAllowedAt - Date.now());
    if (wait) await sleep(wait);
    rpcNextAllowedAt = Date.now() + HELIUS_RPC_INTERVAL_MS;

    try {
      return await task();
    } catch (err) {
      if (err.status === 429) {
        const pause = Math.max(HELIUS_COOLDOWN_MS, err.retryAfterMs || 0);
        rpcCooldownUntil = Date.now() + pause;
        if (Date.now() - last429LogAt > 10000) {
          console.warn(`[apiClient] Helius RPC rate limit hit. Pausing requests for ${Math.ceil(pause / 1000)}s.`);
          last429LogAt = Date.now();
        }
      }
      return null;
    }
  });

  rpcQueue = run.catch(() => null);
  return run;
}

async function rpcCall(rpcUrl, method, params = []) {
  if (!rpcUrl) return null;

  const body = {
    jsonrpc: "2.0",
    id: `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  };

  const cacheKey = `rpc:${rpcUrl}:${method}:${JSON.stringify(params)}`;
  const cached = cacheGet(heliusCache, cacheKey, HELIUS_CACHE_MS);
  if (cached !== undefined) return cached?.result ?? null;

  const doRequest = async () => {
    const response = await requestJson(
      rpcUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      12000,
      0
    );

    if (response?.error) {
      const err = new Error(response.error.message || "Solana RPC error");
      err.status = Number(response.error.code) === -32005 ? 429 : 400;
      throw err;
    }

    cacheSet(heliusCache, cacheKey, response);
    return response;
  };

  if (isHeliusUrl(rpcUrl)) {
    const response = await scheduleHelius(doRequest);
    return response?.result ?? null;
  }

  try {
    const response = await doRequest();
    return response?.result ?? null;
  } catch (_) {
    return null;
  }
}

async function discoverNewTokens() {
  const [profiles, boosts] = await Promise.all([
    requestJson(`${DEX_BASE}/token-profiles/latest/v1`, {}, 10000, 1).catch(() => []),
    requestJson(`${DEX_BASE}/token-boosts/latest/v1`, {}, 10000, 1).catch(() => []),
  ]);

  const seen = new Set();
  const result = [];
  for (const item of [...(Array.isArray(profiles) ? profiles : []), ...(Array.isArray(boosts) ? boosts : [])]) {
    if (item?.chainId !== "solana" || !item.tokenAddress || seen.has(item.tokenAddress)) continue;
    seen.add(item.tokenAddress);
    result.push(item.tokenAddress);
  }
  return result.slice(0, 40);
}

function extractSocialSignals(item) {
  const links = Array.isArray(item?.links) ? item.links : [];
  const socials = links.filter((x) => {
    const t = String(x?.type || x?.platform || "").toLowerCase();
    const u = String(x?.url || "").toLowerCase();
    return t.includes("twitter") || t === "x" || u.includes("twitter.com") || u.includes("x.com");
  });
  const description = String(item?.description || "");
  return {
    hasTwitter: socials.length > 0,
    hasWebsite: links.some((x) => String(x?.type || "").toLowerCase().includes("website")) ||
      links.some((x) => /^https?:\/\//i.test(String(x?.url || "")) && !/twitter\.com|x\.com/i.test(String(x?.url || ""))),
    hasLaunchLanguage: /\b(launch|launched|launching|fair launch|stealth|live now|just dropped|just launched)\b/i.test(description),
    twitterUrl: socials[0]?.url || null,
    description: description.slice(0, 500),
    source: "DexScreener public profile feed",
  };
}

async function discoverEarlyLaunchSignals() {
  const [profiles, boosts] = await Promise.all([
    requestJson(`${DEX_BASE}/token-profiles/latest/v1`, {}, 10000, 1).catch(() => []),
    requestJson(`${DEX_BASE}/token-boosts/latest/v1`, {}, 10000, 1).catch(() => []),
  ]);

  const seen = new Set();
  const result = [];
  for (const item of [...(Array.isArray(profiles) ? profiles : []), ...(Array.isArray(boosts) ? boosts : [])]) {
    if (item?.chainId !== "solana" || !item.tokenAddress || seen.has(item.tokenAddress)) continue;
    seen.add(item.tokenAddress);
    const social = extractSocialSignals(item);
    const signalScore = (social.hasTwitter ? 35 : 0) +
      (social.hasWebsite ? 15 : 0) +
      (social.hasLaunchLanguage ? 25 : 0) +
      (item?.amount ? 10 : 0);
    result.push({ tokenAddress: item.tokenAddress, signalScore, social, sourceItem: item });
  }
  return result.sort((a, b) => b.signalScore - a.signalScore).slice(0, 40);
}

async function getDexTokenPairs(address) {
  const data = await requestJson(
    `${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`,
    {},
    10000,
    1
  );
  return Array.isArray(data?.pairs) ? data.pairs.filter((p) => p?.chainId === "solana") : [];
}

async function getDexPairs(address) { return getDexTokenPairs(address); }
async function getDexTokenData(address) { return getDexTokenPairs(address); }

async function getRugCheckReport(address, apiKey) {
  const cacheKey = `rugcheck:${address}`;
  const cached = cacheGet(rugCheckCache, cacheKey, 60000);
  if (cached !== undefined) return cached;

  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
    if (/^eyJ/.test(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  }

  for (const suffix of ["/report/summary", "/report"]) {
    try {
      const result = await requestJson(
        `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`,
        { headers },
        12000,
        0
      );
      cacheSet(rugCheckCache, cacheKey, result, 500);
      return result;
    } catch (err) {
      if (err.status === 401 && apiKey) {
        try {
          const result = await requestJson(
            `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`,
            { Accept: "application/json" },
            12000,
            0
          );
          cacheSet(rugCheckCache, cacheKey, result, 500);
          return result;
        } catch (_) {}
      }
      if (err.status !== 401 && err.status !== 404) {
        console.warn(`[apiClient] RugCheck report failed for ${address}: ${err.message}`);
      }
    }
  }

  cacheSet(rugCheckCache, cacheKey, null, 500);
  return null;
}

module.exports = {
  requestJson,
  discoverNewTokens,
  discoverEarlyLaunchSignals,
  getDexPairs,
  getDexTokenData,
  getDexTokenPairs,
  rpcCall,
  getRugCheckReport,
  heliusRpcUrl,
};
