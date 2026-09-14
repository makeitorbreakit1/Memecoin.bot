"use strict";

const {
  discoverNewTokens,
  discoverEarlyLaunchSignals,
  getRugCheckReport,
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

    this.minScore =
      opts.minScore ?? 68;

    this.cheapFilterScore =
      opts.cheapFilterScore ?? 60;

    this.minVerificationConfidencePct =
      opts.minVerificationConfidencePct ?? 75;

    this.maxRugProbabilityPct =
      opts.maxRugProbabilityPct ?? 20;

    this.minLiquidityUsd =
      opts.minLiquidityUsd ?? 7500;

    this.requireRugCheck =
      opts.requireRugCheck ?? true;

    this.requireAuthorityData =
      opts.requireAuthorityData ?? true;

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
  }

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

        if (fallback?.available === true) {
          mintAuthorityStatus = fallback;

          /*
           * IMPORTANT:
           * Update the snapshot too.
           */
          snapshot.authorityDataAvailable = true;

          snapshot.mintAuthority =
            fallback.mintAuthority ?? null;

          snapshot.freezeAuthority =
            fallback.freezeAuthority ?? null;
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

      chainSpecificChecksAvailable: true,
    };
  }

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
      rugAssessment?.mintAuthorityRenounced === true
    ) {
      confidence =
        Math.min(
          100,
          confidence + 5
        );
    }

    if (
      rugAssessment?.freezeAuthorityRenounced === true
    ) {
      confidence =
        Math.min(
          100,
          confidence + 5
        );
    }

    if (
      rugAssessment?.mintAuthorityRenounced === false
    ) {
      confidence -= 10;
    }

    if (
      rugAssessment?.freezeAuthorityRenounced === false
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

  _hardSafetyBlock(
    snapshot,
    rugAssessment
  ) {
    const reasons = [];

    /*
     * Authority safety.
     *
     * Only enforce this when enabled.
     */
    if (this.requireAuthorityData) {
      if (
        snapshot.authorityDataAvailable !== true
      ) {
        reasons.push(
          "Authority data unavailable"
        );
      } else {
        if (
          rugAssessment?.mintAuthorityRenounced !== true
        ) {
          reasons.push(
            "Mint authority is not renounced"
          );
        }

        if (
          rugAssessment?.freezeAuthorityRenounced !== true
        ) {
          reasons.push(
            "Freeze authority is not renounced"
          );
        }
      }
    }

    /*
     * RugCheck.
     */
    if (
      this.requireRugCheck &&
      !rugAssessment?.rugCheckAvailable
    ) {
      reasons.push(
        "RugCheck unavailable"
      );
    }

    /*
     * Rug probability.
     */
    if (
      rugAssessment?.rugProbabilityPct == null
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

    /*
     * Holder concentration.
     */
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

    /*
     * Liquidity.
     */
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

  async _getHolderBehavior(
    address,
    snapshot
  ) {
    return {
      holderIntelligence: {
        available: false,
        reason:
          "Detailed holder intelligence disabled; standard Helius RPC is used for top-holder concentration only",
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

            enableHeliusRpc: true,
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

  async pollOnce() {
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
        marketSnapshot.tokenAgeSeconds != null &&
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
        `[poll] ${address} PASSED CHEAP FILTER (${cheapResult.score} >= ${this.cheapFilterScore}). Running Helius checks...`
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
          `[poll] Helius snapshot failed for ${address}: ${err.message}`
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
       * BEHAVIOR
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
       * QUALIFIED
       */
      this.alertedMints.add(
        address
      );

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
