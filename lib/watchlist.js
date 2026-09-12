"use strict";

const { discoverNewTokens, discoverEarlyLaunchSignals, getRugCheckReport } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");
const { fetchMintAuthorityStatus, assessRugRisk } = require("./rugChecker");
const { compareHolderSnapshots, classifyMarketBehavior } = require("./holderIntelligence");

class Watchlist {
  constructor(opts = {}) {
    this.minAgeSeconds = opts.minAgeSeconds ?? 60;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 21600;
    this.minScore = opts.minScore ?? 70;
    this.minVerificationConfidencePct = opts.minVerificationConfidencePct ?? 80;
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
      ...assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport }),
      chainSpecificChecksAvailable: true,
    };
  }

  _finalVerificationConfidence(snapshot, rugAssessment) {
    let confidence = Number(snapshot?.verificationConfidencePct) || 0;

    if (rugAssessment?.rugCheckAvailable) confidence = Math.min(100, confidence + 10);
    if (rugAssessment?.mintAuthorityRenounced === true) confidence = Math.min(100, confidence + 5);
    if (rugAssessment?.freezeAuthorityRenounced === true) confidence = Math.min(100, confidence + 5);

    if (rugAssessment?.mintAuthorityRenounced === false) confidence -= 8;
    if (rugAssessment?.freezeAuthorityRenounced === false) confidence -= 8;
    if (!rugAssessment?.rugCheckAvailable) confidence -= 10;

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  async _getHolderBehavior(address, snapshot) {
    // Detailed holder enumeration uses Helius DAS and is intentionally OFF by
    // default. Top-holder concentration still comes from getTokenLargestAccounts.
    return {
      holderIntelligence: {
        available: false,
        reason: "Detailed holder intelligence disabled to prevent Helius rate-limit errors",
      },
      behavior: compareHolderSnapshots(null, null),
      marketBehavior: classifyMarketBehavior({ snapshot, holderIntel: null, behavior: null }),
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
      const rugAssessment = await this._assessRug(tokenAddress, snapshot, result.liqMcPct);
      const verificationConfidencePct = this._finalVerificationConfidence(snapshot, rugAssessment);
      snapshot.verificationConfidencePct = verificationConfidencePct;
      result.verificationConfidencePct = verificationConfidencePct;

      const behavior = await this._getHolderBehavior(tokenAddress, snapshot);
      return { snapshot, result, rugAssessment, ...behavior };
    } catch (err) {
      this.onError(err, `evaluateOne(${tokenAddress})`);
      return null;
    }
  }

  async pollOnce() {
    let candidates = [];
    try { candidates = await discoverNewTokens(); }
    catch (err) { this.onError(err, "discoverNewTokens"); return; }

    try {
      const signals = await discoverEarlyLaunchSignals();
      for (const signal of signals) this.earlySignals.set(signal.tokenAddress, signal);
    } catch (err) {
      this.onError(err, "discoverEarlyLaunchSignals");
    }

    for (const address of candidates) {
      if (this.alertedMints.has(address)) continue;

      // Cheap market-only pass first: no Helius request yet.
      let marketSnapshot;
      try {
        marketSnapshot = await buildSnapshot(address, {
          heliusApiKey: this.heliusApiKey,
          rpcUrl: this.rpcUrl,
          enableHeliusRpc: false,
        });
      } catch (_) { continue; }

      if (marketSnapshot.tokenAgeSeconds != null &&
          (marketSnapshot.tokenAgeSeconds < this.minAgeSeconds || marketSnapshot.tokenAgeSeconds > this.maxAgeSeconds)) continue;
      if (!(marketSnapshot.liquidityUsd > 0)) continue;
      if (marketSnapshot.liquidityUsd < this.minLiquidityUsd) continue;

      const cheapResult = scoreToken(marketSnapshot);
      if (cheapResult.score < this.minScore) continue;

      // Only promising tokens reach Helius. This is the main fix for the 429s.
      let snapshot;
      try {
        snapshot = await buildSnapshot(address, {
          heliusApiKey: this.heliusApiKey,
          rpcUrl: this.rpcUrl,
          enableHeliusRpc: true,
        });
      } catch (_) { continue; }

      const result = scoreToken(snapshot);
      if (result.score < this.minScore) continue;

      let rugAssessment;
      try { rugAssessment = await this._assessRug(address, snapshot, result.liqMcPct); }
      catch (_) { continue; }

      if (rugAssessment.rugProbabilityPct == null) continue;
      if (rugAssessment.rugProbabilityPct > this.maxRugProbabilityPct) continue;

      const finalVerificationConfidencePct = this._finalVerificationConfidence(snapshot, rugAssessment);
      snapshot.verificationConfidencePct = finalVerificationConfidencePct;
      result.verificationConfidencePct = finalVerificationConfidencePct;

      if (finalVerificationConfidencePct < this.minVerificationConfidencePct) continue;
      if (this.requireAuthorityData && snapshot.authorityDataAvailable !== true) continue;
      if (this.requireRugCheck && !rugAssessment.rugCheckAvailable) continue;

      const behavior = await this._getHolderBehavior(address, snapshot);
      const earlySignal = this.earlySignals.get(address) || null;
      const sniperSignal = earlySignal && Number(earlySignal.signalScore) >= 35 ? earlySignal : null;

      this.alertedMints.add(address);
      try {
        await this.onAlert(snapshot, result, rugAssessment, sniperSignal, behavior);
      } catch (err) {
        this.onError(err, `onAlert(${address})`);
      }
    }
  }

  start(intervalMs = 30000) {
    let stopped = false;
    let running = false;

    const loop = async () => {
      if (stopped || running) return;
      running = true;
      try { await this.pollOnce(); }
      finally {
        running = false;
        if (!stopped) this._timer = setTimeout(loop, intervalMs);
      }
    };

    loop();
    return () => {
      stopped = true;
      if (this._timer) clearTimeout(this._timer);
    };
  }
}

module.exports = { Watchlist };
