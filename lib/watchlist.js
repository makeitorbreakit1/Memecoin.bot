"use strict";

const {
  discoverNewTokens,
  discoverEarlyLaunchSignals,
  getRugCheckReport,
  getTokenHolderCount,
} = require("./apiClient");

const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");

const {
  fetchMintAuthorityStatus,
  assessRugRisk,
} = require("./rugChecker");

const {
  compareHolderSnapshots,
  classifyMarketBehavior,
} = require("./holderIntelligence");

class Watchlist {
  constructor(opts = {}) {
    this.minAgeSeconds =
      opts.minAgeSeconds ?? 120;

    this.maxAgeSeconds =
      opts.maxAgeSeconds ?? 21600;

    // Higher-quality alert threshold.
    this.minScore =
      opts.minScore ?? 78;

    this.cheapFilterScore =
      opts.cheapFilterScore ?? 65;

    this.minVerificationConfidencePct =
      opts.minVerificationConfidencePct ?? 88;

    this.maxRugProbabilityPct =
      opts.maxRugProbabilityPct ?? 20;

    this.minLiquidityUsd =
      opts.minLiquidityUsd ?? 15000;

    this.requireRugCheck =
      opts.requireRugCheck ?? true;

    this.requireAuthorityData =
      opts.requireAuthorityData ?? true;

    // Prevent Discord flooding.
    this.maxAlertsPerCycle =
      opts.maxAlertsPerCycle ?? 2;

    this.maxAlertsPerHour =
      opts.maxAlertsPerHour ?? 6;

    this.heliusApiKey =
      opts.heliusApiKey;

    this.rpcUrl =
      opts.rpcUrl;

    this.rugcheckApiKey =
      opts.rugcheckApiKey;

    this.onAlert =
      opts.onAlert ?? (async () => {});

    this.onError =
      opts.onError ?? (() => {});

    this.alertedMints =
      new Set();

    this.earlySignals =
      new Map();

    this.behaviorHistory =
      new Map();

    this.alertTimestamps =
      [];
  }

  // ---------------------------------------------------------------------------
  // ALERT RATE LIMIT
  // ---------------------------------------------------------------------------

  _cleanupAlertTimestamps() {
    const oneHourAgo =
      Date.now() -
      60 * 60 * 1000;

    this.alertTimestamps =
      this.alertTimestamps.filter(
        (timestamp) =>
          timestamp > oneHourAgo
      );
  }

  _canSendAlert() {
    this._cleanupAlertTimestamps();

    return (
      this.alertTimestamps.length <
      this.maxAlertsPerHour
    );
  }

  _recordAlert() {
    this._cleanupAlertTimestamps();

    this.alertTimestamps.push(
      Date.now()
    );
  }

  _alertsThisCycle(
    cycleStartedAt
  ) {
    return this.alertTimestamps.filter(
      (timestamp) =>
        timestamp >= cycleStartedAt
    ).length;
  }

  // ---------------------------------------------------------------------------
  // HOLDER COUNT
  // ---------------------------------------------------------------------------

