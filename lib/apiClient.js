"use strict";

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";

// Official Solana public RPC fallback.
// Used ONLY when Helius is unavailable/rate-limited.
const SOLANA_FALLBACK_RPC =
  process.env.SOLANA_FALLBACK_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// HELIUS RPC SETTINGS
// -----------------------------------------------------------------------------

const HELIUS_RPC_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.HELIUS_RPC_INTERVAL_MS || 1000)
);

const HELIUS_COOLDOWN_MS = Math.max(
  10000,
  Number(process.env.HELIUS_COOLDOWN_MS || 30000)
);

const HELIUS_CACHE_MS = Math.max(
  10000,
  Number(process.env.HELIUS_CACHE_MS || 120000)
);

const HELIUS_MAX_RETRIES = Math.max(
  0,
  Number(process.env.HELIUS_MAX_RETRIES || 0)
);

let rpcNextAllowedAt = 0;
let rpcCooldownUntil = 0;
let rpcQueue = Promise.resolve();

let last429LogAt = 0;
let lastFallbackLogAt = 0;
let lastHolder429LogAt = 0;

const heliusCache = new Map();
const rugCheckCache = new Map();
const holderCountCache = new Map();

// Holder counts are expensive, so cache them longer.
const HOLDER_COUNT_CACHE_MS = Math.max(
  60000,
  Number(process.env.HOLDER_COUNT_CACHE_MS || 600000)
);

// Safety cap so a giant token cannot trigger hundreds of requests.
const HOLDER_LOOKUP_MAX_PAGES = Math.max(
  1,
  Number(process.env.HOLDER_LOOKUP_MAX_PAGES || 25)
);

// -----------------------------------------------------------------------------
// CACHE HELPERS
// -----------------------------------------------------------------------------

function cacheGet(map, key, ttl) {
  const item = map.get(key);

  if (!item) {
    return undefined;
  }

  if (Date.now() - item.timestamp > ttl) {
    map.delete(key);
    return undefined;
  }

  return item.value;
}

function cacheSet(map, key, value, maxSize = 1000) {
  map.set(key, {
    timestamp: Date.now(),
    value,
  });

  while (map.size > maxSize) {
    map.delete(map.keys().next().value);
  }
}

// -----------------------------------------------------------------------------
// HELIUS HELPERS
// -----------------------------------------------------------------------------

function isHeliusUrl(url) {
  try {
    return new URL(url).hostname.endsWith("helius-rpc.com");
  } catch (_) {
    return false;
  }
}

