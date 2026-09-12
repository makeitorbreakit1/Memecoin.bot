console.log("🚀 Loading V6 apiClient.js");
"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HELIUS_MIN_INTERVAL_MS = Math.max(50, Number(process.env.HELIUS_MIN_INTERVAL_MS || 250));
const HELIUS_COOLDOWN_MS = Math.max(5000, Number(process.env.HELIUS_COOLDOWN_MS || 30000));
const HELIUS_HOLDER_MAX_PAGES = Math.max(1, Number(process.env.HELIUS_HOLDER_MAX_PAGES || 2));
const HELIUS_CACHE_MS = Math.max(10000, Number(process.env.HELIUS_CACHE_MS || 120000));

let heliusNextAllowedAt = 0;
let heliusCooldownUntil = 0;
let heliusQueue = Promise.resolve();
let lastHelius429LogAt = 0;
const heliusCache = new Map();

function isHeliusUrl(url) {
  try { return new URL(url).hostname.endsWith("helius-rpc.com"); }
  catch (_) { return false; }
}

function cacheGet(key) {
  const item = heliusCache.get(key);
  if (!item) return undefined;
  if (Date.now() - item.timestamp > HELIUS_CACHE_MS) {
    heliusCache.delete(key);
    return undefined;
  }
  return item.value;
}

function cacheSet(key, value) {
  heliusCache.set(key, { timestamp: Date.now(), value });
  if (heliusCache.size > 500) {
    const first = heliusCache.keys().next().value;
    if (first) heliusCache.delete(first);
  }
}

function scheduleHelius(task) {
  const run = heliusQueue.then(async () => {
    const now = Date.now();
    if (now < heliusCooldownUntil) return { skipped: true, cooldown: true };
    const wait = Math.max(0, heliusNextAllowedAt - now);
    if (wait) await sleep(wait);
    heliusNextAllowedAt = Date.now() + HELIUS_MIN_INTERVAL_MS;
    return task();
  });
  heliusQueue = run.catch(() => {});
  return run;
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
      err.retryAfterMs = Number(res.headers.get("retry-after")) > 0
        ? Number(res.headers.get("retry-after")) * 1000
        : null;
      lastError = err;

      if (res.status === 429 && isHeliusUrl(url)) {
        heliusCooldownUntil = Date.now() + Math.max(HELIUS_COOLDOWN_MS, err.retryAfterMs || 0);
        if (Date.now() - lastHelius429LogAt > 5000) {
          console.warn(`[apiClient] Helius rate limited this bot. Pausing Helius requests for ${Math.ceil((heliusCooldownUntil - Date.now()) / 1000)}s.`);
          lastHelius429LogAt = Date.now();
        }
      }

      const retryable = res.status >= 500 || (res.status === 429 && !isHeliusUrl(url));
      if (!retryable || attempt >= retries) throw err;
      await sleep(err.retryAfterMs || 1000 * (attempt + 1));
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function heliusRequest(url, options, timeoutMs = 12000, cacheKey = null) {
  if (!url) return null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const result = await scheduleHelius(async () => {
    if (Date.now() < heliusCooldownUntil) return { skipped: true, cooldown: true };
    try {
      const value = await requestJson(url, options, timeoutMs, 0);
      if (cacheKey) cacheSet(cacheKey, value);
      return { value };
    } catch (err) {
      if (err.status === 429) return { skipped: true, cooldown: true, error: err };
      return { skipped: true, error: err };
    }
  });

  return result?.value ?? null;
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
    const type = String(x?.type || x?.platform || "").toLowerCase();
    const url = String(x?.url || "").toLowerCase();
    return type.includes("twitter") || type === "x" || type === "social:x" || url.includes("twitter.com") || url.includes("x.com");
  });
  const description = String(item?.description || "");
  const hasLaunchLanguage = /\b(launch|launched|launching|fair launch|stealth|live now|just dropped|just launched)\b/i.test(description);
  return {
    hasTwitter: socials.length > 0,
    hasWebsite: links.some((x) => String(x?.type || "").toLowerCase().includes("website")) || links.some((x) => /^https?:\/\//i.test(String(x?.url || "")) && !/twitter\.com|x\.com/i.test(String(x?.url || ""))),
    hasLaunchLanguage,
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
    const signalScore = (social.hasTwitter ? 35 : 0) + (social.hasWebsite ? 15 : 0) + (social.hasLaunchLanguage ? 25 : 0) + (item?.amount ? 10 : 0);
    result.push({ tokenAddress: item.tokenAddress, signalScore, social, sourceItem: item });
  }
  return result.sort((a, b) => b.signalScore - a.signalScore).slice(0, 40);
}

function birdeyeHeaders(apiKey) {
  return { Accept: "application/json", "X-API-KEY": apiKey, "x-chain": "solana" };
}

