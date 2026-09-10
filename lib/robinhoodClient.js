"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const LAUNCHPAD_BASE = "https://launchpad.meme";
const RH_RPC_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";
const BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com/api/v2";

const CHAIN_ID = 4663;
const FACTORY = "0xfb21934bb01b4d7b83beb8af6e6fd553f049e632".toLowerCase();
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();

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
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 700 * (attempt + 1));
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
      await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function arrFrom(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.tokens)) return body.tokens;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.result)) return body.result;
  return [];
}

function firstAddress(item) {
  return item?.tokenAddress || item?.address || item?.token_address || item?.contractAddress || item?.contract_address || null;
}

function normalizeLaunch(item) {
  const tokenAddress = firstAddress(item);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(tokenAddress || ""))) return null;
  const pools = Array.isArray(item?.pools) ? item.pools : (Array.isArray(item?.pairs) ? item.pairs : []);
  const pool = item?.poolAddress || item?.pairAddress || item?.pair_address || item?.pool?.address || pools[0]?.address || pools[0]?.poolAddress || null;
  const created = item?.createdAt || item?.created_at || item?.launchTimestamp || item?.launch_timestamp || item?.timestamp || item?.launchedAt || item?.launched_at;
  let createdAtMs = Number(created);
  if (Number.isFinite(createdAtMs) && createdAtMs > 0 && createdAtMs < 1e12) createdAtMs *= 1000;
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) createdAtMs = null;

  const links = Array.isArray(item?.links) ? item.links : [];
  const socials = Array.isArray(item?.socials) ? item.socials : [];
  const website = item?.website || links.find((x) => String(x?.type || "").toLowerCase().includes("website"))?.url || null;
  const twitter = item?.twitter || item?.x || links.find((x) => /twitter|x\.com/i.test(String(x?.url || "")))?.url || null;
  const telegram = item?.telegram || links.find((x) => /telegram/i.test(String(x?.url || "")))?.url || null;

  return {
    tokenAddress: String(tokenAddress),
    name: item?.name || item?.tokenName || item?.token?.name || "Unknown",
    symbol: item?.symbol || item?.tokenSymbol || item?.token?.symbol || "TOKEN",
    description: item?.description || item?.token?.description || "",
    poolAddress: pool,
    creator: item?.creator || item?.creatorAddress || item?.deployer || null,
    factory: String(item?.factory || item?.launchFactory || item?.factoryAddress || FACTORY).toLowerCase(),
    createdAtMs,
    website,
    twitter,
    telegram,
    icon: item?.icon || item?.logo || item?.image || item?.imageUrl || item?.image_url || null,
    raw: item,
  };
}

async function discoverRobinhoodLaunches() {
  // launchpad.meme's public API (verified against launchpad.meme/api/robinhood/docs
  // and the live /api/evm/robinhood/status endpoint) only exposes PER-TOKEN lookups
  // (GET /api/v1/robinhood/tokens/{address}) and launch-creation endpoints. There is
  // no bulk "list of new launches" feed — the previous /token-list/robinhood.json and
  // /api/public/tokens/new?chain=robinhood URLs here were guessed and do not exist,
  // which is why discovery always returned zero candidates.
  //
  // DexScreener does index Robinhood Chain under chainId "robinhood", so we reuse
  // their public profile/boost feeds instead — the same discovery pattern this
  // project already uses for Solana. This will not catch every Robinhood launch
  // (only tokens with a submitted DexScreener profile or an active boost show up
  // here), but it is a real, working feed rather than a URL that always 404s.
  // For complete coverage, watch the launch factory (FACTORY, above) directly via
  // eth_getLogs on ROBINHOOD_RPC_URL instead.
  const urls = [`${DEX_BASE}/token-profiles/latest/v1`, `${DEX_BASE}/token-boosts/latest/v1`];

  const seen = new Set();
  const result = [];
  for (const url of urls) {
    try {
      const body = await requestJson(url, { headers: { Accept: "application/json" } }, 10000, 1);
      const items = arrFrom(body).filter((item) => String(item?.chainId).toLowerCase() === "robinhood");
      for (const item of items) {
        const normalized = normalizeLaunch(item);
        if (!normalized) continue;
        const key = normalized.tokenAddress.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
      }
    } catch (err) {
      console.warn(`[robinhoodClient] DexScreener discovery feed failed (${url}): ${err.message}`);
    }
  }
  return result.slice(0, 100);
}