function heliusRpcUrl(apiKey) {
  return apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`
    : null;
}

// -----------------------------------------------------------------------------
// GENERIC HTTP JSON REQUEST
// -----------------------------------------------------------------------------

async function requestJson(
  url,
  options = {},
  timeoutMs = 12000,
  retries = 0
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const text = await res.text();

      let body = null;

      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {}

      if (res.ok) {
        return body;
      }

      const err = new Error(
        `HTTP ${res.status} ${res.statusText} from ${new URL(url).hostname}`
      );

      err.status = res.status;
      err.body = body;

      const retryAfter = Number(
        res.headers.get("retry-after")
      );

      err.retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : null;

      lastError = err;

      if (
        attempt < retries &&
        (res.status === 429 || res.status >= 500)
      ) {
        const base =
          err.retryAfterMs ||
          Math.min(
            30000,
            1000 * Math.pow(2, attempt)
          );

        await sleep(
          base * (0.75 + Math.random())
        );

        continue;
      }

      throw err;
    } catch (err) {
      lastError = err;

      if (attempt >= retries) {
        throw err;
      }

      await sleep(
        500 * Math.pow(2, attempt)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// -----------------------------------------------------------------------------
// HELIUS RPC QUEUE
// -----------------------------------------------------------------------------

function scheduleHelius(task) {
  const run = rpcQueue.then(async () => {
    while (Date.now() < rpcCooldownUntil) {
      const remaining =
        rpcCooldownUntil - Date.now();

      await sleep(
        Math.min(remaining, 1000)
      );
    }

    const wait = Math.max(
      0,
      rpcNextAllowedAt - Date.now()
    );

    if (wait > 0) {
      await sleep(wait);
    }

    rpcNextAllowedAt =
      Date.now() +
      HELIUS_RPC_INTERVAL_MS;

    let attempt = 0;

    while (true) {
      try {
        return await task();
      } catch (err) {
        if (err.status !== 429) {
          console.warn(
            `[apiClient] Helius RPC request failed: ${err.message}`
          );

          return null;
        }

        attempt++;

        const pause = Math.max(
          HELIUS_COOLDOWN_MS,
          err.retryAfterMs || 0
        );

        rpcCooldownUntil =
          Date.now() + pause;

        if (
          Date.now() - last429LogAt >
          10000
        ) {
          console.warn(
            `[apiClient] Helius RPC rate limited. Falling back to Solana RPC.`
          );

          last429LogAt =
            Date.now();
        }

        if (
          attempt >
          HELIUS_MAX_RETRIES
        ) {
          return null;
        }

        while (
          Date.now() <
          rpcCooldownUntil
        ) {
          const remaining =
            rpcCooldownUntil -
            Date.now();

          await sleep(
            Math.min(remaining, 1000)
          );
        }

        rpcNextAllowedAt =
          Date.now() +
          HELIUS_RPC_INTERVAL_MS;
      }
    }
  });

  rpcQueue =
    run.catch(() => null);

  return run;
}

// -----------------------------------------------------------------------------
// RAW RPC REQUEST
// -----------------------------------------------------------------------------

async function directRpcCall(
  rpcUrl,
  method,
  params,
  cachePrefix
) {
  const body = {
    jsonrpc: "2.0",
    id:
      `${method}-${Date.now()}-` +
      `${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    method,
    params,
  };

  const cacheKey =
    `${cachePrefix}:${method}:${JSON.stringify(params)}`;

  const cached =
    cacheGet(
      heliusCache,
      cacheKey,
      HELIUS_CACHE_MS
    );

  if (cached !== undefined) {
    return cached?.result ?? null;
  }

  const doRequest = async () => {
    const response =
      await requestJson(
        rpcUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(body),
        },

        12000,
        0
      );

    if (response?.error) {
      const errorCode =
        Number(response.error.code);

      const message =
        String(
          response.error.message || ""
        );

      const err =
        new Error(
          message ||
          "Solana RPC error"
        );

      if (
        errorCode === -32005 ||
        /rate.?limit|too many requests|limit exceeded/i.test(
          message
        )
      ) {
        err.status = 429;
      } else {
        err.status = 400;
      }

      throw err;
    }

    cacheSet(
      heliusCache,
      cacheKey,
      response
    );

    return response;
  };

  const response =
    await doRequest();

  return response?.result ?? null;
}

// -----------------------------------------------------------------------------
// SOLANA RPC
// -----------------------------------------------------------------------------

async function rpcCall(
  rpcUrl,
  method,
  params = []
) {
  if (!rpcUrl) {
    return null;
  }

  if (isHeliusUrl(rpcUrl)) {
    try {
      const result =
        await scheduleHelius(
          () =>
            directRpcCall(
              rpcUrl,
              method,
              params,
              `helius:${rpcUrl}`
            )
        );

      if (
        result !== null &&
        result !== undefined
      ) {
        return result;
      }
    } catch (_) {}

    if (
      Date.now() - lastFallbackLogAt >
      10000
    ) {
      console.warn(
        `[apiClient] Using Solana fallback RPC for ${method}.`
      );

      lastFallbackLogAt =
        Date.now();
    }

    try {
      return await directRpcCall(
        SOLANA_FALLBACK_RPC,
        method,
        params,
        `fallback:${SOLANA_FALLBACK_RPC}`
      );
    } catch (err) {
      console.warn(
        `[apiClient] Fallback RPC failed for ${method}: ${err.message}`
      );

      return null;
    }
  }

  try {
    return await directRpcCall(
      rpcUrl,
      method,
      params,
      `rpc:${rpcUrl}`
    );
  } catch (_) {
    return null;
  }
}

// -----------------------------------------------------------------------------
// DEXSCREENER DISCOVERY
// -----------------------------------------------------------------------------

async function discoverNewTokens() {
  const [profiles, boosts] =
    await Promise.all([
      requestJson(
        `${DEX_BASE}/token-profiles/latest/v1`,
        {},
        10000,
        1
      ).catch(() => []),

      requestJson(
        `${DEX_BASE}/token-boosts/latest/v1`,
        {},
        10000,
        1
      ).catch(() => []),
    ]);

  const seen = new Set();
  const result = [];

  for (const item of [
    ...(Array.isArray(profiles)
      ? profiles
      : []),

    ...(Array.isArray(boosts)
      ? boosts
      : []),
  ]) {
    if (
      item?.chainId !== "solana" ||
      !item.tokenAddress ||
      seen.has(item.tokenAddress)
    ) {
      continue;
    }

    seen.add(item.tokenAddress);
    result.push(item.tokenAddress);
  }

  return result.slice(0, 40);
}

