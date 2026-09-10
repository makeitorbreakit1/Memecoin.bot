"use strict";

const { rpcCall } = require("./apiClient");

async function fetchMintAuthorityStatus(address, rpcUrl) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const info = result?.value?.data?.parsed?.info;
  if (!info) return { available: false, mintAuthority: null, freezeAuthority: null };
  return {
    available: true,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    mintAuthorityRenounced: info.mintAuthority == null,
    freezeAuthorityRenounced: info.freezeAuthority == null,
  };
}

function riskLevelWeight(level) {
  const l = String(level || "").toLowerCase();
  if (l.includes("danger") || l.includes("critical") || l.includes("high")) return 18;
  if (l.includes("warn") || l.includes("medium")) return 8;
  return 2;
}

function assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport }) {
  let risk = 0;
  const reasons = [];

  const authorityKnown = mintAuthorityStatus?.available === true || snapshot.authorityDataAvailable === true;
  const mintActive = authorityKnown ? (mintAuthorityStatus?.available ? mintAuthorityStatus.mintAuthority != null : snapshot.mintAuthority != null) : null;
  const freezeActive = authorityKnown ? (mintAuthorityStatus?.available ? mintAuthorityStatus.freezeAuthority != null : snapshot.freezeAuthority != null) : null;

  if (mintActive === true) { risk += 24; reasons.push("Mint authority is active"); }
  if (freezeActive === true) { risk += 22; reasons.push("Freeze authority is active"); }
  if (!authorityKnown) reasons.push("Authority status unavailable");

  const top = snapshot.topHolderPct != null ? Number(snapshot.topHolderPct) : NaN;
  if (Number.isFinite(top)) {
    if (top > 60) { risk += 22; reasons.push(`Top holders control ${top.toFixed(1)}%`); }
    else if (top > 45) { risk += 14; reasons.push(`High holder concentration: ${top.toFixed(1)}%`); }
    else if (top > 30) { risk += 7; reasons.push(`Elevated holder concentration: ${top.toFixed(1)}%`); }
  }

  if (Number.isFinite(liqMcPct)) {
    if (liqMcPct < 2) { risk += 18; reasons.push("Very low liquidity relative to market cap"); }
    else if (liqMcPct < 5) { risk += 10; reasons.push("Low liquidity relative to market cap"); }
  }

  if (rugCheckReport) {
    const rcScore = Number(rugCheckReport.score_normalised ?? rugCheckReport.scoreNormalized ?? rugCheckReport.score);
    if (Number.isFinite(rcScore)) {
      // RugCheck's raw score can vary by schema; normalized 0-100 is preferred.
      const normalized = rcScore > 100 ? Math.min(100, rcScore / 10) : rcScore;
      if (normalized >= 70) { risk += 28; reasons.push(`RugCheck risk score is high (${normalized.toFixed(0)}/100)`); }
      else if (normalized >= 45) { risk += 15; reasons.push(`RugCheck shows elevated risk (${normalized.toFixed(0)}/100)`); }
      else if (normalized >= 25) { risk += 6; }
    }

    for (const item of Array.isArray(rugCheckReport.risks) ? rugCheckReport.risks.slice(0, 8) : []) {
      const w = riskLevelWeight(item?.level || item?.severity);
      risk += w;
      if (w >= 8 && item?.name) reasons.push(`RugCheck: ${item.name}`);
    }

    if (rugCheckReport.riskLevel && /danger|critical|high/i.test(rugCheckReport.riskLevel)) {
      risk += 15;
      reasons.push(`RugCheck risk level: ${rugCheckReport.riskLevel}`);
    }
  }

  if (snapshot.securityScore != null && Number(snapshot.securityScore) < 30) {
    risk += 8;
    reasons.push("Birdeye security signal is weak");
  }

  if (snapshot.liquidityUsd != null && Number(snapshot.liquidityUsd) < 5000) {
    risk += 8;
    reasons.push("Very thin liquidity");
  }

  const rugProbabilityPct = Math.max(0, Math.min(100, Math.round(risk)));
  return {
    rugProbabilityPct,
    riskLevel: rugProbabilityPct > 65 ? "HIGH" : rugProbabilityPct > 35 ? "MEDIUM" : "LOW",
    reasons: [...new Set(reasons)].slice(0, 8),
    mintAuthorityRenounced: authorityKnown ? !mintActive : null,
    freezeAuthorityRenounced: authorityKnown ? !freezeActive : null,
    rugCheckAvailable: !!rugCheckReport,
  };
}

module.exports = { fetchMintAuthorityStatus, assessRugRisk };
