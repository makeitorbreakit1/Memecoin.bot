"use strict";

/**
 * scoringEngine.js
 * ------------------------------------------------------------------
 * Pure functions — no I/O. Takes a TokenSnapshot in, returns a
 * ScoreResult out. Keeping this side-effect-free makes the rules
 * easy to unit test and tune independently of the Discord/API layers.
 *
 * This is a heuristic filter, not a prediction of price movement.
 * It structurally screens for *some* signals often associated with
 * healthier early liquidity conditions (real liquidity relative to
 * cap, active two-sided trading, plausible age window). It cannot
 * detect rug pulls, wash trading, or insider dumping without deeper
 * data — that's exactly why "Verification confidence" exists: to be
 * honest about what wasn't checked.
 * ------------------------------------------------------------------
 */

const { TRACKED_FIELDS } = require("./snapshotBuilder");

// ---- Tunable thresholds -------------------------------------------------
const THRESHOLDS = {
  // Liquidity / MC ratio bands (percent)
  LIQ_MC_HEALTHY_MIN: 8, // >= this is considered structurally sound
  LIQ_MC_LOW_MAX: 3, // <= this is a red flag (thin liquidity vs cap)

  // Volume / MC multiplier
  VOL_MC_HOT_MIN: 1.5, // 24h volume >= 1.5x market cap => strong activity

  // Buy share (buys / total trades)
  BUY_SHARE_STRONG_MIN: 0.55,
  BUY_SHARE_WEAK_MAX: 0.40,

  // Market cap "zones" — purely descriptive labels for common
  // memecoin lifecycle stages, not investment thresholds.
  MC_PRIME_MIN: 15_000,
  MC_PRIME_MAX: 150_000,
  MC_SECONDARY_MIN: 150_000,
  MC_SECONDARY_MAX: 1_500_000,

  // Age window (seconds)
  VERY_EARLY_MAX_AGE: 900, // 15 min

  // Price acceleration (5m change, percent)
  PRICE_ACCEL_MIN_PCT: 15,
};

function pct(numerator, denominator) {
  if (!denominator || denominator === 0 || numerator == null) return null;
  return (numerator / denominator) * 100;
}

function ratio(numerator, denominator) {
  if (!denominator || denominator === 0 || numerator == null) return null;
  return numerator / denominator;
}

function formatAge(seconds) {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Classify market cap into a rough lifecycle "zone" label. */
function classifyMcZone(mc) {
  if (mc == null) return null;
  if (mc >= THRESHOLDS.MC_PRIME_MIN && mc <= THRESHOLDS.MC_PRIME_MAX) return "prime MC";
  if (mc > THRESHOLDS.MC_SECONDARY_MIN && mc <= THRESHOLDS.MC_SECONDARY_MAX) return "secondary MC";
  if (mc < THRESHOLDS.MC_PRIME_MIN) return "sub-prime MC";
  return "extended MC";
}

/**
 * Core scoring function.
 * @param {object} snapshot - TokenSnapshot from snapshotBuilder
 * @returns {object} ScoreResult
 */
function scoreToken(snapshot) {
  const liqMcPct = pct(snapshot.liquidityUsd, snapshot.marketCap);
  const volMcMultiplier = ratio(snapshot.volume24hUsd, snapshot.marketCap);
  const buyShare =
    snapshot.buys != null && snapshot.totalTrades ? snapshot.buys / snapshot.totalTrades : null;

  const reasons = [];
  let score = 0;

  // --- Liquidity health -------------------------------------------------
  if (liqMcPct != null) {
    if (liqMcPct >= THRESHOLDS.LIQ_MC_HEALTHY_MIN) {
      score += 20;
      reasons.push(`Healthy liquidity/MC ratio (${liqMcPct.toFixed(1)}%)`);
    } else if (liqMcPct <= THRESHOLDS.LIQ_MC_LOW_MAX) {
      score -= 15;
      reasons.push(`⚠ Thin liquidity/MC ratio (${liqMcPct.toFixed(1)}%)`);
    }
  }

  // --- Volume activity ----------------------------------------------------
  if (volMcMultiplier != null && volMcMultiplier >= THRESHOLDS.VOL_MC_HOT_MIN) {
    score += 20;
    reasons.push(`Volume/MC multiplier is hot (${volMcMultiplier.toFixed(2)}x)`);
  }

  // --- Buy pressure -------------------------------------------------------
  if (buyShare != null) {
    if (buyShare >= THRESHOLDS.BUY_SHARE_STRONG_MIN) {
      score += 15;
      reasons.push(`Strong buy share (${(buyShare * 100).toFixed(0)}% buys)`);
    } else if (buyShare <= THRESHOLDS.BUY_SHARE_WEAK_MAX) {
      score -= 10;
      reasons.push(`⚠ Sell-heavy flow (${(buyShare * 100).toFixed(0)}% buys)`);
    }
  }

  // --- MC zone classification ---------------------------------------------
  const mcZone = classifyMcZone(snapshot.marketCap);
  if (mcZone === "prime MC" || mcZone === "secondary MC") {
    score += 10;
    reasons.push(`${mcZone === "prime MC" ? "Prime" : "Secondary"} MC zone ($${Math.round(snapshot.marketCap).toLocaleString()})`);
  }

  // --- Age ------------------------------------------------------------------
  if (snapshot.tokenAgeSeconds != null) {
    if (snapshot.tokenAgeSeconds <= THRESHOLDS.VERY_EARLY_MAX_AGE) {
      score += 10;
      reasons.push(`Very early (${formatAge(snapshot.tokenAgeSeconds)} old)`);
    }
  }

  // --- Price acceleration -----------------------------------------------
  if (snapshot.priceChange5m != null && snapshot.priceChange5m >= THRESHOLDS.PRICE_ACCEL_MIN_PCT) {
    score += 15;
    reasons.push(`Price acceleration (+${snapshot.priceChange5m.toFixed(1)}% / 5m)`);
  }

  // --- Trade count floor (basic activity sanity check) --------------------
  if (snapshot.totalTrades != null && snapshot.totalTrades < 10) {
    score -= 10;
    reasons.push(`⚠ Very low trade count (${snapshot.totalTrades})`);
  }

  // Clamp 0–100
  score = Math.max(0, Math.min(100, score));

  // --- Verification confidence ---------------------------------------------
  // Percentage of tracked fields that were actually resolved from a
  // live source. This is a data-completeness measure, not a
  // legitimacy guarantee — see disclaimer in messageFormatter.js.
  const resolvedCount = TRACKED_FIELDS.length - snapshot.missingFields.length;
  const verificationConfidencePct = Math.round((resolvedCount / TRACKED_FIELDS.length) * 100);

  if (reasons.length === 0) {
    reasons.push("No strong structural signals met — insufficient data or neutral profile");
  }

  return {
    score,
    liqMcPct,
    volMcMultiplier,
    buyShare,
    mcZone,
    reasons,
    verificationConfidencePct,
    missingFields: snapshot.missingFields,
  };
}

module.exports = { scoreToken, classifyMcZone, formatAge, THRESHOLDS };
