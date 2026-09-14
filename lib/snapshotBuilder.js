"use strict";

const {
  getDexTokenPairs,
  rpcCall,
} = require("./apiClient");

const WSOL =
  "So11111111111111111111111111111111111111112";

const num = (v) => {
  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : null;
};

const SOLANA_ADDRESS_RE =
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function bestPair(
  pairs
) {
  return [...pairs].sort(
    (a, b) =>
      (
        num(
          b?.liquidity?.usd
        ) ?? -1
      ) -
      (
        num(
          a?.liquidity?.usd
        ) ?? -1
      )
  )[0] || null;
}

function looksLikeSolanaAddress(
  address
) {
  return (
    SOLANA_ADDRESS_RE.test(
      address
    ) &&
    !/^0x[0-9a-f]{40}$/i.test(
      address
    )
  );
}

async function buildSnapshot(
  address,
  opts = {}
) {
  if (
    !address ||
    typeof address !==
      "string"
  ) {
    throw new Error(
      "Invalid token address"
    );
  }

  address =
    address.trim();

  const pairs =
    await getDexTokenPairs(
      address
    );

  const pair =
    bestPair(
      pairs
    );

  if (!pair) {
    throw new Error(
      "No Solana DEX pair found for that token mint"
    );
  }

  const rpcUrl =
    opts.enableHeliusRpc !==
    false
      ? (
          opts.rpcUrl ||
          (
            opts.heliusApiKey
              ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}`
              : null
          )
        )
      : null;

  let mintAccount =
    null;

  /*
   * Only request the Mint account.
   *
   * We deliberately do NOT call:
   *   getTokenSupply
   *   getTokenLargestAccounts
   *
   * The latter was repeatedly hitting RPC 429s.
   */
  if (rpcUrl) {
    mintAccount =
      await rpcCall(
        rpcUrl,
        "getAccountInfo",
        [
          address,
          {
            encoding:
              "jsonParsed",

            commitment:
              "confirmed",
          },
        ]
      );
  }

  const pairCreatedAt =
    num(
      pair.pairCreatedAt
    );

  const tokenAgeSeconds =
    pairCreatedAt
      ? Math.max(
          0,
          Math.floor(
            Date.now() /
              1000 -
            pairCreatedAt /
              1000
          )
        )
      : null;

  const tx24 =
    pair.txns?.h24 ||
    {};

  const parsedMint =
    mintAccount
      ?.value
      ?.data
      ?.parsed
      ?.info ||
    {};

  const authorityDataAvailable =
    Object.prototype.hasOwnProperty.call(
      parsedMint,
      "mintAuthority"
    ) ||
    Object.prototype.hasOwnProperty.call(
      parsedMint,
      "freezeAuthority"
    );

  const mintAuthority =
    parsedMint.mintAuthority ??
    null;

  const freezeAuthority =
    parsedMint.freezeAuthority ??
    null;

  const decimals =
    num(
      parsedMint.decimals
    ) ??
    num(
      pair.baseToken?.decimals
    );

  const totalSupplyRaw =
    num(
      parsedMint.supply
    );

  let totalSupply =
    null;

  if (
    totalSupplyRaw !=
      null &&
    decimals !=
      null
  ) {
    totalSupply =
      totalSupplyRaw /
      Math.pow(
        10,
        decimals
      );
  }

  const buy24 =
    num(tx24.buys);

  const sell24 =
    num(tx24.sells);

  const liquidityUsd =
    num(
      pair.liquidity?.usd
    );

  const marketCap =
    num(
      pair.marketCap
    ) ??
    num(
      pair.fdv
    );

  const vol24 =
    num(
      pair.volume?.h24
    );

  const buySellRatio24 =
    buy24 != null &&
    sell24 != null
      ? buy24 /
        Math.max(
          1,
          sell24
        )
      : null;

  const metrics = {
    tokenAgeSeconds,

    liquidityUsd,

    marketCapUsd:
      marketCap,

    volume24hUsd:
      vol24,

    priceChange5mPct:
      num(
        pair.priceChange?.m5
      ),

    priceChange1hPct:
      num(
        pair.priceChange?.h1
      ),

    priceChange6hPct:
      num(
        pair.priceChange?.h6
      ),

    priceChange24hPct:
      num(
        pair.priceChange?.h24
      ),

    buys24h:
      buy24,

    sells24h:
      sell24,

    buySellRatio24,

    holderCount:
      null,

    topHolderPct:
      null,

    top10HolderPct:
      null,

    top20HolderPct:
      null,
  };

  let verificationConfidencePct =
    0;

  if (
    pair &&
    liquidityUsd !=
      null &&
    marketCap !=
      null &&
    vol24 !=
      null
  ) {
    verificationConfidencePct +=
      60;
  }

  if (
    authorityDataAvailable
  ) {
    verificationConfidencePct +=
      20;
  }

  if (
    buy24 != null &&
    sell24 != null
  ) {
    verificationConfidencePct +=
      20;
  }

  verificationConfidencePct =
    Math.min(
      100,
      verificationConfidencePct
    );

  return {
    address,

    name:
      pair.baseToken?.name ??
      "Unknown Token",

    symbol:
      pair.baseToken?.symbol ??
      "UNKNOWN",

    chain:
      "solana",

    dexId:
      pair.dexId ??
      null,

    pairAddress:
      pair.pairAddress ??
      null,

    pairUrl:
      pair.url ??
      null,

    priceUsd:
      num(
        pair.priceUsd
      ),

    liquidityUsd,

    marketCapUsd:
      marketCap,

    fdvUsd:
      num(pair.fdv),

    volume24hUsd:
      vol24,

    priceChange5mPct:
      num(
        pair.priceChange?.m5
      ),

    priceChange1hPct:
      num(
        pair.priceChange?.h1
      ),

    priceChange6hPct:
      num(
        pair.priceChange?.h6
      ),

    priceChange24hPct:
      num(
        pair.priceChange?.h24
      ),

    buys24h:
      buy24,

    sells24h:
      sell24,

    buySellRatio24,

    holderCount:
      null,

    topHolderPct:
      null,

    top10HolderPct:
      null,

    top20HolderPct:
      null,

    largestHolder:
      null,

    totalSupply,

    decimals,

    mintAuthority,

    freezeAuthority,

    authorityDataAvailable,

    liquidityLockedPct:
      null,

    securityScore:
      null,

    tokenAgeSeconds,

    pairCreatedAt,

    verificationConfidencePct,

    missingMetricCount:
      Object.values(
        metrics
      ).filter(
        (v) =>
          v == null
      ).length,

    metrics,

    dexPair:
      pair,

    heliusAsset:
      null,

    rpcSupply:
      totalSupply !=
        null
        ? {
            uiAmount:
              totalSupply,

            decimals,

            raw:
              totalSupplyRaw,
          }
        : null,

    solanaEnhanced:
      true,
  };
}

module.exports = {
  buildSnapshot,
  WSOL,
  looksLikeSolanaAddress,
};