// -----------------------------------------------------------------------------
// EARLY LAUNCH SIGNALS
// -----------------------------------------------------------------------------

function extractSocialSignals(item) {
  const links =
    Array.isArray(item?.links)
      ? item.links
      : [];

  const socials =
    links.filter((x) => {
      const t =
        String(
          x?.type ||
          x?.platform ||
          ""
        ).toLowerCase();

      const u =
        String(
          x?.url || ""
        ).toLowerCase();

      return (
        t.includes("twitter") ||
        t === "x" ||
        u.includes("twitter.com") ||
        u.includes("x.com")
      );
    });

  const description =
    String(
      item?.description || ""
    );

  return {
    hasTwitter:
      socials.length > 0,

    hasWebsite:
      links.some((x) =>
        String(
          x?.type || ""
        )
          .toLowerCase()
          .includes("website")
      ) ||
      links.some((x) =>
        /^https?:\/\//i.test(
          String(x?.url || "")
        ) &&
        !/twitter\.com|x\.com/i.test(
          String(x?.url || "")
        )
      ),

    hasLaunchLanguage:
      /\b(launch|launched|launching|fair launch|stealth|live now|just dropped|just launched)\b/i.test(
        description
      ),

    twitterUrl:
      socials[0]?.url || null,

    description:
      description.slice(0, 500),

    source:
      "DexScreener public profile feed",
  };
}

async function discoverEarlyLaunchSignals() {
  const [profiles, boosts] =
    await Promise.all([
      requestJson(
        `${DEX_BASE}/token-profiles/latest/v1`,
        {},
        10000,
        1
      ).catch(() => []),

      requestJson(
        `${DEX_BASE}/token-boosts/latest/v1`,
        {},
        10000,
        1
      ).catch(() => []),
    ]);

  const seen = new Set();
  const result = [];

  for (const item of [
    ...(Array.isArray(profiles)
      ? profiles
      : []),

    ...(Array.isArray(boosts)
      ? boosts
      : []),
  ]) {
    if (
      item?.chainId !== "solana" ||
      !item.tokenAddress ||
      seen.has(item.tokenAddress)
    ) {
      continue;
    }

    seen.add(item.tokenAddress);

    const social =
      extractSocialSignals(item);

    const signalScore =
      (social.hasTwitter ? 35 : 0) +
      (social.hasWebsite ? 15 : 0) +
      (social.hasLaunchLanguage
        ? 25
        : 0) +
      (item?.amount ? 10 : 0);

    result.push({
      tokenAddress:
        item.tokenAddress,

      signalScore,

      social,

      sourceItem:
        item,
    });
  }

  return result
    .sort(
      (a, b) =>
        b.signalScore -
        a.signalScore
    )
    .slice(0, 40);
}

// -----------------------------------------------------------------------------
// DEXSCREENER MARKET DATA
// -----------------------------------------------------------------------------

async function getDexTokenPairs(address) {
  const data =
    await requestJson(
      `${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`,
      {},
      10000,
      1
    );

  return Array.isArray(data?.pairs)
    ? data.pairs.filter(
        (p) =>
          p?.chainId === "solana"
      )
    : [];
}

async function getDexPairs(address) {
  return getDexTokenPairs(address);
}

async function getDexTokenData(address) {
  return getDexTokenPairs(address);
}

// -----------------------------------------------------------------------------
// RUGCHECK
// -----------------------------------------------------------------------------

async function getRugCheckReport(
  address,
  apiKey
) {
  const cacheKey =
    `rugcheck:${address}`;

  const cached =
    cacheGet(
      rugCheckCache,
      cacheKey,
      60000
    );

  if (cached !== undefined) {
    return cached;
  }

  const headers = {
    Accept:
      "application/json",
  };

  if (apiKey) {
    headers["X-API-KEY"] =
      apiKey;

    if (/^eyJ/.test(apiKey)) {
      headers.Authorization =
        `Bearer ${apiKey}`;
    }
  }

  for (const suffix of [
    "/report/summary",
    "/report",
  ]) {
    try {
      const result =
        await requestJson(
          `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(
            address
          )}${suffix}`,
          { headers },
          12000,
          0
        );

      cacheSet(
        rugCheckCache,
        cacheKey,
        result,
        500
      );

      return result;
    } catch (err) {
      if (
        err.status === 401 &&
        apiKey
      ) {
        try {
          const result =
            await requestJson(
              `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(
                address
              )}${suffix}`,
              {
                Accept:
                  "application/json",
              },
              12000,
              0
            );

          cacheSet(
            rugCheckCache,
            cacheKey,
            result,
            500
          );

          return result;
        } catch (_) {}
      }

      if (
        err.status !== 401 &&
        err.status !== 404
      ) {
        console.warn(
          `[apiClient] RugCheck report failed for ${address}: ${err.message}`
        );
      }
    }
  }

  cacheSet(
    rugCheckCache,
    cacheKey,
    null,
    500
  );

  return null;
}

