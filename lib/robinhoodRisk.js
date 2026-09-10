"use strict";

function clamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function num(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function assessRobinhoodRisk(s) {
  let risk = 0;
  const reasons = [];
  const c = s.contract || {};
  const top10 = num(s.top10Pct);
  const largest = num(s.largestHolderPct);
  const liq = num(s.liquidityUsd) || 0;
  const holders = num(s.holderCount);
  const score = num(s.dataQualityScore) || 0;

  // Launchpad direct-v3 launches are expected to be factory-created with locked LP.
  if (String(s.launchFactory || "").toLowerCase() !== "0xfb21934bb01b4d7b83beb8af6e6fd553f049e632") {
    risk += 25; reasons.push("Launch factory does not match the known Robinhood launchpad factory");
  }
  if (!s.authorityDataAvailable) { risk += 20; reasons.push("Contract checks unavailable"); }
  if (c.ownerActive) { risk += 12; reasons.push("Contract exposes an active owner() address"); }
  if (c.paused === true) { risk += 15; reasons.push("Token contract is currently paused"); }
  if (top10 != null) {
    if (top10 > 70) { risk += 30; reasons.push(`Top 10 holders control ${top10.toFixed(1)}%`); }
    else if (top10 > 55) { risk += 20; reasons.push(`Top 10 holders control ${top10.toFixed(1)}%`); }
    else if (top10 > 40) { risk += 10; reasons.push(`Top 10 holders control ${top10.toFixed(1)}%`); }
  } else { risk += 10; reasons.push("Top-holder distribution unavailable"); }
  if (largest != null && largest > 25) { risk += 15; reasons.push(`Largest holder controls ${largest.toFixed(1)}%`); }
  if (liq < 10000) { risk += 25; reasons.push("Liquidity is below $10K"); }
  else if (liq < 25000) risk += 8;
  if (holders != null && holders < 25) { risk += 15; reasons.push(`Only ${holders} holders`); }
  if (score < 70) risk += 10;

  return {
    rugProbabilityPct: Math.round(clamp(risk)),
    riskScore: Math.round(clamp(risk)),
    reasons: [...new Set(reasons)].slice(0, 8),
    rugCheckAvailable: false,
    methodology: "Robinhood launchpad + EVM contract + holder concentration + DEX liquidity checks",
  };
}

module.exports = { assessRobinhoodRisk };
