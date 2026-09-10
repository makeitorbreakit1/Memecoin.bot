"use strict";

console.log("🚀 SOLANA TRACKER V3 - BUILD MARKER 2026-09-10");
console.log("✅ Loading NEW lib/apiClient.js");

const fetch = require("node-fetch");

const DEX_BASE = "https://api.dexscreener.com";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const RUGCHECK_BASE = "https://api.rugcheck.xyz";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generic JSON request helper
 * - Handles timeouts
 * - Retries 429 / 5xx
 * - Respects Retry-After
 */
async function requestJson(url, options = {}, timeoutMs = 12000, retries = 1) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const text = await res.text();

      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        body = null;
      }

      if (res.ok) {
        return body;
      }

      const retryable = res.status === 429 || res.status >= 500;

      const err = new Error(
        `HTTP ${res.status} ${res.statusText} from ${new URL(url).hostname}`
      );

      err.status = res.status;
      err.body = body;

      lastError = err;

      if (!retryable || attempt >= retries) {
        throw err;
      }

      const retryAfter = Number(res.headers.get("retry-after"));

      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (attempt + 1);

      await sleep(delay);
    } catch (err) {
      lastError = err;

      if (attempt >= retries) {
        throw err;
      }

      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * ---------------------------------------------------------------
 * DEXSCREENER DISCOVERY
 * ---------------------------------------------------------------
 *
 * Uses public DexScreener endpoints to discover recent Solana
 * tokens without consuming Birdeye API quota.
 */
async function discoverNewTokens() {
  const [profiles, boosts] = await Promise.all([
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

  const combined = [
    ...(Array.isArray(profiles) ? profiles : []),
    ...(Array.isArray(boosts) ? boosts : []),
  ];

  for (const item of combined) {
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

/**
 * ---------------------------------------------------------------
 * BIRDEYE
 * ---------------------------------------------------------------
 */

function birdeyeHeaders(apiKey) {
  return {
    Accept: "application/json",
    "X-API-KEY": apiKey,
    "x-chain": "solana",
  };
}

/**
 * Birdeye token overview
 *
 * 429 errors are intentionally silent because low-tier Birdeye
 * plans can hit rate limits during discovery.
 */
async function getBirdeyeOverview(address, apiKey) {
  if (!apiKey) return null;

  try {
    const data = await requestJson(
      `${BIRDEYE_BASE}/defi/token_overview?address=${encodeURIComponent(
        address
      )}`,
      {
        headers: birdeyeHeaders(apiKey),
      },
      10000,
      1
    );

    return data?.data ?? null;
  } catch (err) {
    if (err.status !== 429) {
      console.warn(
        `[apiClient] Birdeye overview failed for ${address}: ${err.message}`
      );
    }

    return null;
  }
}

/**
 * Birdeye token security
 *
 * 429 errors are intentionally silent.
 */
async function getBirdeyeSecurity(address, apiKey) {
  if (!apiKey) return null;

  try {
    const data = await requestJson(
      `${BIRDEYE_BASE}/defi/token_security?address=${encodeURIComponent(
        address
      )}`,
      {
        headers: birdeyeHeaders(apiKey),
      },
      10000,
      1
    );

    return data?.data ?? null;
  } catch (err) {
    if (err.status !== 429) {
      console.warn(
        `[apiClient] Birdeye security failed for ${address}: ${err.message}`
      );
    }

    return null;
  }
}

/**
 * ---------------------------------------------------------------
 * DEXSCREENER
 * ---------------------------------------------------------------
 */

async function getDexPairs(address) {
  const data = await requestJson(
    `${DEX_BASE}/token-pairs/v1/solana/${encodeURIComponent(address)}`,
    {},
    10000,
    1
  );

  return Array.isArray(data) ? data : [];
}

async function getDexTokenData(address) {
  const data = await requestJson(
    `${DEX_BASE}/tokens/v1/solana/${encodeURIComponent(address)}`,
    {},
    10000,
    1
  );

  return Array.isArray(data) ? data : [];
}

/**
 * ---------------------------------------------------------------
 * SOLANA / HELIUS RPC
 * ---------------------------------------------------------------
 */

async function rpcCall(rpcUrl, method, params = []) {
  if (!rpcUrl) return null;

  try {
    const result = await requestJson(
      rpcUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      },
      12000,
      1
    );

    return result?.result ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * ---------------------------------------------------------------
 * HELIUS DAS getAsset
 * ---------------------------------------------------------------
 *
 * IMPORTANT:
 * This intentionally uses the current Helius DAS getAsset RPC
 * method rather than the old metadata endpoint that returned
 * HTTP 410.
 */
async function getHeliusAsset(address, heliusApiKey) {
  if (!heliusApiKey) return null;

  const url =
    `https://mainnet.helius-rpc.com/?api-key=` +
    encodeURIComponent(heliusApiKey);

  try {
    const response = await requestJson(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),

          method: "getAsset",

          params: {
            id: address,

            options: {
              showFungible: true,
            },
          },
        }),
      },
      12000,
      1
    );

    return response?.result ?? null;
  } catch (err) {
    /**
     * HTTP 410 from the OLD Helius metadata endpoint should never
     * be produced by this function.
     *
     * If you still see:
     *
     *   Helius metadata failed
     *
     * in Railway after deploying this file, then that message is
     * definitely coming from another/older copy of the code.
     */
    if (err.status !== 410) {
      console.warn(
        `[apiClient] Helius getAsset failed for ${address}: ${err.message}`
      );
    }

    return null;
  }
}

/**
 * ---------------------------------------------------------------
 * RUGCHECK
 * ---------------------------------------------------------------
 *
 * Attempts:
 *
 * 1. /report/summary
 * 2. /report
 *
 * If an API key is supplied, it supports both:
 *
 * X-API-KEY
 *
 * and JWT/Bearer authentication.
 *
 * If the supplied key produces 401, the request is retried
 * without authentication so a public report can still work.
 */
async function getRugCheckReport(address, apiKey) {
  const authenticatedHeaders = {
    Accept: "application/json",
  };

  if (apiKey) {
    authenticatedHeaders["X-API-KEY"] = apiKey;

    if (/^eyJ/.test(apiKey)) {
      authenticatedHeaders.Authorization = `Bearer ${apiKey}`;
    }
  }

  const endpoints = [
    "/report/summary",
    "/report",
  ];

  for (const suffix of endpoints) {
    /**
     * -----------------------------------------------------------
     * First attempt
     * -----------------------------------------------------------
     */
    try {
      return await requestJson(
        `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(
          address
        )}${suffix}`,
        {
          headers: authenticatedHeaders,
        },
        12000,
        1
      );
    } catch (err) {
      /**
       * ---------------------------------------------------------
       * 401 fallback
       * ---------------------------------------------------------
       *
       * A stale/invalid optional RugCheck key should not prevent
       * us from trying the public endpoint.
       */
      if (err.status === 401 && apiKey) {
        try {
          return await requestJson(
            `${RUGCHECK_BASE}/v1/tokens/${encodeURIComponent(
              address
            )}${suffix}`,
            {
              headers: {
                Accept: "application/json",
              },
            },
            12000,
            1
          );
        } catch (_) {
          // Continue to the next RugCheck endpoint.
        }
      }

      /**
       * Don't spam Railway logs with expected 401/404 responses.
       */
      if (err.status !== 401 && err.status !== 404) {
        console.warn(
          `[apiClient] RugCheck report failed for ${address}: ${err.message}`
        );
      }
    }
  }

  return null;
}

/**
 * ---------------------------------------------------------------
 * EXPORTS
 * ---------------------------------------------------------------
 */

module.exports = {
  requestJson,

  discoverNewTokens,

  getBirdeyeOverview,
  getBirdeyeSecurity,

  getDexPairs,
  getDexTokenData,

  rpcCall,
  getHeliusAsset,

  getRugCheckReport,
};