async function getDexPairs(address) {
  const data = await requestJson(`${DEX_BASE}/tokens/v1/robinhood/${encodeURIComponent(address)}`, {}, 10000, 1);
  return Array.isArray(data) ? data : [];
}

async function getDexPair(address) {
  const pairs = await getDexPairs(address).catch(() => []);
  const rh = pairs.filter((p) => String(p?.chainId).toLowerCase() === "robinhood");
  rh.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
  return rh[0] || null;
}

async function rpcCall(method, params = [], rpcUrl = RH_RPC_DEFAULT) {
  try {
    const body = await requestJson(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    }, 12000, 1);
    return body?.result ?? null;
  } catch (_) {
    return null;
  }
}

function hexToBigInt(hex) {
  try { return BigInt(hex); } catch (_) { return null; }
}

function decodeUint(hex) {
  const n = hexToBigInt(hex);
  return n == null ? null : n;
}

function decodeAddress(hex) {
  if (!hex || typeof hex !== "string" || hex.length < 66) return null;
  return `0x${hex.slice(-40)}`;
}

async function getContractChecks(address, rpcUrl = RH_RPC_DEFAULT) {
  const code = await rpcCall("eth_getCode", [address, "latest"], rpcUrl);
  if (!code || code === "0x") return { available: false, isContract: false };

  const [ownerRaw, pausedRaw, totalSupplyRaw] = await Promise.all([
    rpcCall("eth_call", [{ to: address, data: "0x8da5cb5b" }, "latest"], rpcUrl),
    rpcCall("eth_call", [{ to: address, data: "0x5c975abb" }, "latest"], rpcUrl),
    rpcCall("eth_call", [{ to: address, data: "0x18160ddd" }, "latest"], rpcUrl),
  ]);

  const owner = decodeAddress(ownerRaw);
  const pausedN = decodeUint(pausedRaw);
  const totalSupplyRawBig = decodeUint(totalSupplyRaw);

  // Launchpad direct-v3 tokens use the platform factory and permanently locked LP.
  // Owner/paused probes are additional safety evidence when the ERC-20 exposes them.
  const ownerActive = !!owner && !/^0x0{40}$/i.test(owner);
  const paused = pausedN == null ? null : pausedN !== 0n;
  return {
    available: true,
    isContract: true,
    bytecodeLength: Math.max(0, Math.floor((String(code).length - 2) / 2)),
    owner: owner || null,
    ownerActive,
    paused,
    totalSupplyRaw: totalSupplyRawBig,
  };
}

async function getBlockscoutToken(address) {
  try {
    return await requestJson(`${BLOCKSCOUT_BASE}/tokens/${encodeURIComponent(address)}`, {}, 10000, 1);
  } catch (_) { return null; }
}