// -----------------------------------------------------------------------------
// EXACT HOLDER COUNT
// -----------------------------------------------------------------------------
//
// Uses Helius getTokenAccounts to retrieve token accounts for the mint,
// then deduplicates by wallet owner.
//
// This is intentionally NOT used during the normal candidate scan.
// It is only called after a token has already passed the radar filters.
//
// Helius documents getTokenAccounts as a mint-filtered method and notes that
// one owner can have multiple token accounts, so owner deduplication is needed.
// -----------------------------------------------------------------------------

async function getTokenHolderCount(
  address,
  apiKey
) {
  if (!address || !apiKey) {
    return null;
  }

  const cacheKey =
    `holders:${address}`;

  const cached =
    cacheGet(
      holderCountCache,
      cacheKey,
      HOLDER_COUNT_CACHE_MS
    );

  if (cached !== undefined) {
    return cached;
  }

  const rpcUrl =
    heliusRpcUrl(apiKey);

  if (!rpcUrl) {
    return null;
  }

  const owners = new Set();

  let page = 1;

  try {
    while (
      page <=
      HOLDER_LOOKUP_MAX_PAGES
    ) {
      const body = {
        jsonrpc: "2.0",

        id:
          `holders-${Date.now()}-` +
          `${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        method:
          "getTokenAccounts",

        params: {
          mint: address,
          page,
          limit: 1000,

          displayOptions: {},
        },
      };

      /*
       * Holder lookup is intentionally serialized here.
       * We don't want multiple holder scans running together.
       */
      const response =
        await scheduleHelius(
          () =>
            requestJson(
              rpcUrl,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify(body),
              },

              15000,
              0
            ).then((json) => {
              if (json?.error) {
                const message =
                  String(
                    json.error.message ||
                    ""
                  );

                const err =
                  new Error(
                    message ||
                    "Helius holder request failed"
                  );

                if (
                  /rate.?limit|too many requests|limit exceeded/i.test(
                    message
                  )
                ) {
                  err.status = 429;
                } else {
                  err.status = 400;
                }

                throw err;
              }

              return json;
            })
        ).catch((err) => {
          if (
            err?.status === 429 &&
            Date.now() -
              lastHolder429LogAt >
              10000
          ) {
            console.warn(
              `[holders] Helius getTokenAccounts rate limited.`
            );

            lastHolder429LogAt =
              Date.now();
          }

          return null;
        });

      if (!response) {
        return null;
      }

      const accounts =
        Array.isArray(
          response?.result?.token_accounts
        )
          ? response.result.token_accounts
          : [];

      if (
        accounts.length === 0
      ) {
        break;
      }

      for (const account of accounts) {
        const owner =
          account?.owner;

        if (!owner) {
          continue;
        }

        /*
         * Helius returns token-account amounts.
         * Only count accounts that currently hold tokens.
         */
        const rawAmount =
          Number(account?.amount);

        if (
          Number.isFinite(rawAmount)
            ? rawAmount > 0
            : true
        ) {
          owners.add(owner);
        }
      }

      if (
        accounts.length < 1000
      ) {
        break;
      }

      page++;
    }

    /*
     * If we hit the page safety limit with a full page,
     * do NOT return a misleading partial holder count.
     */
    if (
      page >
      HOLDER_LOOKUP_MAX_PAGES
    ) {
      console.warn(
        `[holders] ${address}: holder lookup hit safety page limit.`
      );

      return null;
    }

    const count =
      owners.size;

    cacheSet(
      holderCountCache,
      cacheKey,
      count,
      500
    );

    return count;
  } catch (err) {
    console.warn(
      `[holders] Holder lookup failed for ${address}: ${err.message}`
    );

    return null;
  }
}

// -----------------------------------------------------------------------------
// EXPORTS
// -----------------------------------------------------------------------------

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
  getTokenHolderCount,
};
