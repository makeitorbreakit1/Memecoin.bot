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
    this.minAgeSeconds = opts.minAgeSeconds ?? 60;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 21600;
    this.minScore = opts.minScore ?? 70;
    this.minVerificationConfidencePct =
      opts.minVerificationConfidencePct ?? 80;
    this.maxRugProbabilityPct = opts.maxRugProbabilityPct ?? 35;
    this.minLiquidityUsd = opts.minLiquidityUsd ?? 10000;

    this.requireRugCheck = opts.requireRugCheck ?? true;
    this.requireAuthorityData = opts.requireAuthorityData ?? true;

    this.heliusApiKey = opts.heliusApiKey;
    this.rpcUrl = opts.rpcUrl;
    this.rugcheckApiKey = opts.rugcheckApiKey;

    this.onAlert = opts.onAlert ?? (async () => {});
    this.onError = opts.onError ?? (() => {});

    this.alertedMints = new Set();
    this.earlySignals = new Map();
    this.behaviorHistory = new Map();
  }

  async _assessRug(address, snapshot, liqMcPct) {
    const [mintAuthorityStatus, rugCheckReport] = await Promise.all([
      fetchMintAuthorityStatus(address, this.rpcUrl),
      getRugCheckReport(address, this.rugcheckApiKey),
    ]);

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

  _finalVerificationConfidence(snapshot, rugAssessment) {
    let confidence =
      Number(snapshot?.verificationConfidencePct) || 0;

    if (rugAssessment?.rugCheckAvailable) {
      confidence = Math.min(100, confidence + 10);
    }

    if (rugAssessment?.mintAuthorityRenounced === true) {
      confidence = Math.min(100, confidence + 5);
    }

    if (rugAssessment?.freezeAuthorityRenounced === true) {
      confidence = Math.min(100, confidence + 5);
    }

    if (rugAssessment?.mintAuthorityRenounced === false) {
      confidence -= 8;
    }

    if (rugAssessment?.freezeAuthorityRenounced === false) {
      confidence -= 8;
    }

    if (!rugAssessment?.rugCheckAvailable) {
      confidence -= 10;
    }

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  async _getHolderBehavior(address, snapshot) {
    // Detailed holder enumeration is intentionally disabled.
    // Top-holder concentration still comes from
    // getTokenLargestAccounts through snapshotBuilder.

    return {
      holderIntelligence: {
        available: false,
        reason:
          "Detailed holder intelligence disabled to prevent Helius rate-limit errors",
      },

      behavior: compareHolderSnapshots(null, null),

      marketBehavior: classifyMarketBehavior({
        snapshot,
        holderIntel: null,
        behavior: null,
      }),
    };
  }

  async evaluateOne(tokenAddress) {
    try {
      const snapshot = await buildSnapshot(tokenAddress, {
        heliusApiKey: this.heliusApiKey,
        rpcUrl: this.rpcUrl,
        enableHeliusRpc: true,
      });

      const result = scoreToken(snapshot);

      const rugAssessment = await this._assessRug(
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

      const behavior = await this._getHolderBehavior(
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
    console.log("[poll] Starting Solana radar cycle...");

    let candidates = [];

    try {
      candidates = await discoverNewTokens();

      console.log(
        `[poll] Discovered ${candidates.length} Solana candidates.`
      );
    } catch (err) {
      this.onError(err, "discoverNewTokens");
      return;
    }

    try {
      const signals = await discoverEarlyLaunchSignals();

      console.log(
        `[poll] Early launch signals: ${signals.length}`
      );

      for (const signal of signals) {
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

    if (candidates.length === 0) {
      console.log(
        "[poll] No Solana candidates found this cycle."
      );

      return;
    }

    for (const address of candidates) {
      if (this.alertedMints.has(address)) {
        continue;
      }

      console.log(
        `[poll] Checking ${address}...`
      );

      // ---------------------------------------------------------
      // CHEAP MARKET-ONLY PASS
      // Does NOT use Helius RPC.
      // ---------------------------------------------------------

      let marketSnapshot;

      try {
        marketSnapshot = await buildSnapshot(address, {
          heliusApiKey: this.heliusApiKey,
          rpcUrl: this.rpcUrl,
          enableHeliusRpc: false,
        });
      } catch (err) {
        console.warn(
          `[poll] Market snapshot failed for ${address}: ${err.message}`
        );

        continue;
      }

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

      if (!(marketSnapshot.liquidityUsd > 0)) {
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

      const cheapResult =
        scoreToken(marketSnapshot);

      console.log(
        `[poll] ${address} market score: ${cheapResult.score}`
      );

      if (cheapResult.score < this.minScore) {
        console.log(
          `[poll] ${address} rejected: score ${cheapResult.score} < ${this.minScore}`
        );

        continue;
      }

      // ---------------------------------------------------------
      // HELIUS PASS
      // Only promising tokens reach this point.
      // ---------------------------------------------------------

      console.log(
        `[poll] ${address} passed cheap filter. Running Helius checks...`
      );

      let snapshot;

      try {
        snapshot = await buildSnapshot(address, {
          heliusApiKey: this.heliusApiKey,
          rpcUrl: this.rpcUrl,
          enableHeliusRpc: true,
        });
      } catch (err) {
        console.warn(
          `[poll] Helius snapshot failed for ${address}: ${err.message}`
        );

        continue;
      }

      const result = scoreToken(snapshot);

      console.log(
        `[poll] ${address} final score: ${result.score}`
      );

      if (result.score < this.minScore) {
        console.log(
          `[poll] ${address} rejected: final score`
        );

        continue;
      }

      // ---------------------------------------------------------
      // RUG CHECK
      // ---------------------------------------------------------

      let rugAssessment;

      try {
        rugAssessment = await this._assessRug(
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

      if (
        rugAssessment.rugProbabilityPct == null
      ) {
        console.log(
          `[poll] ${address} rejected: no rug probability`
        );

        continue;
      }

      if (
        rugAssessment.rugProbabilityPct >
        this.maxRugProbabilityPct
      ) {
        console.log(
          `[poll] ${address} rejected: rug probability too high`
        );

        continue;
      }

      // ---------------------------------------------------------
      // VERIFICATION CONFIDENCE
      // ---------------------------------------------------------

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
          `[poll] ${address} rejected: verification confidence`
        );

        continue;
      }

      // ---------------------------------------------------------
      // AUTHORITY DATA
      // ---------------------------------------------------------

      if (
        this.requireAuthorityData &&
        snapshot.authorityDataAvailable !== true
      ) {
        console.log(
          `[poll] ${address} rejected: authority data unavailable`
        );

        continue;
      }

      // ---------------------------------------------------------
      // RUGCHECK AVAILABILITY
      // ---------------------------------------------------------

      if (
        this.requireRugCheck &&
        !rugAssessment.rugCheckAvailable
      ) {
        console.log(
          `[poll] ${address} rejected: RugCheck unavailable`
        );

        continue;
      }

      // ---------------------------------------------------------
      // HOLDER / MARKET BEHAVIOR
      // ---------------------------------------------------------

      const behavior =
        await this._getHolderBehavior(
          address,
          snapshot
        );

      const earlySignal =
        this.earlySignals.get(address) || null;

      const sniperSignal =
        earlySignal &&
        Number(earlySignal.signalScore) >= 35
          ? earlySignal
          : null;

      // ---------------------------------------------------------
      // ALERT
      // ---------------------------------------------------------

      this.alertedMints.add(address);

      console.log(
        `[poll] 🚨 ALERT QUALIFIED: ${address}`
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

  start(intervalMs = 30000) {
    let stopped = false;
    let running = false;

    const loop = async () => {
      if (stopped || running) {
        return;
      }

      running = true;

      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err, "pollOnce");
      } finally {
        running = false;

        if (!stopped) {
          this._timer = setTimeout(
            loop,
            intervalMs
          );
        }
      }
    };

    // Start immediately rather than waiting
    // for the first interval.
    loop();

    return () => {
      stopped = true;

      if (this._timer) {
        clearTimeout(this._timer);
      }
    };
  }
}

module.exports = { Watchlist };
