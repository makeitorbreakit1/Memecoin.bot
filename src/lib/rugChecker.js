"use strict";

/**
 * rugChecker.js
 * ------------------------------------------------------------------
 * Produces a "rug pull probability" for a token by combining:
 *
 *   1. DETERMINISTIC on-chain facts — mint authority and freeze
 *      authority status, read directly from the SPL token mint
 *      account via Solana RPC. Either the authority is renounced
 *      (null) or it isn't (a pubkey). No guessing involved.
 *
 *   2. RugCheck.xyz's report — LP lock/burn status and holder-
 *      concentration analysis. This is a third-party heuristic, not
 *      something this bot verifies independently; treat it as
 *      "another opinion", not ground truth.
 *
 * IMPORTANT — what this does NOT do: this bot does not run its own
 * wallet-clustering / bundle-detection ("bubble map" style) analysis.
 * If neither on-chain check nor RugCheck's report is reachable, the
 * result is explicitly "Unknown — insufficient data", never a
 * default-to-safe 0%. A low probability here means "no red flags
 * found in what we checked", not "confirmed safe."
 * ------------------------------------------------------------------
 */

const { getSolanaAccountInfoParsed, getRugCheckReport } = require("./apiClient");

const RISK_WEIGHTS = {
  MINT_AUTHORITY_ACTIVE: 30, // dev can mint unlimited new supply
  FREEZE_AUTHORITY_ACTIVE: 20, // dev can freeze any holder's wallet
  RUGCHECK_FLAGGED_RUGGED: 90, // RugCheck has already flagged this token as rugged
  RUGCHECK_RISK_DANGER: 15, // per "danger"-level item in RugCheck's risks[], capped
  RUGCHECK_RISK_WARN: 7, // per "warn"-level item in RugCheck's risks[], capped
  RUGCHECK_RISK_CAP: 45, // max combined points from RugCheck risks[] items
  LP_LOCKED_LOW: 20, // RugCheck reports LP locked/burned % below LP_LOCK_HEALTHY_MIN
  THIN_LIQUIDITY: 15, // liquidity/MC ratio at or below the "thin" threshold
  VERY_LOW_TRADES: 5, // barely any trading activity yet (higher uncertainty)
};

const LP_LOCK_HEALTHY_MIN = 80; // percent locked/burned considered reasonably safe
const THIN_LIQUIDITY_MC_PCT = 3; // matches scoringEngine's LIQ_MC_LOW_MAX

// Minimum fraction of our data sources that must have resolved before we're
// willing to state a probability at all, rather than "Unknown".
const MIN_DATA_COVERAGE = 0.34; // at least ~1 of 3 sources (mint auth / freeze auth / rugcheck)

/**
 * Read mint & freeze authority directly from the SPL token mint account.
 * Returns `{ resolved: false }` on any failure so callers can treat it
 * as "unavailable" rather than crashing or assuming an answer.
 */
async function fetchMintAuthorityStatus(mintAddress, rpcUrl) {
  if (!rpcUrl) return { resolved: false, reason: "no RPC URL configured" };
  try {
    const accountInfo = await getSolanaAccountInfoParsed(mintAddress, rpcUrl);
    const parsedInfo = accountInfo?.data?.parsed?.info;
    if (!parsedInfo || typeof parsedInfo !== "object") {
      return { resolved: false, reason: "unexpected RPC response shape" };
    }
    return {
      resolved: true,
      // SPL token mint layout: these are `null` when renounced, a pubkey string otherwise.
      mintAuthorityRenounced: parsedInfo.mintAuthority == null,
      freezeAuthorityRenounced: parsedInfo.freezeAuthority == null,
    };
  } catch (err) {
    console.warn(`[rugChecker] Mint authority lookup failed for ${mintAddress}: ${err.message}`);
    return { resolved: false, reason: err.message };
  }
}

/** Extract a normalized subset of fields we care about from a RugCheck report, defensively. */
function normalizeRugCheckReport(report) {
  if (!report || typeof report !== "object") return { resolved: false };

  const risks = Array.isArray(report.risks) ? report.risks : [];
  const dangerCount = risks.filter((r) => r?.level === "danger").length;
  const warnCount = risks.filter((r) => r?.level === "warn").length;

  const rugged = typeof report.rugged === "boolean" ? report.rugged : null;

  // Different RugCheck response versions nest LP info differently — check
  // a couple of plausible shapes and fall back to "unknown" rather than
  // guessing a number.
  const lpLockedPct =
    typeof report.markets?.[0]?.lp?.lpLockedPct === "number"
      ? report.markets[0].lp.lpLockedPct
      : typeof report.lpLockedPct === "number"
      ? report.lpLockedPct
      : null;

  const anyFieldResolved = rugged !== null || risks.length > 0 || lpLockedPct !== null;

  return {
    resolved: anyFieldResolved,
    rugged,
    dangerCount,
    warnCount,
    lpLockedPct,
    riskNames: risks.map((r) => r?.name).filter(Boolean),
  };
}

