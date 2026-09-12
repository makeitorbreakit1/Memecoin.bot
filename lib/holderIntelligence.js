"use strict";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function compareHolderSnapshots(previous, current) {
  if (!current?.available) {
    return {
      available: false,
      holderGrowthPct: null,
      top10ChangePct: null,
      top20ChangePct: null,
      creatorChangePct: null,
      whaleSelling: false,
      creatorSelling: false,
      suspiciousDistribution: false,
      signals: [],
    };
  }

  const holderGrowthPct = previous?.holderCount > 0 && current.holderCount != null
    ? ((current.holderCount - previous.holderCount) / previous.holderCount) * 100
    : null;
  const top10ChangePct = previous?.top10Pct != null && current.top10Pct != null
    ? current.top10Pct - previous.top10Pct
    : null;
  const top20ChangePct = previous?.top20Pct != null && current.top20Pct != null
    ? current.top20Pct - previous.top20Pct
    : null;
  const creatorChangePct = previous?.creatorPct != null && current.creatorPct != null
    ? current.creatorPct - previous.creatorPct
    : null;

  return {
    available: true,
    holderGrowthPct,
    top10ChangePct,
    top20ChangePct,
    creatorChangePct,
    whaleSelling: top10ChangePct != null && top10ChangePct <= -3,
    concentrationRising: top10ChangePct != null && top10ChangePct >= 4,
    creatorSelling: creatorChangePct != null && previous.creatorPct >= 1 && creatorChangePct <= -1,
    creatorDumping: creatorChangePct != null && previous.creatorPct >= 3 && creatorChangePct <= -2,
    suspiciousDistribution: false,
    signals: [],
  };
}

function classifyMarketBehavior({ snapshot, holderIntel, behavior }) {
  const reasons = [];
  let risk = 0;
  let longTerm = 0;

  const top10 = num(holderIntel?.top10Pct ?? snapshot?.topHolderPct);
  const pc1 = num(snapshot?.priceChange1hPct);
  const pc5 = num(snapshot?.priceChange5mPct);
  const buySell = num(snapshot?.buySellRatio24);

  if (top10 != null) {
    if (top10 > 60) { risk += 35; reasons.push(`Top holders control ${top10.toFixed(1)}%`); }
    else if (top10 > 45) { risk += 24; reasons.push(`Top holders control ${top10.toFixed(1)}%`); }
    else if (top10 > 30) risk += 10;
    else longTerm += 15;
  }

  if (behavior?.whaleSelling) { risk += 18; reasons.push("Large holders are distributing"); }
  if (behavior?.concentrationRising) { risk += 14; reasons.push("Whale concentration is increasing"); }
  if (behavior?.creatorDumping) { risk += 35; reasons.push("Creator wallet is dumping/distributing"); }

  if (pc1 != null && pc1 > 100) { risk += 18; reasons.push(`Extreme 1h price expansion: ${pc1.toFixed(0)}%`); }
  if (pc5 != null && pc5 < -15) { risk += 15; reasons.push(`5m price reversal: ${pc5.toFixed(1)}%`); }
  if (buySell != null && buySell < 0.75) { risk += 10; reasons.push(`Sell-heavy flow: ${buySell.toFixed(2)}x`); }
  if (buySell != null && buySell >= 1.5) longTerm += 5;

  let classification = "SPECULATIVE";
  if (risk >= 65) classification = "PUMP_AND_DUMP_RISK_HIGH";
  else if (risk >= 40) classification = "PUMP_AND_DUMP_RISK_MEDIUM";
  else if (longTerm >= 25 && risk < 20) classification = "LONG_TERM_NARRATIVE_CANDIDATE";
  else if (longTerm >= 15 && risk < 30) classification = "HEALTHY_MOMENTUM";

  return {
    classification,
    riskScore: Math.max(0, Math.min(100, risk)),
    longTermScore: Math.max(0, Math.min(100, longTerm)),
    reasons: [...new Set(reasons)].slice(0, 8),
  };
}

function buildHolderIntelligence() {
  return {
    available: false,
    reason: "Detailed holder intelligence disabled; standard Helius RPC is used for top-holder concentration only",
  };
}

module.exports = { buildHolderIntelligence, compareHolderSnapshots, classifyMarketBehavior };
