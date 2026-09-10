"use strict";

const { discoverNewTokens, getRugCheckReport } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");
const { fetchMintAuthorityStatus, assessRugRisk } = require("./rugChecker");

class Watchlist {
  constructor(opts = {}) {
    this.minAgeSeconds = opts.minAgeSeconds ?? 60;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 21600;
    this.minScore = opts.minScore ?? 55;
    this.minVerificationConfidencePct = opts.minVerificationConfidencePct ?? 58;
    this.birdeyeApiKey = opts.birdeyeApiKey;
    this.heliusApiKey = opts.heliusApiKey;
    this.rpcUrl = opts.rpcUrl;
    this.rugcheckApiKey = opts.rugcheckApiKey;
    this.onAlert = opts.onAlert ?? (async () => {});
    this.onError = opts.onError ?? (() => {});
    this.alertedMints = new Set();
  }

  async _assessRug(address, snapshot, liqMcPct) {
    const [mintAuthorityStatus, rugCheckReport] = await Promise.all([
      fetchMintAuthorityStatus(address, this.rpcUrl),
      getRugCheckReport(address, this.rugcheckApiKey),
    ]);
    return assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport });
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
      return { snapshot, result, rugAssessment };
    } catch (err) {
      this.onError(err, `evaluateOne(${tokenAddress})`);
      return null;
    }
  }

  async pollOnce() {
    let candidates = [];
    try { candidates = await discoverNewTokens(); }
    catch (err) { this.onError(err, "discoverNewTokens"); return; }

    const keys = {
      birdeyeApiKey: this.birdeyeApiKey,
      heliusApiKey: this.heliusApiKey,
      rpcUrl: this.rpcUrl,
    };

    // Deliberately process one token at a time. Birdeye Standard is currently
    // 1 rps, so parallel candidate hydration creates avoidable 429s.
    for (const address of candidates) {
      if (this.alertedMints.has(address)) continue;

      let snapshot;
      try { snapshot = await buildSnapshot(address, keys); }
      catch (_) { continue; }

      if (snapshot.tokenAgeSeconds != null &&
          (snapshot.tokenAgeSeconds < this.minAgeSeconds || snapshot.tokenAgeSeconds > this.maxAgeSeconds)) continue;
      if (!(snapshot.liquidityUsd > 0)) continue;

      const result = scoreToken(snapshot);
      if (result.score < this.minScore) continue;
      if (result.verificationConfidencePct < this.minVerificationConfidencePct) continue;

      let rugAssessment;
      try { rugAssessment = await this._assessRug(address, snapshot, result.liqMcPct); }
      catch (_) { continue; }

      if (rugAssessment.rugProbabilityPct == null) continue;
      if (rugAssessment.rugProbabilityPct > 65) continue;

      this.alertedMints.add(address);
      try { await this.onAlert(snapshot, result, rugAssessment); }
      catch (err) { this.onError(err, `onAlert(${address})`); }

      // Give low-tier upstream plans a little breathing room between tokens.
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
