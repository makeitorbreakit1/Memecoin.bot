"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";

async function requestJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).hostname}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverNewTokens() {
  const [profiles, boosts] = await Promise.all([
    requestJson(`${DEX_BASE}/token-profiles/latest/v1`).catch(() => []),
    requestJson(`${DEX_BASE}/token-boosts/latest/v1`).catch(() => []),
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
  return {
    Accept: "application/json",
    "X-API-KEY": apiKey,
    "x-chain": "solana",
  };
}

async function getBirdeyeOverview(address, apiKey) {
  if (!apiKey) return null;
  return requestJson(`${BIRDEYE_BASE}/defi/token_overview?address=${encodeURIComponent(address)}`, {
    headers: birdeyeHeaders(apiKey),
  }).then((x) => x?.data ?? null).catch(() => null);
}

async function getBirdeyeSecurity(address, apiKey) {
  if (!apiKey) return null;
  return requestJson(`${BIRDEYE_BASE}/defi/token_security?address=${encodeURIComponent(address)}`, {
    headers: birdeyeHeaders(apiKey),
  }).then((x) => x?.data ?? null).catch(() => null);
}

async function getBirdeyePrice(address, apiKey) {
  if (!apiKey) return null;
  return requestJson(`${BIRDEYE_BASE}/defi/price?address=${encodeURIComponent(address)}`, {
    headers: birdeyeHeaders(apiKey),
  }).then((x) => x?.data ?? null).catch(() => null);
}

async function getDexPairs(address) {
  const data = await requestJson(`${DEX_BASE}/token-pairs/v1/solana/${encodeURIComponent(address)}`);
  return Array.isArray(data) ? data : [];
}

async function getDexTokenData(address) {
  const data = await requestJson(`${DEX_BASE}/tokens/v1/solana/${encodeURIComponent(address)}`);
  return Array.isArray(data) ? data : [];
}

async function rpcCall(rpcUrl, method, params = []) {
  if (!rpcUrl) return null;
  return requestJson(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  }).then((x) => x?.result ?? null).catch(() => null);
}

async function getRugCheckReport(address, apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  return requestJson(`${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(address)}/report`, { headers }).catch(() => null);
}

module.exports = {
  requestJson,
  discoverNewTokens,
  getBirdeyeOverview,
  getBirdeyeSecurity,
  getBirdeyePrice,
  getDexPairs,
  getDexTokenData,
  rpcCall,
  getRugCheckReport,
};
