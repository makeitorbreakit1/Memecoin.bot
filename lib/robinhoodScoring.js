"use strict";

function clamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function scoreRobinhoodToken(s) {
  const parts = [];
  let points = 0;
  const possible = 100;
  const add = (name, pts, reason) => { points += pts; parts.push({ name, points: pts, max: 20, reason }); };

  const liq = num(s.liquidityUsd) || 0;
  const mc = num(s.marketCapUsd) || 0;
  const vol = num(s.volume24hUsd) || 0;
  const holders = num(s.holderCount);
  const age = num(s.tokenAgeSeconds);
  const bs = num(s.buySellRatio24);
  const pc1 = num(s.priceChange1hPct);
  const top10 = num(s.top10Pct);

  if (liq >= 100000) add("Liquidity", 20, `$${Math.round(liq).toLocaleString()} liquidity`);
  else if (liq >= 50000) add("Liquidity", 16, `$${Math.round(liq).toLocaleString()} liquidity`);
  else if (liq >= 25000) add("Liquidity", 12, `$${Math.round(liq).toLocaleString()} liquidity`);
  else if (liq >= 10000) add("Liquidity", 8, `$${Math.round(liq).toLocaleString()} liquidity`);
  else add("Liquidity", 0, "Below preferred liquidity");

  const liqMc = mc > 0 ? (liq / mc) * 100 : 0;
  if (liqMc >= 15) add("Liquidity / MC", 15, `${liqMc.toFixed(1)}% liquidity-to-MC`);
  else if (liqMc >= 8) add("Liquidity / MC", 11, `${liqMc.toFixed(1)}% liquidity-to-MC`);
  else if (liqMc >= 4) add("Liquidity / MC", 7, `${liqMc.toFixed(1)}% liquidity-to-MC`);
  else add("Liquidity / MC", 2, `${liqMc.toFixed(1)}% liquidity-to-MC`);

  if (holders != null) {
    if (holders >= 500) add("Holders", 15, `${holders.toLocaleString()} holders`);
    else if (holders >= 200) add("Holders", 12, `${holders.toLocaleString()} holders`);
    else if (holders >= 75) add("Holders", 8, `${holders.toLocaleString()} holders`);
    else if (holders >= 25) add("Holders", 5, `${holders.toLocaleString()} holders`);
    else add("Holders", 0, `${holders.toLocaleString()} holders`);
  } else add("Holders", 0, "Holder count unavailable");

  if (vol >= 1000000) add("Volume", 15, `$${Math.round(vol).toLocaleString()} 24h volume`);
  else if (vol >= 250000) add("Volume", 12, `$${Math.round(vol).toLocaleString()} 24h volume`);
  else if (vol >= 75000) add("Volume", 8, `$${Math.round(vol).toLocaleString()} 24h volume`);
  else if (vol >= 20000) add("Volume", 5, `$${Math.round(vol).toLocaleString()} 24h volume`);
  else add("Volume", 0, "Weak 24h volume");

  if (bs != null) {
    if (bs >= 1.5 && bs <= 5) add("Buy pressure", 10, `${bs.toFixed(2)}x buys/sells`);
    else if (bs >= 1.1) add("Buy pressure", 7, `${bs.toFixed(2)}x buys/sells`);
    else if (bs >= 0.8) add("Buy pressure", 4, `${bs.toFixed(2)}x buys/sells`);
    else add("Buy pressure", 0, `${bs.toFixed(2)}x buys/sells`);
  } else add("Buy pressure", 0, "Trade-flow data unavailable");

  if (pc1 != null) {
    if (pc1 >= 5 && pc1 <= 80) add("Momentum", 10, `${pc1.toFixed(1)}% 1h`);
    else if (pc1 >= 0) add("Momentum", 6, `${pc1.toFixed(1)}% 1h`);
    else if (pc1 > -15) add("Momentum", 3, `${pc1.toFixed(1)}% 1h`);
    else add("Momentum", 0, `${pc1.toFixed(1)}% 1h`);
  } else add("Momentum", 0, "1h momentum unavailable");

  if (age != null) {
    if (age <= 3600) add("Freshness", 10, `${Math.round(age / 60)}m old`);
    else if (age <= 21600) add("Freshness", 7, `${(age / 3600).toFixed(1)}h old`);
    else add("Freshness", 2, `${(age / 86400).toFixed(1)}d old`);
  } else add("Freshness", 0, "Launch time unavailable");

  const social = s.launch || {};
  const socialPts = (social.twitter ? 2 : 0) + (social.website ? 2 : 0) + (social.telegram ? 1 : 0);
  add("Social", socialPts, socialPts >= 4 ? "Twitter/X + website + Telegram" : socialPts >= 2 ? "Social/website presence" : "Limited social evidence");

  return {
    score: Math.round(clamp(points)),
    points,
    possible,
    liqMcPct: liqMc,
    verificationConfidencePct: Number(s.verificationConfidencePct) || 0,
    parts,
  };
}

module.exports = { scoreRobinhoodToken };
