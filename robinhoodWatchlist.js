"use strict";

const { discoverRobinhoodLaunches, getRobinhoodTokenData } = require("./robinhoodClient");
const { scoreRobinhoodToken } = require("./robinhoodScoring");
const { assessRobinhoodRisk } = require("./robinhoodRisk");

function verificationScore(s) {
  const d = s.dataSources || {};
  let score = 0;
  if (d.launchpad) score += 20;
  if (d.dexScreener) score += 20;
  if (d.blockscout) score += 15;
  if (d.holderCounters) score += 15;
  if (d.holderDistribution) score += 10;
  if (d.contractChecks) score += 20;
  return score;
}

class RobinhoodWatchlist {
  constructor(opts = {}) {
    this.minAgeSeconds = opts.minAgeSeconds ?? 30;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 21600;
    this.minScore = opts.minScore ?? 70;
    this.minVerificationConfidencePct = opts.minVerificationConfidencePct ?? 80;
    this.maxRiskPct = opts.maxRiskPct ?? 35;
    this.minLiquidityUsd = opts.minLiquidityUsd ?? 10000;
    this.minHolders = opts.minHolders ?? 25;
    this.requireLaunchpad = opts.requireLaunchpad ?? true;
    this.rpcUrl = opts.rpcUrl;
    this.onAlert = opts.onAlert || (async () => {});
    this.onError = opts.onError || (() => {});
    this.alerted = new Set();
  }

  async evaluateOne(address) {
    const launches = await discoverRobinhoodLaunches();
    const launch = launches.find((x) => x.tokenAddress.toLowerCase() === address.toLowerCase()) || {
      tokenAddress: address,
      name: "Unknown",
      symbol: "TOKEN",
      factory: null,
      createdAtMs: null,
      raw: {},
    };
    const snapshot = await getRobinhoodTokenData(launch, { rpcUrl: this.rpcUrl });
    snapshot.verificationConfidencePct = verificationScore(snapshot);
    snapshot.dataQualityScore = snapshot.verificationConfidencePct;
    const result = scoreRobinhoodToken(snapshot);
    const risk = assessRobinhoodRisk(snapshot);
    return { snapshot, result, rugAssessment: risk, launch };
  }

  async pollOnce() {
    const launches = await discoverRobinhoodLaunches();
    if (!launches.length) return;

    for (const launch of launches) {
      const address = launch.tokenAddress.toLowerCase();
      if (this.alerted.has(address)) continue;
      try {
        const snapshot = await getRobinhoodTokenData(launch, { rpcUrl: this.rpcUrl });
        snapshot.verificationConfidencePct = verificationScore(snapshot);
        snapshot.dataQualityScore = snapshot.verificationConfidencePct;

        if (snapshot.tokenAgeSeconds != null && (snapshot.tokenAgeSeconds < this.minAgeSeconds || snapshot.tokenAgeSeconds > this.maxAgeSeconds)) continue;
        if (this.requireLaunchpad && String(snapshot.launchFactory || "").toLowerCase() !== "0xfb21934bb01b4d7b83beb8af6e6fd553f049e632") continue;
        if (!(snapshot.liquidityUsd >= this.minLiquidityUsd)) continue;
        if (snapshot.holderCount != null && snapshot.holderCount < this.minHolders) continue;
        if (snapshot.holderCount == null) continue;
        if (!snapshot.authorityDataAvailable) continue;
        if (snapshot.verificationConfidencePct < this.minVerificationConfidencePct) continue;

        const result = scoreRobinhoodToken(snapshot);
        if (result.score < this.minScore) continue;

        const risk = assessRobinhoodRisk(snapshot);
        if (risk.rugProbabilityPct > this.maxRiskPct) continue;

        this.alerted.add(address);
        await this.onAlert(snapshot, result, risk, launch);
      } catch (err) {
        this.onError(err, `robinhood:${address}`);
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
    return () => { stopped = true; if (this._timer) clearTimeout(this._timer); };
  }
}

module.exports = { RobinhoodWatchlist };