  async _attachHolderCount(
    address,
    snapshot
  ) {
    try {
      const holderCount =
        await getTokenHolderCount(
          address,
          this.heliusApiKey
        );

      if (
        holderCount != null
      ) {
        snapshot.holderCount =
          holderCount;

        if (
          snapshot.metrics &&
          typeof snapshot.metrics ===
            "object"
        ) {
          snapshot.metrics.holderCount =
            holderCount;
        }

        console.log(
          `[holders] ${address}: ${holderCount.toLocaleString()} holders`
        );
      } else {
        snapshot.holderCount =
          null;

        console.log(
          `[holders] ${address}: holder count unavailable`
        );
      }
    } catch (err) {
      snapshot.holderCount =
        null;

      console.warn(
        `[holders] Lookup failed for ${address}: ${err.message}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // RUG ASSESSMENT
  // ---------------------------------------------------------------------------

  async _assessRug(
    address,
    snapshot,
    liqMcPct
  ) {
    let mintAuthorityStatus = {
      available:
        snapshot.authorityDataAvailable === true,

      mintAuthority:
        snapshot.mintAuthority ?? null,

      freezeAuthority:
        snapshot.freezeAuthority ?? null,

      mintAuthorityRenounced:
        snapshot.authorityDataAvailable === true &&
        snapshot.mintAuthority == null,

      freezeAuthorityRenounced:
        snapshot.authorityDataAvailable === true &&
        snapshot.freezeAuthority == null,
    };

    /*
     * If snapshotBuilder did not get authority data,
     * try the dedicated authority RPC once.
     */
    if (!snapshot.authorityDataAvailable) {
      try {
        const fallback =
          await fetchMintAuthorityStatus(
            address,
            this.rpcUrl
          );

        if (
          fallback?.available === true
        ) {
          mintAuthorityStatus =
            fallback;

          snapshot.authorityDataAvailable =
            true;

          snapshot.mintAuthority =
            fallback.mintAuthority ??
            null;

          snapshot.freezeAuthority =
            fallback.freezeAuthority ??
            null;
        }
      } catch (err) {
        console.warn(
          `[rug] Authority fallback failed for ${address}: ${err.message}`
        );
      }
    }

    const rugCheckReport =
      await getRugCheckReport(
        address,
        this.rugcheckApiKey
      );

    return {
      ...assessRugRisk({
        snapshot,
        liqMcPct,
        mintAuthorityStatus,
        rugCheckReport,
      }),

      rugCheckReport,

      chainSpecificChecksAvailable:
        true,
    };
  }

  // ---------------------------------------------------------------------------
  // VERIFICATION CONFIDENCE
  // ---------------------------------------------------------------------------

  _finalVerificationConfidence(
    snapshot,
    rugAssessment
  ) {
    let confidence =
      Number(
        snapshot?.verificationConfidencePct
      ) || 0;

    if (
      rugAssessment?.rugCheckAvailable
    ) {
      confidence =
        Math.min(
          100,
          confidence + 10
        );
    }

    if (
      rugAssessment?.mintAuthorityRenounced ===
      true
    ) {
      confidence =
        Math.min(
          100,
          confidence + 5
        );
    }

    if (
      rugAssessment?.freezeAuthorityRenounced ===
      true
    ) {
      confidence =
        Math.min(
          100,
          confidence + 5
        );
    }

    if (
      rugAssessment?.mintAuthorityRenounced ===
      false
    ) {
      confidence -= 10;
    }

    if (
      rugAssessment?.freezeAuthorityRenounced ===
      false
    ) {
      confidence -= 10;
    }

    return Math.max(
      0,
      Math.min(
        100,
        Math.round(confidence)
      )
    );
  }

  // ---------------------------------------------------------------------------
  // HARD SAFETY FILTER
  // ---------------------------------------------------------------------------

  _hardSafetyBlock(
    snapshot,
    rugAssessment
  ) {
    const reasons = [];

    if (
      this.requireAuthorityData
    ) {
      if (
        snapshot.authorityDataAvailable !==
        true
      ) {
        reasons.push(
          "Authority data unavailable"
        );
      } else {
        if (
          rugAssessment?.mintAuthorityRenounced !==
          true
        ) {
          reasons.push(
            "Mint authority is not renounced"
          );
        }

        if (
          rugAssessment?.freezeAuthorityRenounced !==
          true
        ) {
          reasons.push(
            "Freeze authority is not renounced"
          );
        }
      }
    }

    if (
      this.requireRugCheck &&
      !rugAssessment?.rugCheckAvailable
    ) {
      reasons.push(
        "RugCheck unavailable"
      );
    }

    if (
      rugAssessment?.rugProbabilityPct ==
      null
    ) {
      reasons.push(
        "No rug probability available"
      );
    } else if (
      rugAssessment.rugProbabilityPct >
      this.maxRugProbabilityPct
    ) {
      reasons.push(
        `Rug probability ${rugAssessment.rugProbabilityPct}% > ${this.maxRugProbabilityPct}%`
      );
    }

    const top =
      Number(snapshot.topHolderPct);

    if (
      Number.isFinite(top) &&
      top > 40
    ) {
      reasons.push(
        `Top-holder concentration ${top.toFixed(1)}% > 40%`
      );
    }

    const liquidity =
      Number(snapshot.liquidityUsd);

    if (
      !Number.isFinite(liquidity) ||
      liquidity < this.minLiquidityUsd
    ) {
      reasons.push(
        `Liquidity below $${this.minLiquidityUsd}`
      );
    }

    return {
      blocked:
        reasons.length > 0,

      reasons,
    };
  }

  // ---------------------------------------------------------------------------
  // HOLDER BEHAVIOR
  // ---------------------------------------------------------------------------

  async _getHolderBehavior(
    address,
    snapshot
  ) {
    return {
      holderIntelligence: {
        available: false,

        reason:
          "Detailed holder intelligence disabled; top-holder concentration is used as the primary holder safety check.",
      },

      behavior:
        compareHolderSnapshots(
          null,
          null
        ),

      marketBehavior:
        classifyMarketBehavior({
          snapshot,
          holderIntel: null,
          behavior: null,
        }),
    };
  }

  // ---------------------------------------------------------------------------
  // SINGLE TOKEN EVALUATION
  // ---------------------------------------------------------------------------

  async evaluateOne(
    tokenAddress
  ) {
    try {
      const snapshot =
        await buildSnapshot(
          tokenAddress,
          {
            heliusApiKey:
              this.heliusApiKey,

            rpcUrl:
              this.rpcUrl,

            enableHeliusRpc:
              true,
          }
        );

      const result =
        scoreToken(snapshot);

      const rugAssessment =
        await this._assessRug(
          tokenAddress,
          snapshot,
          result.liqMcPct
        );

      const verificationConfidencePct =
        this._finalVerificationConfidence(
          snapshot,
          rugAssessment
        );

      snapshot.verificationConfidencePct =
        verificationConfidencePct;

      result.verificationConfidencePct =
        verificationConfidencePct;

      await this._attachHolderCount(
        tokenAddress,
        snapshot
      );

      const behavior =
        await this._getHolderBehavior(
          tokenAddress,
          snapshot
        );

      return {
        snapshot,
        result,
        rugAssessment,
        ...behavior,
      };
    } catch (err) {
      this.onError(
        err,
        `evaluateOne(${tokenAddress})`
      );

      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // RADAR POLLING
  // ---------------------------------------------------------------------------

  async pollOnce() {
    const cycleStartedAt =
      Date.now();

    console.log(
      "[poll] Starting Solana radar cycle..."
    );

    let candidates = [];

    try {
      candidates =
        await discoverNewTokens();

      console.log(
        `[poll] Discovered ${candidates.length} Solana candidates.`
      );
    } catch (err) {
      this.onError(
        err,
        "discoverNewTokens"
      );

      return;
    }

    try {
      const signals =
        await discoverEarlyLaunchSignals();

      console.log(
        `[poll] Early launch signals: ${signals.length}`
      );

      for (
        const signal of signals
      ) {
        this.earlySignals.set(
          signal.tokenAddress,
          signal
        );
      }
    } catch (err) {
      this.onError(
        err,
        "discoverEarlyLaunchSignals"
      );
    }

    if (
      candidates.length === 0
    ) {
      console.log(
        "[poll] No Solana candidates found this cycle."
      );

      return;
    }

    for (
      const address of candidates
    ) {
      if (
        this.alertedMints.has(address)
      ) {
        continue;
      }

      console.log(
        `[poll] Checking ${address}...`
      );

      let marketSnapshot;

      try {
        marketSnapshot =
          await buildSnapshot(
            address,
            {
              heliusApiKey:
                this.heliusApiKey,

              rpcUrl:
                this.rpcUrl,

              enableHeliusRpc:
                false,
            }
          );
      } catch (err) {
        console.warn(
          `[poll] Market snapshot failed for ${address}: ${err.message}`
        );

        continue;
      }

      /*
       * AGE FILTER
       */
      if (
        marketSnapshot.tokenAgeSeconds !=
          null &&
        (
          marketSnapshot.tokenAgeSeconds <
            this.minAgeSeconds ||
          marketSnapshot.tokenAgeSeconds >
            this.maxAgeSeconds
        )
      ) {
        console.log(
          `[poll] ${address} rejected: token age`
        );

        continue;
      }

      /*
       * LIQUIDITY FILTER
       */
      if (
        !(marketSnapshot.liquidityUsd > 0)
      ) {
        console.log(
          `[poll] ${address} rejected: no liquidity`
        );

        continue;
      }

      if (
        marketSnapshot.liquidityUsd <
        this.minLiquidityUsd
      ) {
        console.log(
          `[poll] ${address} rejected: liquidity $${marketSnapshot.liquidityUsd} < $${this.minLiquidityUsd}`
        );

        continue;
      }

      /*
       * CHEAP OPPORTUNITY FILTER
       */
      const cheapResult =
        scoreToken(
          marketSnapshot
        );

      console.log(
        `[poll] ${address} market score: ${cheapResult.score} (cheap filter: ${this.cheapFilterScore})`
      );

      if (
        cheapResult.score <
        this.cheapFilterScore
      ) {
        console.log(
          `[poll] ${address} rejected: score ${cheapResult.score} < cheap filter ${this.cheapFilterScore}`
        );

        continue;
      }

      console.log(
        `[poll] ${address} PASSED CHEAP FILTER (${cheapResult.score} >= ${this.cheapFilterScore}). Running quality checks...`
      );

      /*
       * FULL SNAPSHOT
       */
      let snapshot;

      try {
        snapshot =
          await buildSnapshot(
            address,
            {
              heliusApiKey:
                this.heliusApiKey,

              rpcUrl:
                this.rpcUrl,

              enableHeliusRpc:
                true,
            }
          );
      } catch (err) {
        console.warn(
          `[poll] Full snapshot failed for ${address}: ${err.message}`
        );

        continue;
      }

      /*
       * FINAL SCORE
       */
      const result =
        scoreToken(snapshot);

      console.log(
        `[poll] ${address} final score: ${result.score}`
      );

      if (
        result.score <
        this.minScore
      ) {
        console.log(
          `[poll] ${address} rejected: final score ${result.score} < ${this.minScore}`
        );

        continue;
      }

      /*
       * RUG CHECK
       */
      let rugAssessment;

      try {
        rugAssessment =
          await this._assessRug(
            address,
            snapshot,
            result.liqMcPct
          );
      } catch (err) {
        console.warn(
          `[poll] Rug assessment failed for ${address}: ${err.message}`
        );

        continue;
      }

      console.log(
        `[poll] ${address} rug probability: ${rugAssessment.rugProbabilityPct}%`
      );

      /*
       * HARD SAFETY FILTER
       */
      const safety =
        this._hardSafetyBlock(
          snapshot,
          rugAssessment
        );

      if (
        safety.blocked
      ) {
        console.log(
          `[poll] ${address} BLOCKED: ${safety.reasons.join("; ")}`
        );

        continue;
      }

      /*
       * VERIFICATION CONFIDENCE
       */
      const finalVerificationConfidencePct =
        this._finalVerificationConfidence(
          snapshot,
          rugAssessment
        );

      snapshot.verificationConfidencePct =
        finalVerificationConfidencePct;

      result.verificationConfidencePct =
        finalVerificationConfidencePct;

      console.log(
        `[poll] ${address} verification confidence: ${finalVerificationConfidencePct}%`
      );

      if (
        finalVerificationConfidencePct <
        this.minVerificationConfidencePct
      ) {
        console.log(
          `[poll] ${address} rejected: verification confidence ${finalVerificationConfidencePct}% < ${this.minVerificationConfidencePct}%`
        );

        continue;
      }

      /*
       * -----------------------------------------------------------------------
       * ONLY NOW LOOK UP TOTAL HOLDERS
       * -----------------------------------------------------------------------
       *
       * We deliberately wait until the token has already passed every
       * important quality and safety test.
       */
      await this._attachHolderCount(
        address,
        snapshot
      );

      /*
       * HOLDER BEHAVIOR
       */
      const behavior =
        await this._getHolderBehavior(
          address,
          snapshot
        );

      /*
       * EARLY SIGNAL
       */
      const earlySignal =
        this.earlySignals.get(
          address
        ) || null;

      const sniperSignal =
        earlySignal &&
        Number(
          earlySignal.signalScore
        ) >= 35
          ? earlySignal
          : null;

      /*
       * -----------------------------------------------------------------------
       * ALERT FREQUENCY CONTROL
       * -----------------------------------------------------------------------
       */

      const alertsThisCycle =
        this._alertsThisCycle(
          cycleStartedAt
        );

      if (
        alertsThisCycle >=
        this.maxAlertsPerCycle
      ) {
        console.log(
          `[poll] ${address} qualified but cycle alert limit reached (${this.maxAlertsPerCycle}).`
        );

        continue;
      }

      if (
        !this._canSendAlert()
      ) {
        console.log(
          `[poll] ${address} qualified but hourly alert limit reached (${this.maxAlertsPerHour}).`
        );

        continue;
      }

      /*
       * QUALIFIED
       */
      this.alertedMints.add(
        address
      );

      this._recordAlert();

      console.log(
        `[poll] 🚨 ALERT QUALIFIED: ${address}`
      );

      console.log(
        `[poll] Final score: ${result.score}/${this.minScore}+`
      );

      console.log(
        `[poll] Rug probability: ${rugAssessment.rugProbabilityPct}%`
      );

      console.log(
        `[poll] Verification confidence: ${finalVerificationConfidencePct}%`
      );

      console.log(
        `[poll] Holders: ${
          snapshot.holderCount != null
            ? snapshot.holderCount.toLocaleString()
            : "N/A"
        }`
      );

      try {
        await this.onAlert(
          snapshot,
          result,
          rugAssessment,
          sniperSignal,
          behavior
        );

        console.log(
          `[poll] Discord alert sent for ${address}`
        );
      } catch (err) {
        this.onError(
          err,
          `onAlert(${address})`
        );
      }
    }

    console.log(
      "[poll] Radar cycle complete."
    );
  }

  // ---------------------------------------------------------------------------
  // START POLLING
  // ---------------------------------------------------------------------------

  start(
    intervalMs = 30000
  ) {
    let stopped = false;
    let running = false;

    const loop = async () => {
      if (
        stopped ||
        running
      ) {
        return;
      }

      running = true;

      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(
          err,
          "pollOnce"
        );
      } finally {
        running = false;

        if (!stopped) {
          this._timer =
            setTimeout(
              loop,
              intervalMs
            );
        }
      }
    };

    loop();

    return () => {
      stopped = true;

      if (this._timer) {
        clearTimeout(
          this._timer
        );
      }
    };
  }
}

module.exports = {
  Watchlist,
};