/**
 * Combine all available signals into a single rug-risk assessment.
 * Pure function — no I/O — so it's easy to test against fixtures.
 *
 * @param {object} params
 * @param {object} params.snapshot - TokenSnapshot (for liquidity/MC + trade count context)
 * @param {number|null} params.liqMcPct - liquidity/MC percentage from scoreToken()'s result
 * @param {object} params.mintAuthorityStatus - from fetchMintAuthorityStatus()
 * @param {object|null} params.rugCheckReport - raw report from getRugCheckReport(), or null
 * @returns {object} RugAssessment
 */
function assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport }) {
  const rc = normalizeRugCheckReport(rugCheckReport);

  const sourcesChecked = [mintAuthorityStatus.resolved, rc.resolved];
  const dataCoveragePct = Math.round(
    (sourcesChecked.filter(Boolean).length / sourcesChecked.length) * 100
  );

  const flags = [];
  const unresolvedNotes = [];
  let riskPoints = 0;

  // --- Deterministic on-chain checks --------------------------------------
  if (mintAuthorityStatus.resolved) {
    if (!mintAuthorityStatus.mintAuthorityRenounced) {
      riskPoints += RISK_WEIGHTS.MINT_AUTHORITY_ACTIVE;
      flags.push("⚠ Mint authority NOT renounced — supply can be inflated at will");
    }
    if (!mintAuthorityStatus.freezeAuthorityRenounced) {
      riskPoints += RISK_WEIGHTS.FREEZE_AUTHORITY_ACTIVE;
      flags.push("⚠ Freeze authority NOT renounced — holder wallets can be frozen");
    }
  } else {
    unresolvedNotes.push("mint/freeze authority (RPC unavailable)");
  }

  // --- RugCheck.xyz report --------------------------------------------------
  if (rc.resolved) {
    if (rc.rugged === true) {
      riskPoints += RISK_WEIGHTS.RUGCHECK_FLAGGED_RUGGED;
      flags.push("⚠ RugCheck has already flagged this token as rugged");
    }
    const rugCheckRiskPoints = Math.min(
      RISK_WEIGHTS.RUGCHECK_RISK_CAP,
      rc.dangerCount * RISK_WEIGHTS.RUGCHECK_RISK_DANGER + rc.warnCount * RISK_WEIGHTS.RUGCHECK_RISK_WARN
    );
    if (rugCheckRiskPoints > 0) {
      riskPoints += rugCheckRiskPoints;
      flags.push(
        `RugCheck flagged ${rc.dangerCount} danger + ${rc.warnCount} warning issue(s)` +
          (rc.riskNames.length ? ` (${rc.riskNames.slice(0, 3).join(", ")})` : "")
      );
    }
    if (rc.lpLockedPct != null) {
      if (rc.lpLockedPct < LP_LOCK_HEALTHY_MIN) {
        riskPoints += RISK_WEIGHTS.LP_LOCKED_LOW;
        flags.push(`⚠ Only ${rc.lpLockedPct.toFixed(0)}% of LP is locked/burned`);
      }
    } else {
      unresolvedNotes.push("LP lock/burn percentage (not in RugCheck response)");
    }
  } else {
    unresolvedNotes.push("RugCheck report (unavailable)");
  }

  // --- Structural signals we already have from the snapshot ----------------
  if (liqMcPct != null && liqMcPct <= THIN_LIQUIDITY_MC_PCT) {
    riskPoints += RISK_WEIGHTS.THIN_LIQUIDITY;
    flags.push(`⚠ Thin liquidity/MC ratio (${liqMcPct.toFixed(1)}%) — cheap to drain`);
  }
  if (snapshot.totalTrades != null && snapshot.totalTrades < 10) {
    riskPoints += RISK_WEIGHTS.VERY_LOW_TRADES;
    flags.push("Very low trade count — limited signal either way");
  }

  riskPoints = Math.min(100, riskPoints);

  // If we couldn't check enough sources, don't report a false "low risk" —
  // be explicit that this is unassessed rather than confirmed safe.
  if (dataCoveragePct < MIN_DATA_COVERAGE * 100) {
    return {
      rugProbabilityPct: null,
      riskLevel: "Unknown",
      flags: flags.length ? flags : ["Insufficient data to assess rug risk"],
      unresolvedNotes,
      dataCoveragePct,
    };
  }

  let riskLevel;
  if (riskPoints >= 60) riskLevel = "High";
  else if (riskPoints >= 30) riskLevel = "Moderate";
  else riskLevel = "Low";

  if (flags.length === 0) {
    flags.push("No rug-risk red flags found in the checks that were available");
  }

  return {
    rugProbabilityPct: riskPoints,
    riskLevel,
    flags,
    unresolvedNotes,
    dataCoveragePct,
  };
}

module.exports = { fetchMintAuthorityStatus, assessRugRisk, normalizeRugCheckReport };