async function getHolderCounters(address) {
  try {
    const x = await requestJson(`${BLOCKSCOUT_BASE}/tokens/${encodeURIComponent(address)}/counters`, {}, 10000, 1);
    const n = Number(x?.token_holders_count);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

async function getTopHolders(address) {
  try {
    const x = await requestJson(`${BLOCKSCOUT_BASE}/tokens/${encodeURIComponent(address)}/holders`, {}, 12000, 1);
    return Array.isArray(x?.items) ? x.items : [];
  } catch (_) { return []; }
}

function extractHolderAddress(holder) {
  return holder?.address_hash?.hash || holder?.address_hash || holder?.address || null;
}

function extractHolderValue(holder) {
  try { return BigInt(holder?.value ?? "0"); } catch (_) { return 0n; }
}

async function getRobinhoodTokenData(launch, opts = {}) {
  const address = launch.tokenAddress;
  const pair = await getDexPair(address);
  const [contract, tokenInfo, holderCount, holders] = await Promise.all([
    getContractChecks(address, opts.rpcUrl || RH_RPC_DEFAULT),
    getBlockscoutToken(address),
    getHolderCounters(address),
    getTopHolders(address),
  ]);

  let top10Pct = null;
  let largestHolderPct = null;
  const totalSupplyRaw = contract?.totalSupplyRaw || (tokenInfo?.total_supply ? BigInt(tokenInfo.total_supply) : null);
  if (totalSupplyRaw && totalSupplyRaw > 0n && holders.length) {
    const top = holders
      .map((h) => ({ address: extractHolderAddress(h), value: extractHolderValue(h) }))
      .filter((h) => h.value > 0n);
    const exclude = new Set([String(launch.poolAddress || "").toLowerCase(), WETH]);
    const filtered = top.filter((h) => !exclude.has(String(h.address || "").toLowerCase()));
    const top10 = filtered.slice(0, 10).reduce((sum, h) => sum + h.value, 0n);
    const largest = filtered[0]?.value || 0n;
    top10Pct = Number((top10 * 10000n) / totalSupplyRaw) / 100;
    largestHolderPct = Number((largest * 10000n) / totalSupplyRaw) / 100;
  }

  const now = Date.now();
  const pairCreated = Number(pair?.pairCreatedAt);
  const createdAtMs = launch.createdAtMs || (Number.isFinite(pairCreated) && pairCreated > 0 ? pairCreated : null);
  const ageSeconds = createdAtMs ? Math.max(0, Math.floor((now - createdAtMs) / 1000)) : null;
  const txns = pair?.txns || {};
  const h24 = txns.h24 || {};
  const buys24h = Number(h24.buys || 0);
  const sells24h = Number(h24.sells || 0);

  const dexLinks = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];
  const dexSocials = Array.isArray(pair?.info?.socials) ? pair.info.socials : [];
  const website = launch.website || dexLinks[0]?.url || null;
  const twitter = launch.twitter || dexSocials.find((x) => /twitter|x/i.test(String(x?.type || "")))?.url || null;
  const telegram = launch.telegram || dexSocials.find((x) => /telegram/i.test(String(x?.type || "")))?.url || null;

  return {
    chain: "robinhood",
    chainId: CHAIN_ID,
    tokenAddress: address,
    name: launch.name || pair?.baseToken?.name || tokenInfo?.name || "Unknown",
    symbol: launch.symbol || pair?.baseToken?.symbol || tokenInfo?.symbol || "TOKEN",
    description: launch.description || "",
    pairAddress: pair?.pairAddress || launch.poolAddress || null,
    dexId: pair?.dexId || "uniswap",
    launchpad: "launchpad.meme",
    launchFactory: launch.factory || FACTORY,
    creator: launch.creator || null,
    tokenAgeSeconds: ageSeconds,
    liquidityUsd: Number(pair?.liquidity?.usd || 0) || null,
    marketCapUsd: Number(pair?.marketCap || pair?.fdv || 0) || null,
    volume24hUsd: Number(pair?.volume?.h24 || 0) || null,
    priceChange5mPct: Number(pair?.priceChange?.m5) || 0,
    priceChange1hPct: Number(pair?.priceChange?.h1) || 0,
    priceChange6hPct: Number(pair?.priceChange?.h6) || 0,
    priceChange24hPct: Number(pair?.priceChange?.h24) || 0,
    buys24h,
    sells24h,
    buySellRatio24: sells24h > 0 ? buys24h / sells24h : buys24h > 0 ? buys24h : null,
    holderCount: holderCount != null ? holderCount : (Number.isFinite(Number(tokenInfo?.holders)) ? Number(tokenInfo.holders) : null),
    top10Pct,
    largestHolderPct,
    authorityDataAvailable: contract?.available === true,
    contract: contract || { available: false },
    tokenInfo: tokenInfo || null,
    launch: {
      website,
      twitter,
      telegram,
      icon: launch.icon || pair?.info?.imageUrl || null,
      poolAddress: launch.poolAddress || pair?.pairAddress || null,
      factory: launch.factory || FACTORY,
    },
    dexPair: pair,
    launchRaw: launch.raw,
    dataSources: {
      launchpad: true,
      dexScreener: !!pair,
      blockscout: !!tokenInfo,
      holderCounters: holderCount != null,
      holderDistribution: holders.length > 0,
      contractChecks: !!contract?.available,
    },
  };
}

module.exports = {
  CHAIN_ID,
  FACTORY,
  RH_RPC_DEFAULT,
  requestJson,
  discoverRobinhoodLaunches,
  getRobinhoodTokenData,
  getContractChecks,
  getHolderCounters,
  getTopHolders,
};