async function getBirdeyeOverview(address, apiKey) {
  if (!apiKey) return null;
  try {
    const x = await requestJson(`${BIRDEYE_BASE}/defi/token_overview?address=${encodeURIComponent(address)}`, { headers: birdeyeHeaders(apiKey) }, 10000, 0);
    return x?.data ?? null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Birdeye overview failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getBirdeyeSecurity(address, apiKey) {
  if (!apiKey) return null;
  try {
    const x = await requestJson(`${BIRDEYE_BASE}/defi/token_security?address=${encodeURIComponent(address)}`, { headers: birdeyeHeaders(apiKey) }, 10000, 0);
    return x?.data ?? null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Birdeye security failed for ${address}: ${err.message}`);
    return null;
  }
}

// V6: use DexScreener's chain-agnostic token endpoint for on-demand radar.
// This is what allows /radar to work for Ethereum, Base, BSC, Arbitrum, etc.
async function getDexTokenPairs(address, chainId = null) {
  const data = await requestJson(`${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`, {}, 10000, 1);
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  return chainId ? pairs.filter((p) => p?.chainId === chainId) : pairs;
}

async function getDexPairs(address) {
  return getDexTokenPairs(address, "solana");
}

async function getDexTokenData(address) {
  return getDexTokenPairs(address, "solana");
}

async function rpcCall(rpcUrl, method, params = []) {
  if (!rpcUrl) return null;
  const body = {
    jsonrpc: "2.0",
    id: `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  };
  try {
    if (isHeliusUrl(rpcUrl)) {
      const x = await heliusRequest(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 12000, `rpc:${rpcUrl}:${method}:${JSON.stringify(params)}`);
      return x?.result ?? null;
    }
    return await requestJson(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 12000, 0).then((x) => x?.result ?? null);
  } catch (_) {
    return null;
  }
}

async function getHeliusAsset(address, heliusApiKey) {
  if (!heliusApiKey) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  try {
    const x = await heliusRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `asset-${address}`, method: "getAsset", params: { id: address, options: { showFungible: true } } }),
    }, 12000, `asset:${address}`);
    return x?.result ?? null;
  } catch (err) {
    if (err.status !== 410 && err.status !== 429) console.warn(`[apiClient] Helius getAsset failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getHeliusHolderCount(address, heliusApiKey) {
  if (!heliusApiKey) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  const owners = new Set();
  try {
    for (let page = 1; page <= HELIUS_HOLDER_MAX_PAGES; page++) {
      const x = await heliusRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `holder-count-${address}-${page}`,
          method: "getTokenAccounts",
          params: { page, limit: 1000, displayOptions: {}, mint: address },
        }),
      }, 15000, `holderCount:${address}:${page}`);
      if (!x) break;
      const accounts = x?.result?.token_accounts ?? x?.result?.tokenAccounts ?? [];
      if (!Array.isArray(accounts) || accounts.length === 0) break;
      for (const account of accounts) {
        const owner = account?.owner;
        if (!owner) continue;
        const raw = account?.amount ?? account?.token_amount?.amount ?? account?.tokenAmount?.amount;
        if (raw != null && Number.isFinite(Number(raw)) && Number(raw) <= 0) continue;
        owners.add(owner);
      }
      if (accounts.length < 1000) break;
    }
    return owners.size || null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Helius holder count failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getHeliusTokenAccounts(address, heliusApiKey, maxPages = HELIUS_HOLDER_MAX_PAGES) {
  if (!heliusApiKey) return [];
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const x = await heliusRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `holder-detail-${address}-${page}`,
        method: "getTokenAccounts",
        params: { page, limit: 1000, displayOptions: {}, mint: address },
      }),
    }, 15000, `holderAccounts:${address}:${page}`);
    if (!x) break;
    const accounts = x?.result?.token_accounts ?? x?.result?.tokenAccounts ?? [];
    if (!Array.isArray(accounts) || accounts.length === 0) break;
    all.push(...accounts);
    if (accounts.length < 1000) break;
  }
  return all;
}

async function getHeliusCreatorWallet(address, heliusApiKey, rpcUrl) {
  const url = rpcUrl || (heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}` : null);
  if (!url) return null;
  try {
    const sigs = await rpcCall(url, "getSignaturesForAddress", [address, { limit: 100, commitment: "confirmed" }]);
    if (!Array.isArray(sigs) || !sigs.length) return null;
    const oldest = sigs[sigs.length - 1]?.signature;
    if (!oldest) return null;
    const tx = await rpcCall(url, "getTransaction", [oldest, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const keys = tx?.transaction?.message?.accountKeys;
    if (!Array.isArray(keys)) return null;
    return keys.find((k) => k?.signer === true)?.pubkey || null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Creator wallet lookup failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getRugCheckReport(address, apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
    if (/^eyJ/.test(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  }
  for (const suffix of ["/report/summary", "/report"]) {
    try {
      return await requestJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`, { headers }, 12000, 0);
    } catch (err) {
      if (err.status === 401 && apiKey) {
        try { return await requestJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`, { Accept: "application/json" }, 12000, 0); }
        catch (_) {}
      }
      if (err.status !== 401 && err.status !== 404) console.warn(`[apiClient] RugCheck report failed for ${address}: ${err.message}`);
    }
  }
  return null;
}

module.exports = {
  requestJson,
  discoverNewTokens,
  discoverEarlyLaunchSignals,
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getDexPairs,
  getDexTokenData,
  getDexTokenPairs,
  rpcCall,
  getHeliusAsset,
  getHeliusHolderCount,
  getHeliusTokenAccounts,
  getHeliusCreatorWallet,
  getRugCheckReport,
};
