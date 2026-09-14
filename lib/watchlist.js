"use strict";

const {
  discoverNewTokens,
  discoverEarlyLaunchSignals,
  getRugCheckReport,
  getSolscanTokenMeta,
} = require("./apiClient");

const {
  buildSnapshot,
} = require("./snapshotBuilder");

const {
  scoreToken,
} = require("./scoringEngine");

const {
  fetchMintAuthorityStatus,
  assessRugRisk,
} = require("./rugChecker");

const {
  compareHolderSnapshots,
  classifyMarketBehavior,
} = require("./holderIntelligence");

class Watchlist {
  constructor(
    opts = {}
  ) {
    this.minAgeSeconds =
      opts.minAgeSeconds ??
      120;

    this.maxAgeSeconds =
      opts.maxAgeSeconds ??
      21600;

    this.minScore =
      opts.minScore ??
      78;

    this.cheapFilterScore =
      opts.cheapFilterScore ??
      65;

    this.minVerificationConfidencePct =
      opts.minVerificationConfidencePct ??
      88;

    this.maxRugProbabilityPct =
      opts.maxRugProbabilityPct ??
      20;

    this.minLiquidityUsd =
      opts.minLiquidityUsd ??
      15000;

    this.requireRugCheck =
      opts.requireRugCheck ??
      true;

    this.requireAuthorityData =
      opts.requireAuthorityData ??
      true;

    this.maxAlertsPerCycle =
      opts.maxAlertsPerCycle ??
      1;

    this.maxAlertsPerHour =
      opts.maxAlertsPerHour ??
      3;

    this.heliusApiKey =
      opts.heliusApiKey;

    this.solscanApiKey =
      opts.solscanApiKey;

    this.rpcUrl =
      opts.rpcUrl;

    this.rugcheckApiKey =
      opts.rugcheckApiKey;

    this.onAlert =
      opts.onAlert ??
      (async () => {});

    this.onError =
      opts.onError ??
      (() => {});

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
  // ALERT LIMITING
  // ---------------------------------------------------------------------------

  _cleanupAlertTimestamps() {
    const oneHourAgo =
      Date.now() -
      60 * 60 * 1000;

    this.alertTimestamps =
      this.alertTimestamps.filter(
        (timestamp) =>
          timestamp >
          oneHourAgo
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

  // ---------------------------------------------------------------------------
  // HOLDER DATA
  // ---------------------------------------------------------------------------

  _extractRugCheckHolderData(
    rugCheckReport
  ) {
    const raw =
      Array.isArray(
        rugCheckReport?.topHolders
      )
        ? rugCheckReport.topHolders
        : [];

    if (
      raw.length ===
      0
    ) {
      return {
        available:
          false,

        holderCount:
          null,

        topHolderPct:
          null,

        top10Pct:
          null,

        top20Pct:
          null,

        largestHolder:
          null,
      };
    }

    /*
     * RugCheck provides owner + pct.
     *
     * Deduplicate by owner because one wallet can have
     * multiple token accounts.
     */
    const byOwner =
      new Map();

    for (
      const item of raw
    ) {
      const owner =
        item?.owner;

      const pct =
        Number(
          item?.pct
        );

      if (
        !owner ||
        !Number.isFinite(
          pct
        )
      ) {
        continue;
      }

      byOwner.set(
        owner,
        (
          byOwner.get(
            owner
          ) || 0
        ) + pct
      );
    }

    const holders =
      [...byOwner.entries()]
        .map(
          ([
            owner,
            pct,
          ]) => ({
            owner,
            pct,
          })
        )
        .sort(
          (a, b) =>
            b.pct -
            a.pct
        );

    if (
      holders.length ===
      0
    ) {
      return {
        available:
          false,

        holderCount:
          null,

        topHolderPct:
          null,

        top10Pct:
          null,

        top20Pct:
          null,

        largestHolder:
          null,
      };
    }

    const top10Pct =
      holders
        .slice(0, 10)
        .reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.pct,
          0
        );

    const top20Pct =
      holders
        .slice(0, 20)
        .reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.pct,
          0
        );

    return {
      available:
        true,

      holderCount:
        null,

      topHolderPct:
        Math.min(
          100,
          holders[0]
            .pct
        ),

      top10Pct:
        Math.min(
          100,
          top10Pct
        ),

      top20Pct:
        Math.min(
          100,
          top20Pct
        ),

      largestHolder:
        holders[0]
          ?.owner ||
        null,
    };
  }

  async _attachHolderData(
    address,
    snapshot,
    rugCheckReport
  ) {
    /*
     * First get holder concentration from RugCheck.
     * This does not require the paid Solscan holder endpoint.
     */
    const rugHolders =
      this._extractRugCheckHolderData(
        rugCheckReport
      );

    if (
      rugHolders.available
    ) {
      snapshot.topHolderPct =
        rugHolders.topHolderPct;

      snapshot.top10HolderPct =
        rugHolders.top10Pct;

      snapshot.top20HolderPct =
        rugHolders.top20Pct;

      snapshot.largestHolder =
        rugHolders.largestHolder;

      if (
        snapshot.metrics
      ) {
        snapshot.metrics.topHolderPct =
          rugHolders.topHolderPct;

        snapshot.metrics.top10HolderPct =
          rugHolders.top10Pct;

        snapshot.metrics.top20HolderPct =
          rugHolders.top20Pct;
      }

      console.log(
        `[holders] RugCheck ${address}: top holder ${
          rugHolders.topHolderPct.toFixed(
            1
          )
        }%, top 10 ${
          rugHolders.top10Pct.toFixed(
            1
          )
        }%, top 20 ${
          rugHolders.top20Pct.toFixed(
            1
          )
        }%`
      );
    } else {
      snapshot.topHolderPct =
        null;

      snapshot.top10HolderPct =
        null;

      snapshot.top20HolderPct =
        null;

      snapshot.largestHolder =
        null;

      console.log(
        `[holders] RugCheck ${address}: top-holder data unavailable`
      );
    }

    /*
     * Then use Solscan's FREE Token Meta endpoint ONLY for the
     * total holder count.
     *
     * This is not required for safety, so a temporary Solscan
     * failure will NOT kill an otherwise qualified alert.
     */
    try {
      const solscanMeta =
        await getSolscanTokenMeta(
          address,
          this.solscanApiKey
        );

      if (
        solscanMeta?.holderCount !=
        null
      ) {
        snapshot.holderCount =
          solscanMeta.holderCount;

        if (
          snapshot.metrics
        ) {
          snapshot.metrics.holderCount =
            solscanMeta.holderCount;
        }

        console.log(
          `[holders] ${address}: ${solscanMeta.holderCount.toLocaleString()} total holders`
        );
      } else {
        snapshot.holderCount =
          null;

        console.log(
          `[holders] ${address}: total holder count unavailable`
        );
      }
    } catch (err) {
      snapshot.holderCount =
        null;

      console.warn(
        `[holders] Solscan free meta lookup failed for ${address}: ${err.message}`
      );
    }

    return {
      concentrationAvailable:
        rugHolders.available,

      totalHolderCountAvailable:
        snapshot.holderCount !=
        null,
    };
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
        snapshot.authorityDataAvailable ===
        true,

      mintAuthority:
        snapshot.mintAuthority ??
        null,

      freezeAuthority:
        snapshot.freezeAuthority ??
        null,

      mintAuthorityRenounced:
        snapshot.authorityDataAvailable ===
          true &&
        snapshot.mintAuthority ==
          null,

      freezeAuthorityRenounced:
        snapshot.authorityDataAvailable ===
          true &&
        snapshot.freezeAuthority ==
          null,
    };

    if (
      !snapshot.authorityDataAvailable
    ) {
      try {
        const fallback =
          await fetchMintAuthorityStatus(
            address,
            this.rpcUrl
          );

        if (
          fallback?.available ===
          true
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
  // VERIFICATION
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
      confidence -=
        10;
    }

    if (
      rugAssessment?.freezeAuthorityRenounced ===
      false
    ) {
      confidence -=
        10;
    }

    return Math.max(
      0,
      Math.min(
        100,
        Math.round(
          confidence
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // HARD SAFETY
  // ---------------------------------------------------------------------------

  _hardSafetyBlock(
    snapshot,
    rugAssessment
  ) {
    const reasons =
      [];

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

    /*
     * TOP HOLDER SAFETY
     *
     * Use RugCheck holder distribution.
     */
    const topHolder =
      Number(
        snapshot.topHolderPct
      );

    if (
      !Number.isFinite(
        topHolder
      )
    ) {
      reasons.push(
        "Top-holder data unavailable"
      );
    } else if (
      topHolder >
      40
    ) {
      reasons.push(
        `Top-holder concentration ${topHolder.toFixed(
          1
        )}% > 40%`
      );
    }

    const top10 =
      Number(
        snapshot.top10HolderPct
      );

    if (
      Number.isFinite(
        top10
      ) &&
      top10 >
        55
    ) {
      reasons.push(
        `Top-10 concentration ${top10.toFixed(
          1
        )}% > 55%`
      );
    }

    const liquidity =
      Number(
        snapshot.liquidityUsd
      );

    if (
      !Number.isFinite(
        liquidity
      ) ||
      liquidity <
        this.minLiquidityUsd
    ) {
      reasons.push(
        `Liquidity below $${this.minLiquidityUsd}`
      );
    }

    return {
      blocked:
        reasons.length >
        0,

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
        available:
          false,

        reason:
          "Detailed holder history is disabled; current RugCheck holder concentration is used for safety.",
      },

      behavior:
        compareHolderSnapshots(
          null,
          null
        ),

      marketBehavior:
        classifyMarketBehavior({
          snapshot,

          holderIntel:
            null,

          behavior:
            null,
        }),
    };
  }

  // ---------------------------------------------------------------------------
  // MANUAL SINGLE-TOKEN CHECK
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
        scoreToken(
          snapshot
        );

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

      await this._attachHolderData(
        tokenAddress,
        snapshot,
        rugAssessment.rugCheckReport
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
  // POLL
  // ---------------------------------------------------------------------------

  async pollOnce() {
    console.log(
      "[poll] Starting Solana radar cycle..."
    );

    let candidates =
      [];

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
        const signal of
          signals
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
      candidates.length ===
      0
    ) {
      console.log(
        "[poll] No Solana candidates found this cycle."
      );

      return;
    }

    const qualified =
      [];

    for (
      const address of
        candidates
    ) {
      if (
        this.alertedMints.has(
          address
        )
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
       * AGE
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
       * LIQUIDITY
       */
      if (
        !(
          marketSnapshot.liquidityUsd >
          0
        )
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
       * CHEAP SCORE
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
        scoreToken(
          snapshot
        );

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
       * VERIFICATION
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
       * HOLDER DATA
       *
       * RugCheck concentration + FREE Solscan holder count.
       */
      await this._attachHolderData(
        address,
        snapshot,
        rugAssessment.rugCheckReport
      );

      /*
       * HARD SAFETY
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
          `[poll] ${address} BLOCKED: ${safety.reasons.join(
            "; "
          )}`
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
        ) ||
        null;

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
      qualified.push({
        address,

        snapshot,

        result,

        rugAssessment,

        behavior,

        sniperSignal,
      });

      console.log(
        `[poll] ${address} QUALIFIED: score ${result.score}, rug ${rugAssessment.rugProbabilityPct}%, verification ${finalVerificationConfidencePct}%, holders ${
          snapshot.holderCount !=
          null
            ? snapshot.holderCount.toLocaleString()
            : "N/A"
        }, top holder ${
          snapshot.topHolderPct !=
          null
            ? snapshot.topHolderPct.toFixed(
                1
              ) + "%"
            : "N/A"
        }`
      );
    }

    /*
     * NO QUALIFIED TOKENS
     */
    if (
      qualified.length ===
      0
    ) {
      console.log(
        "[poll] No high-quality tokens qualified this cycle."
      );

      console.log(
        "[poll] Radar cycle complete."
      );

      return;
    }

    /*
     * BEST TOKEN FIRST
     */
    qualified.sort(
      (a, b) => {
        if (
          b.result.score !==
          a.result.score
        ) {
          return (
            b.result.score -
            a.result.score
          );
        }

        const bTop10 =
          Number(
            b.snapshot.top10HolderPct
          ) || 0;

        const aTop10 =
          Number(
            a.snapshot.top10HolderPct
          ) || 0;

        if (
          bTop10 !==
          aTop10
        ) {
          return (
            aTop10 -
            bTop10
          );
        }

        const bLiq =
          Number(
            b.snapshot.liquidityUsd
          ) || 0;

        const aLiq =
          Number(
            a.snapshot.liquidityUsd
          ) || 0;

        return (
          bLiq -
          aLiq
        );
      }
    );

    /*
     * ONLY ONE ALERT PER CYCLE
     */
    const winners =
      qualified.slice(
        0,
        this.maxAlertsPerCycle
      );

    for (
      const candidate of
        winners
    ) {
      if (
        !this._canSendAlert()
      ) {
        console.log(
          `[poll] Hourly alert limit reached (${this.maxAlertsPerHour}).`
        );

        break;
      }

      const {
        address,
        snapshot,
        result,
        rugAssessment,
        behavior,
        sniperSignal,
      } =
        candidate;

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
        `[poll] Verification confidence: ${result.verificationConfidencePct}%`
      );

      console.log(
        `[poll] Holders: ${
          snapshot.holderCount !=
          null
            ? snapshot.holderCount.toLocaleString()
            : "N/A"
        }`
      );

      console.log(
        `[poll] Top holder: ${
          snapshot.topHolderPct !=
          null
            ? snapshot.topHolderPct.toFixed(
                1
              ) + "%"
            : "N/A"
        }`
      );

      console.log(
        `[poll] Top 10 wallets: ${
          snapshot.top10HolderPct !=
          null
            ? snapshot.top10HolderPct.toFixed(
                1
              ) + "%"
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

    const skipped =
      Math.max(
        0,
        qualified.length -
          winners.length
      );

    if (
      skipped > 0
    ) {
      console.log(
        `[poll] ${skipped} additional qualified token(s) suppressed.`
      );
    }

    console.log(
      "[poll] Radar cycle complete."
    );
  }

  // ---------------------------------------------------------------------------
  // START
  // ---------------------------------------------------------------------------

  start(
    intervalMs = 30000
  ) {
    let stopped =
      false;

    let running =
      false;

    const loop =
      async () => {
        if (
          stopped ||
          running
        ) {
          return;
        }

        running =
          true;

        try {
          await this.pollOnce();
        } catch (err) {
          this.onError(
            err,
            "pollOnce"
          );
        } finally {
          running =
            false;

          if (
            !stopped
          ) {
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
      stopped =
        true;

      if (
        this._timer
      ) {
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
