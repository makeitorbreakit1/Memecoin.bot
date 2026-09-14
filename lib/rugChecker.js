"use strict";

const { rpcCall } = require("./apiClient");

async function fetchMintAuthorityStatus(address, rpcUrl) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);

  const info = result?.value?.data?.parsed?.info;

  if (!info) {
    return {
      available: false,
      mintAuthority: null,
      freezeAuthority: null,
      mintAuthorityRenounced: null,
      freezeAuthorityRenounced: null,
    };
  }

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

  if (
    l.includes("danger") ||
    l.includes("critical") ||
    l.includes("high")
  ) {
    return 18;
  }

  if (
    l.includes("warn") ||
    l.includes("medium")
  ) {
    return 8;
  }

  return 2;
}

function assessRugRisk({
  snapshot,
  liqMcPct,
  mintAuthorityStatus,
  rugCheckReport,
}) {
  let risk = 0;
  const reasons = [];

  const authorityKnown =
    mintAuthorityStatus?.available === true ||
    snapshot.authorityDataAvailable === true;

  const mintActive = authorityKnown
    ? (
        mintAuthorityStatus?.available
          ? mintAuthorityStatus.mintAuthority != null
          : snapshot.mintAuthority != null
      )
    : null;

  const freezeActive = authorityKnown
    ? (
        mintAuthorityStatus?.available
          ? mintAuthorityStatus.freezeAuthority != null
          : snapshot.freezeAuthority != null
      )
    : null;

  /*
   * Hard safety penalties.
   */

  if (mintActive === true) {
    risk += 35;
    reasons.push("Mint authority is active");
  }

  if (freezeActive === true) {
    risk += 35;
    reasons.push("Freeze authority is active");
  }

  if (!authorityKnown) {
    reasons.push("Authority status unavailable");
    risk += 20;
  }

  /*
   * Holder concentration.
   */

  const top = Number(snapshot.topHolderPct);

  if (Number.isFinite(top)) {
    if (top > 60) {
      risk += 40;
      reasons.push(`Top holders control ${top.toFixed(1)}%`);
    } else if (top > 45) {
      risk += 28;
      reasons.push(`High holder concentration: ${top.toFixed(1)}%`);
    } else if (top > 40) {
      risk += 18;
      reasons.push(`Elevated holder concentration: ${top.toFixed(1)}%`);
    } else if (top > 30) {
      risk += 8;
      reasons.push(`Moderate holder concentration: ${top.toFixed(1)}%`);
    }
  } else {
    risk += 10;
    reasons.push("Top-holder data unavailable");
  }

  /*
   * Liquidity relative to market cap.
   */

  if (Number.isFinite(liqMcPct)) {
    if (liqMcPct < 2) {
      risk += 25;
      reasons.push("Very low liquidity relative to market cap");
    } else if (liqMcPct < 5) {
      risk += 12;
      reasons.push("Low liquidity relative to market cap");
    }
  }

  /*
   * RugCheck.
   */

  if (!rugCheckReport) {
    risk += 20;
    reasons.push("RugCheck unavailable");
  } else {
    const rcScore = Number(
      rugCheckReport.score_normalised ??
      rugCheckReport.scoreNormalized ??
      rugCheckReport.score
    );

    if (Number.isFinite(rcScore)) {
      const normalized =
        rcScore > 100
          ? Math.min(100, rcScore / 10)
          : rcScore;

      if (normalized >= 70) {
        risk += 35;
        reasons.push(
          `RugCheck risk score is high (${normalized.toFixed(0)}/100)`
        );
      } else if (normalized >= 45) {
        risk += 18;
        reasons.push(
          `RugCheck shows elevated risk (${normalized.toFixed(0)}/100)`
        );
      } else if (normalized >= 25) {
        risk += 6;
      }
    }

    for (
      const item of Array.isArray(rugCheckReport.risks)
        ? rugCheckReport.risks.slice(0, 8)
        : []
    ) {
      const weight = riskLevelWeight(
        item?.level || item?.severity
      );

      risk += weight;

      if (weight >= 8 && item?.name) {
        reasons.push(`RugCheck: ${item.name}`);
      }
    }

    if (
      rugCheckReport.riskLevel &&
      /danger|critical|high/i.test(
        rugCheckReport.riskLevel
      )
    ) {
      risk += 20;
      reasons.push(
        `RugCheck risk level: ${rugCheckReport.riskLevel}`
      );
    }
  }

  /*
   * Thin liquidity.
   */

  const liquidity = Number(snapshot.liquidityUsd);

  if (Number.isFinite(liquidity)) {
    if (liquidity < 5000) {
      risk += 25;
      reasons.push("Very thin liquidity");
    } else if (liquidity < 7500) {
      risk += 10;
      reasons.push("Low liquidity");
    }
  }

  const rugProbabilityPct = Math.max(
    0,
    Math.min(100, Math.round(risk))
  );

  let riskLevel = "LOW";

  if (rugProbabilityPct > 65) {
    riskLevel = "HIGH";
  } else if (rugProbabilityPct > 35) {
    riskLevel = "MEDIUM";
  }

  return {
    rugProbabilityPct,
    riskLevel,
    reasons: [...new Set(reasons)].slice(0, 8),

    mintAuthorityRenounced:
      authorityKnown ? !mintActive : null,

    freezeAuthorityRenounced:
      authorityKnown ? !freezeActive : null,

    rugCheckAvailable:
      !!rugCheckReport,
  };
}

module.exports = {
  fetchMintAuthorityStatus,
  assessRugRisk,
};
