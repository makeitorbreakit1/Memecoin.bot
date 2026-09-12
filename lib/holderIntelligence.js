"use strict";

const { rpcCall, getHeliusTokenAccounts, getHeliusCreatorWallet } = require("./apiClient");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function rawToUi(raw, decimals) {
  const n = num(raw);
  if (n == null) return null;
  if (decimals == null) return n;
  return n / Math.pow(10, decimals);
}

function classifyHolderConcentration(top10Pct, top20Pct) {
  if (top10Pct == null) return "UNKNOWN";
  if (top10Pct > 60 || (top20Pct != null && top20Pct > 75)) return "EXTREME";
  if (top10Pct > 45 || (top20Pct != null && top20Pct > 60)) return "HIGH";
  if (top10Pct > 30 || (top20Pct != null && top20Pct > 45)) return "MODERATE";
  return "HEALTHY";
}

async function buildHolderIntelligence(address, opts = {}) {
  const decimals = num(opts.decimals) ?? 0;
  const totalSupply = num(opts.totalSupply);
  const pairAddress = opts.pairAddress || null;
  const rpcUrl = opts.rpcUrl || (opts.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}` : null);

  if (!opts.heliusApiKey && !rpcUrl) {
    return { available: false, reason: "No Helius/RPC configured" };
  }

  let accounts = [];
  try {
    accounts = await getHeliusTokenAccounts(address, opts.heliusApiKey, 20, rpcUrl);
  } catch (_) {
    accounts = [];
  }

  const byOwner = new Map();
  for (const account of accounts) {
    const owner = account?.owner;
    if (!owner) continue;
    const raw = account?.amount ?? account?.token_amount?.amount ?? account?.tokenAmount?.amount;
    const ui = account?.ui_amount ?? account?.token_amount?.ui_amount ?? account?.tokenAmount?.uiAmount ?? rawToUi(raw, decimals);
    const amount = num(ui);
    if (amount == null || amount <= 0) continue;
    const existing = byOwner.get(owner) || 0;
    byOwner.set(owner, existing + amount);
  }

  const holders = [...byOwner.entries()]
    .map(([owner, amount]) => ({
      owner,
      amount,
      pct: totalSupply > 0 ? (amount / totalSupply) * 100 : null,
    }))
    .sort((a, b) => b.amount - a.amount);

  // A pool/pair address can sometimes appear in token-account data. We don't
  // automatically remove all large accounts because that could hide legitimate whales.
  const filtered = holders.filter((h) => h.owner !== pairAddress);
  const top10 = filtered.slice(0, 10);
  const top20 = filtered.slice(0, 20);
  const top10Pct = totalSupply > 0 ? top10.reduce((s, h) => s + h.amount, 0) / totalSupply * 100 : null;
  const top20Pct = totalSupply > 0 ? top20.reduce((s, h) => s + h.amount, 0) / totalSupply * 100 : null;
  const largestHolderPct = filtered[0]?.pct ?? null;

  let creatorWallet = null;
  try {
    creatorWallet = await getHeliusCreatorWallet(address, opts.heliusApiKey, rpcUrl);
  } catch (_) {}

  const creatorHolder = creatorWallet ? filtered.find((h) => h.owner === creatorWallet) : null;

  return {
    available: filtered.length > 0,
    holderSampleSize: filtered.length,
    top10Pct: top10Pct == null ? null : Math.min(100, top10Pct),
    top20Pct: top20Pct == null ? null : Math.min(100, top20Pct),
    largestHolderPct: largestHolderPct == null ? null : Math.min(100, largestHolderPct),
    concentration: classifyHolderConcentration(top10Pct, top20Pct),
    topHolders: filtered.slice(0, 20),
    creatorWallet,
    creatorPct: creatorHolder?.pct ?? 0,
    creatorAmount: creatorHolder?.amount ?? 0,
    creatorHolding: !!creatorHolder,
  };
}

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

  const signals = [];
  const holderGrowthPct = previous?.holderCount > 0 && current.holderCount != null
    ? ((current.holderCount - previous.holderCount) / previous.holderCount) * 100
    : null;
  const top10ChangePct = previous?.top10Pct != null && current.top10Pct != null ? current.top10Pct - previous.top10Pct : null;
  const top20ChangePct = previous?.top20Pct != null && current.top20Pct != null ? current.top20Pct - previous.top20Pct : null;
  const creatorChangePct = previous?.creatorPct != null && current.creatorPct != null ? current.creatorPct - previous.creatorPct : null;

  const whaleSelling = top10ChangePct != null && top10ChangePct <= -3;
  const concentrationRising = top10ChangePct != null && top10ChangePct >= 4;
  const creatorSelling = creatorChangePct != null && previous.creatorPct >= 1 && creatorChangePct <= -1;
  const creatorDumping = creatorChangePct != null && previous.creatorPct >= 3 && creatorChangePct <= -2;

  if (holderGrowthPct != null && holderGrowthPct >= 25) signals.push(`Holder count surged ${holderGrowthPct.toFixed(0)}%`);
  if (whaleSelling) signals.push(`Top-10 concentration fell ${Math.abs(top10ChangePct).toFixed(1)} pts`);
  if (concentrationRising) signals.push(`Top-10 concentration rose ${top10ChangePct.toFixed(1)} pts`);
  if (creatorSelling) signals.push(`Creator wallet reduced its position ${Math.abs(creatorChangePct).toFixed(1)} pts`);
  if (creatorDumping) signals.push("Creator wallet is rapidly reducing its position");

  return {
    available: true,
    holderGrowthPct,
    top10ChangePct,
    top20ChangePct,
    creatorChangePct,
    whaleSelling,
    concentrationRising,
    creatorSelling,
    creatorDumping,
    suspiciousDistribution: creatorDumping || (whaleSelling && concentrationRising),
    signals,
  };
}

function classifyMarketBehavior({ snapshot, holderIntel, behavior }) {
  const reasons = [];
  let risk = 0;
  let longTerm = 0;

  const top10 = num(holderIntel?.top10Pct);
  const top20 = num(holderIntel?.top20Pct);
  const creatorPct = num(holderIntel?.creatorPct);
  const pc1 = num(snapshot?.priceChange1hPct);
  const pc5 = num(snapshot?.priceChange5mPct);
  const buySell = num(snapshot?.buySellRatio24);

  if (top10 != null) {
    if (top10 > 60) { risk += 35; reasons.push(`Top 10 wallets control ${top10.toFixed(1)}%`); }
    else if (top10 > 45) { risk += 24; reasons.push(`Top 10 wallets control ${top10.toFixed(1)}%`); }
    else if (top10 > 30) risk += 10;
    else longTerm += 15;
  }
  if (top20 != null && top20 <= 45) longTerm += 10;

  if (creatorPct != null) {
    if (creatorPct >= 8) { risk += 18; reasons.push(`Creator wallet still holds ${creatorPct.toFixed(1)}%`); }
    else if (creatorPct >= 3) { risk += 8; reasons.push(`Creator wallet holds ${creatorPct.toFixed(1)}%`); }
    else if (creatorPct < 1) longTerm += 8;
  }

  if (behavior?.creatorDumping) { risk += 35; reasons.push("Creator wallet is dumping/distributing"); }
  else if (behavior?.creatorSelling) { risk += 20; reasons.push("Creator wallet is reducing its position"); }
  if (behavior?.whaleSelling) { risk += 18; reasons.push("Large holders are distributing"); }
  if (behavior?.concentrationRising) { risk += 14; reasons.push("Whale concentration is increasing"); }

  if (behavior?.holderGrowthPct != null) {
    if (behavior.holderGrowthPct >= 40) longTerm += 12;
    else if (behavior.holderGrowthPct >= 15) longTerm += 7;
    else if (behavior.holderGrowthPct < -5) { risk += 12; reasons.push("Holder count is declining"); }
  }

  // A huge short-term move with weak buy/sell balance is treated as momentum
  // exhaustion, not proof of a rug.
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

module.exports = { buildHolderIntelligence, compareHolderSnapshots, classifyMarketBehavior };
