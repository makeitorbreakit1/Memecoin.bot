"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(url, options = {}, timeoutMs = 12000, retries = 1) {
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

      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).hostname}`);
      err.status = res.status;
      err.body = body;
      lastError = err;

      if (!retryable || attempt >= retries) throw err;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
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

function birdeyeHeaders(apiKey) {
  return { Accept: "application/json", "X-API-KEY": apiKey, "x-chain": "solana" };
}

async function getBirdeyeOverview(address, apiKey) {
  if (!apiKey) return null;
  try {
    const x = await requestJson(`${BIRDEYE_BASE}/defi/token_overview?address=${encodeURIComponent(address)}`, { headers: birdeyeHeaders(apiKey) }, 10000, 1);
    return x?.data ?? null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Birdeye overview failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getBirdeyeSecurity(address, apiKey) {
  if (!apiKey) return null;
  try {
    const x = await requestJson(`${BIRDEYE_BASE}/defi/token_security?address=${encodeURIComponent(address)}`, { headers: birdeyeHeaders(apiKey) }, 10000, 1);
    return x?.data ?? null;
  } catch (err) {
    if (err.status !== 429) console.warn(`[apiClient] Birdeye security failed for ${address}: ${err.message}`);
    return null;
  }
}

async function getDexPairs(address) {
  const data = await requestJson(`${DEX_BASE}/token-pairs/v1/solana/${encodeURIComponent(address)}`, {}, 10000, 1);
  return Array.isArray(data) ? data : [];
}

async function getDexTokenData(address) {
  const data = await requestJson(`${DEX_BASE}/tokens/v1/solana/${encodeURIComponent(address)}`, {}, 10000, 1);
  return Array.isArray(data) ? data : [];
}

async function rpcCall(rpcUrl, method, params = []) {
  if (!rpcUrl) return null;
  try {
    return await requestJson(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    }, 12000, 1).then((x) => x?.result ?? null);
  } catch (_) {
    return null;
  }
}

async function getHeliusAsset(address, heliusApiKey) {
  if (!heliusApiKey) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  try {
    return await requestJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "getAsset",
        params: { id: address, options: { showFungible: true } },
      }),
    }, 12000, 1).then((x) => x?.result ?? null);
  } catch (err) {
    if (err.status !== 410) console.warn(`[apiClient] Helius getAsset failed for ${address}: ${err.message}`);
    return null;
  }
}


/* ================================================================
   HELIUS TOKEN ACCOUNTS / UNIQUE HOLDER COUNT
   ================================================================ */

async function getHeliusHolderCount(address, heliusApiKey) {
  if (!heliusApiKey) return null;

  const url =
    `https://mainnet.helius-rpc.com/?api-key=` +
    encodeURIComponent(heliusApiKey);

  const owners = new Set();
  let page = 1;
  const MAX_PAGES = 100;

  try {
    while (page <= MAX_PAGES) {
      const response = await requestJson(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `holder-count-${address}-${page}`,
            method: "getTokenAccounts",
            params: {
              page,
              limit: 1000,
              displayOptions: {},
              mint: address,
            },
          }),
        },
        15000,
        1
      );

      const tokenAccounts =
        response?.result?.token_accounts ??
        response?.result?.tokenAccounts ??
        [];

      if (!Array.isArray(tokenAccounts) || tokenAccounts.length === 0) break;

      for (const account of tokenAccounts) {
        const owner = account?.owner;
        if (!owner) continue;

        const rawAmount =
          account?.amount ??
          account?.token_amount?.amount ??
          account?.tokenAmount?.amount;

        // Count the owner unless the account explicitly reports zero tokens.
        if (rawAmount != null) {
          const amount = Number(rawAmount);
          if (Number.isFinite(amount) && amount <= 0) continue;
        }

        owners.add(owner);
      }

      if (tokenAccounts.length < 1000) break;
      page++;
    }

    return owners.size;
  } catch (err) {
    console.warn(
      `[apiClient] Helius holder count failed for ${address}: ${err.message}`
    );
    return null;
  }
}

async function getRugCheckReport(address, apiKey) {
  const headers = { Accept: "application/json" };
  // RugCheck's current public token report is commonly accessible without a key.
  // If a key is supplied, support both API-key and bearer/JWT style credentials.
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
    if (/^eyJ/.test(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  }

  for (const suffix of ["/report/summary", "/report"]) {
    try {
      return await requestJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`, { headers }, 12000, 1);
    } catch (err) {
      if (err.status === 401 && apiKey) {
        // A bad/stale optional key should not prevent the public report fallback.
        delete headers["X-API-KEY"];
        delete headers.Authorization;
        try {
          return await requestJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}${suffix}`, { Accept: "application/json" }, 12000, 1);
        } catch (_) {}
      }
      if (err.status !== 401 && err.status !== 404) {
        console.warn(`[apiClient] RugCheck report failed for ${address}: ${err.message}`);
      }
    }
  }
  return null;
}

module.exports = {
  requestJson,
  discoverNewTokens,
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getDexPairs,
  getDexTokenData,
  rpcCall,
  getHeliusAsset,
  getHeliusHolderCount,
  getRugCheckReport,
};
