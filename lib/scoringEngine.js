"use strict";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, n));

const finite = (v) => Number.isFinite(Number(v));

function scoreToken(s) {
  const parts = [];
  let points = 0;
  let possible = 0;

  const add = (name, value, max, reason) => {
    if (value == null || !Number.isFinite(Number(value))) return;

    const safeValue = Math.max(0, Math.min(max, Number(value)));

    points += safeValue;
    possible += max;

    parts.push({
      name,
      points: safeValue,
      max,
      reason,
    });
  };

  /*
   * ---------------------------------------------------------------
   * MARKET DATA
   * These metrics are available during the cheap/pre-Helius filter.
   * ---------------------------------------------------------------
   */

  // Liquidity
  const liq = Number(s.liquidityUsd);

  if (finite(liq)) {
    const p =
      liq >= 100000 ? 15 :
      liq >= 50000 ? 13 :
      liq >= 20000 ? 10 :
      liq >= 10000 ? 7 :
      liq >= 5000 ? 4 :
      0;

    add(
      "Liquidity",
      p,
      15,
      `$${Math.round(liq).toLocaleString()}`
    );
  }

  // 24h volume
  const vol = Number(s.volume24hUsd);

  if (finite(vol)) {
    const p =
      vol >= 250000 ? 12 :
      vol >= 100000 ? 10 :
      vol >= 50000 ? 8 :
      vol >= 15000 ? 5 :
      2;

    add(
      "24h volume",
      p,
      12,
      `$${Math.round(vol).toLocaleString()}`
    );
  }

  // Buy/sell flow
  const ratio = Number(s.buySellRatio24);

  if (finite(ratio)) {
    const p =
      ratio >= 1.8 ? 12 :
      ratio >= 1.25 ? 9 :
      ratio >= 0.9 ? 6 :
      2;

    add(
      "Buy/sell flow",
      p,
      12,
      `${ratio.toFixed(2)}x`
    );
  }

  // Token age
  const age = Number(s.tokenAgeSeconds);

  if (finite(age)) {
    const p =
      age >= 900 ? 8 :
      age >= 300 ? 6 :
      age >= 120 ? 4 :
      2;

    add(
      "Age",
      p,
      8,
      `${Math.round(age / 60)}m`
    );
  }

  // 1h momentum
  const pc1 = Number(s.priceChange1hPct);

  if (finite(pc1)) {
    const p =
      pc1 >= 5 && pc1 <= 80 ? 10 :
      pc1 >= 0 ? 7 :
      pc1 >= -20 ? 3 :
      0;

    add(
      "1h momentum",
      p,
      10,
      `${pc1.toFixed(1)}%`
    );
  }

  // 24h momentum
  const pc24 = Number(s.priceChange24hPct);

  if (finite(pc24)) {
    const p =
      pc24 >= 0 && pc24 <= 150 ? 8 :
      pc24 > 150 ? 3 :
      pc24 >= -25 ? 4 :
      0;

    add(
      "24h momentum",
      p,
      8,
      `${pc24.toFixed(1)}%`
    );
  }

  /*
   * ---------------------------------------------------------------
   * LIQUIDITY / MARKET CAP
   * ---------------------------------------------------------------
   */

  const marketCap = Number(s.marketCapUsd);

  const liqMc =
    finite(marketCap) &&
    marketCap > 0 &&
    finite(liq)
      ? (liq / marketCap) * 100
      : null;

  if (liqMc != null) {
    const p =
      liqMc >= 15 ? 7 :
      liqMc >= 8 ? 5 :
      liqMc >= 3 ? 3 :
      0;

    add(
      "Liquidity / MC",
      p,
      7,
      `${liqMc.toFixed(1)}%`
    );
  }

  /*
   * ---------------------------------------------------------------
   * HELIUS / ON-CHAIN DATA
   *
   * These are only included when the data actually exists.
   *
   * This is important because the first "cheap" snapshot deliberately
   * disables Helius RPC. Missing Helius data should NOT make a token
   * look worse during that initial screening stage.
   * ---------------------------------------------------------------
   */

  const holders = Number(s.holderCount);

  if (finite(holders)) {
    const p =
      holders >= 1000 ? 8 :
      holders >= 500 ? 6 :
      holders >= 200 ? 4 :
      holders >= 50 ? 2 :
      0;

    add(
      "Holders",
      p,
      8,
      `${Math.round(holders)}`
    );
  }

  const top = Number(s.topHolderPct);

  if (finite(top)) {
    const p =
      top <= 20 ? 8 :
      top <= 30 ? 6 :
      top <= 45 ? 3 :
      0;

    add(
      "Top-holder concentration",
      p,
      8,
      `${top.toFixed(1)}%`
    );
  }

  /*
   * Mint authority
   */
  const authorityKnown =
    s.authorityDataAvailable === true;

  if (authorityKnown) {
    const mintSafe =
      s.mintAuthority == null;

    add(
      "Mint authority",
      mintSafe ? 5 : 0,
      5,
      mintSafe ? "renounced" : "active"
    );
  }

  /*
   * Freeze authority
   */
  if (authorityKnown) {
    const freezeSafe =
      s.freezeAuthority == null;

    add(
      "Freeze authority",
      freezeSafe ? 5 : 0,
      5,
      freezeSafe ? "renounced" : "active"
    );
  }

  /*
   * ---------------------------------------------------------------
   * SCORE
   * ---------------------------------------------------------------
   *
   * IMPORTANT:
   *
   * We intentionally DO NOT add verificationConfidencePct as a
   * scoring category here.
   *
   * Verification confidence measures how complete our data is.
   * It should not make the token itself look better or worse.
   *
   * Verification confidence is handled separately in watchlist.js
   * after the Helius/RugCheck stage.
   * ---------------------------------------------------------------
   */

  const score =
    possible > 0
      ? Math.round(clamp((points / possible) * 100))
      : 0;

  return {
    score,
    points,
    possible,
    liqMcPct: liqMc,

    // Kept for compatibility with the rest of the bot.
    verificationConfidencePct:
      Number(s.verificationConfidencePct) || 0,

    parts,
  };
}

module.exports = {
  scoreToken,
};
