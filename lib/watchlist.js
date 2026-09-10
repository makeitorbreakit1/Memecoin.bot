"use strict";

const { discoverNewTokens, discoverEarlyLaunchSignals, getRugCheckReport } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");
const { fetchMintAuthorityStatus, assessRugRisk } = require("./rugChecker");
const { buildHolderIntelligence, compareHolderSnapshots, classifyMarketBehavior } = require("./holderIntelligence");

class Watchlist {
  constructor(opts = {}) {
    // ORIGINAL V4 FILTERS — intentionally preserved.
    this.minAgeSeconds = opts.minAgeSeconds ?? 60;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 21600;
    this.minScore = opts.minScore ?? 70;
    this.minVerificationConfidencePct = opts.minVerificationConfidencePct ?? 80;
    this.maxRugProbabilityPct = opts.maxRugProbabilityPct ?? 35;
    this.minLiquidityUsd = opts.minLiquidityUsd ?? 10000;
    this.requireRugCheck = opts.requireRugCheck ?? true;
    this.requireAuthorityData = opts.requireAuthorityData ?? true;

    this.birdeyeApiKey = opts.birdeyeApiKey;
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
    return assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport });
  }

  _finalVerificationConfidence(snapshot, rugAssessment) {
    let confidence = 0;
    if (snapshot?.dexPair && snapshot?.liquidityUsd != null && snapshot?.marketCapUsd != null && snapshot?.volume24hUsd != null) confidence += 30;
    if (snapshot?.heliusAsset) confidence += 15;
    if (snapshot?.holderCount != null) confidence += 15;
    if (snapshot?.totalSupply != null && snapshot?.topHolderPct != null) confidence += 10;

    const authoritiesKnown = snapshot?.authorityDataAvailable === true;
    if (authoritiesKnown) {
      const mintSafe = snapshot.mintAuthority == null;
      const freezeSafe = snapshot.freezeAuthority == null;
      confidence += mintSafe && freezeSafe ? 20 : 8;
    }

    if (rugAssessment?.rugCheckAvailable) confidence += 10;

    if (rugAssessment?.mintAuthorityRenounced !== true) confidence -= 8;
    if (rugAssessment?.freezeAuthorityRenounced !== true) confidence -= 8;
    if (!rugAssessment?.rugCheckAvailable) confidence -= 10;
    if ((rugAssessment?.rugProbabilityPct ?? 100) > this.maxRugProbabilityPct) confidence -= 15;

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  async _getHolderBehavior(address, snapshot) {
    try {
      const holderIntel = await buildHolderIntelligence(address, {
        heliusApiKey: this.heliusApiKey,
        rpcUrl: this.rpcUrl,
        decimals: snapshot.decimals,
        totalSupply: snapshot.totalSupply,
        pairAddress: snapshot.pairAddress,
      });

      if (!holderIntel?.available) {
        return {
          holderIntelligence: holderIntel,
          behavior: compareHolderSnapshots(null, null),
          marketBehavior: classifyMarketBehavior({ snapshot, holderIntel: null, behavior: null }),
        };
      }

      holderIntel.holderCount = snapshot.holderCount;
      const previous = this.behaviorHistory.get(address) || null;
      const behavior = compareHolderSnapshots(previous, {
        holderCount: snapshot.holderCount,
        top10Pct: holderIntel.top10Pct,
        top20Pct: holderIntel.top20Pct,
        creatorPct: holderIntel.creatorPct,
      });
      const marketBehavior = classifyMarketBehavior({ snapshot, holderIntel, behavior });

      this.behaviorHistory.set(address, {
        timestamp: Date.now(),
        holderCount: snapshot.holderCount,
        top10Pct: holderIntel.top10Pct,
        top20Pct: holderIntel.top20Pct,
        creatorPct: holderIntel.creatorPct,
      });

      return { holderIntelligence: holderIntel, behavior, marketBehavior };
    } catch (err) {
      this.onError(err, `holderIntelligence(${address})`);
      return {
        holderIntelligence: { available: false, reason: "Holder analysis failed" },
        behavior: compareHolderSnapshots(null, null),
        marketBehavior: classifyMarketBehavior({ snapshot, holderIntel: null, behavior: null }),
      };
    }
  }

  async evaluateOne(tokenAddress) {
    try {
      const snapshot = await buildSnapshot(tokenAddress, {
        birdeyeApiKey: this.birdeyeApiKey,
        heliusApiKey: this.heliusApiKey,
        rpcUrl: this.rpcUrl,
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

    const keys = {
      birdeyeApiKey: this.birdeyeApiKey,
      heliusApiKey: this.heliusApiKey,
      rpcUrl: this.rpcUrl,
    };

    // Preserve the original sequential processing to avoid upstream 429s.
    for (const address of candidates) {
      if (this.alertedMints.has(address)) continue;

      let snapshot;
      try { snapshot = await buildSnapshot(address, keys); }
      catch (_) { continue; }

      // ORIGINAL AGE + LIQUIDITY FILTERS.
      if (snapshot.tokenAgeSeconds != null &&
          (snapshot.tokenAgeSeconds < this.minAgeSeconds || snapshot.tokenAgeSeconds > this.maxAgeSeconds)) continue;
      if (!(snapshot.liquidityUsd > 0)) continue;

      // ORIGINAL RADAR SCORE FILTER.
      const result = scoreToken(snapshot);
      if (result.score < this.minScore) continue;
      if (result.verificationConfidencePct < this.minVerificationConfidencePct) continue;

      let rugAssessment;
      try { rugAssessment = await this._assessRug(address, snapshot, result.liqMcPct); }
      catch (_) { continue; }

      // ORIGINAL V4 SAFETY FILTERS — values remain controlled by existing env vars.
      if (rugAssessment.rugProbabilityPct == null) continue;
      if (rugAssessment.rugProbabilityPct > this.maxRugProbabilityPct) continue;

      const finalVerificationConfidencePct = this._finalVerificationConfidence(snapshot, rugAssessment);
      snapshot.verificationConfidencePct = finalVerificationConfidencePct;
      result.verificationConfidencePct = finalVerificationConfidencePct;

      if (finalVerificationConfidencePct < this.minVerificationConfidencePct) continue;
      if (this.requireAuthorityData && snapshot.authorityDataAvailable !== true) continue;
      if (this.requireRugCheck && !rugAssessment.rugCheckAvailable) continue;
      if (snapshot.liquidityUsd < this.minLiquidityUsd) continue;

      // V5: only after ALL original filters pass do we spend extra RPC calls on
      // wallet-level intelligence. This keeps the original probability pipeline intact.
      const behavior = await this._getHolderBehavior(address, snapshot);

      const earlySignal = this.earlySignals.get(address) || null;
      const sniperSignal = earlySignal && Number(earlySignal.signalScore) >= 35 ? earlySignal : null;

      this.alertedMints.add(address);
      try {
        await this.onAlert(snapshot, result, rugAssessment, sniperSignal, behavior);
      } catch (err) {
        this.onError(err, `onAlert(${address})`);
      }

      await new Promise((r) => setTimeout(r, 1100));
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
    return () => { stopped = true; if (this._timer) clearTimeout(this._timer); };
  }
}

module.exports = { Watchlist };
