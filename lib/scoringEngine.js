"use strict";

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const finite = (v) => Number.isFinite(Number(v));

function scoreToken(s) {
  const parts = [];
  let points = 0;
  let possible = 0;

  const add = (name, value, max, reason) => {
    if (value == null) return;
    points += value;
    possible += max;
    parts.push({ name, points: value, max, reason });
  };

  const liq = Number(s.liquidityUsd);
  if (finite(liq)) {
    const p = liq >= 100000 ? 15 : liq >= 50000 ? 13 : liq >= 20000 ? 10 : liq >= 10000 ? 7 : liq >= 5000 ? 4 : 0;
    add("Liquidity", p, 15, `$${Math.round(liq).toLocaleString()}`);
  }

  const vol = Number(s.volume24hUsd);
  if (finite(vol)) {
    const p = vol >= 250000 ? 12 : vol >= 100000 ? 10 : vol >= 50000 ? 8 : vol >= 15000 ? 5 : 2;
    add("24h volume", p, 12, `$${Math.round(vol).toLocaleString()}`);
  }

  const ratio = Number(s.buySellRatio24);
  if (finite(ratio)) add("Buy/sell flow", ratio >= 1.8 ? 12 : ratio >= 1.25 ? 9 : ratio >= 0.9 ? 6 : 2, 12, `${ratio.toFixed(2)}x`);

  const age = Number(s.tokenAgeSeconds);
  if (finite(age)) add("Age", age >= 900 ? 8 : age >= 300 ? 6 : age >= 120 ? 4 : 2, 8, `${Math.round(age / 60)}m`);

  const pc1 = Number(s.priceChange1hPct);
  if (finite(pc1)) add("1h momentum", pc1 >= 5 && pc1 <= 80 ? 10 : pc1 >= 0 ? 7 : pc1 >= -20 ? 3 : 0, 10, `${pc1.toFixed(1)}%`);

  const pc24 = Number(s.priceChange24hPct);
  if (finite(pc24)) add("24h momentum", pc24 >= 0 && pc24 <= 150 ? 8 : pc24 > 150 ? 3 : pc24 >= -25 ? 4 : 0, 8, `${pc24.toFixed(1)}%`);

  const holders = Number(s.holderCount);
  if (finite(holders)) add("Holders", holders >= 1000 ? 8 : holders >= 500 ? 6 : holders >= 200 ? 4 : holders >= 50 ? 2 : 0, 8, `${Math.round(holders)}`);

  const top = Number(s.topHolderPct);
  if (finite(top)) add("Top-holder concentration", top <= 20 ? 8 : top <= 30 ? 6 : top <= 45 ? 3 : 0, 8, `${top.toFixed(1)}%`);

  const liqMc = finite(s.marketCapUsd) && s.marketCapUsd > 0 && finite(liq) ? (liq / s.marketCapUsd) * 100 : null;
  if (liqMc != null) add("Liquidity / MC", liqMc >= 15 ? 7 : liqMc >= 8 ? 5 : liqMc >= 3 ? 3 : 0, 7, `${liqMc.toFixed(1)}%`);

  const mintSafe = s.mintAuthority == null;
  const freezeSafe = s.freezeAuthority == null;
  add("Mint authority", mintSafe ? 5 : 0, 5, mintSafe ? "renounced" : "active/unknown");
  add("Freeze authority", freezeSafe ? 5 : 0, 5, freezeSafe ? "renounced" : "active/unknown");
  add("Data completeness", Math.round(clamp(Number(s.verificationConfidencePct) || 0) / 10), 10, `${s.verificationConfidencePct ?? 0}% coverage`);

  const score = possible ? Math.round(clamp((points / possible) * 100)) : 0;
  return {
    score,
    points,
    possible,
    liqMcPct: liqMc,
    verificationConfidencePct: Number(s.verificationConfidencePct) || 0,
    parts,
  };
}

module.exports = { scoreToken };
