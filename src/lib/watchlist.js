"use strict";

/**
 * watchlist.js
 * ------------------------------------------------------------------
 * Orchestrates the batched poll loop with rate-limit throttling:
 * discover tokens -> batch snapshots -> score -> assess rug risk -> emit alerts.
 * ------------------------------------------------------------------
 */

const { discoverNewTokens, getRugCheckReport } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");
const { fetchMintAuthorityStatus, assessRugRisk } = require("./rugChecker");

class Watchlist {
  constructor(opts) {
    this.minAgeSeconds = opts.minAgeSeconds;
    this.maxAgeSeconds = opts.maxAgeSeconds;
    this.minScore = opts.minScore;
    this.minVerificationConfidencePct = opts.minVerificationConfidencePct ?? 58;
    this.birdeyeApiKey = opts.birdeyeApiKey;
    this.heliusApiKey = opts.heliusApiKey;
    this.rpcUrl = opts.rpcUrl;
    this.rugcheckApiKey = opts.rugcheckApiKey;
    this.onAlert = opts.onAlert;
    this.onError = opts.onError ?? ((err, ctx) => console.error(`[watchlist] ${ctx}:`, err));

    this.alertedMints = new Set();
  }

  async _assessRug(address, snapshot, liqMcPct) {
    const [mintAuthorityStatus, rugCheckReport] = await Promise.all([
      fetchMintAuthorityStatus(address, this.rpcUrl),
      getRugCheckReport(address),
    ]);
    return assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport });
  }

  async evaluateOne(tokenAddress) {
    try {
      const snapshot = await buildSnapshot(tokenAddress, {
        birdeyeApiKey: this.birdeyeApiKey,
        heliusApiKey: this.heliusApiKey,
        rpcUrl: this.rpcUrl,
        rugcheckApiKey: this.rugcheckApiKey,
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
    try {
      candidates = await discoverNewTokens();
    } catch (err) {
      this.onError(err, "discoverNewTokens");
      return;
    }

    const keys = {
      birdeyeApiKey: this.birdeyeApiKey,
      heliusApiKey: this.heliusApiKey,
      rpcUrl: this.rpcUrl,
      rugcheckApiKey: this.rugcheckApiKey,
    };

    // Process tokens in controlled batches to protect API rate limits (Birdeye/RPC)
    const batchSize = 3;
    const delayMs = 350;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (address) => {
          if (this.alertedMints.has(address)) return;

          let snapshot;
          try {
            snapshot = await buildSnapshot(address, keys);
          } catch (err) {
            return; // Silently skip individual fetch errors
          }

          if (snapshot.tokenAgeSeconds != null) {
            if (
              snapshot.tokenAgeSeconds < this.minAgeSeconds ||
              snapshot.tokenAgeSeconds > this.maxAgeSeconds
            ) {
              return;
            }
          }

          // Safe liquidity check guard
          const liquidity = snapshot.liquidityUsd ?? 0;
          if (liquidity <= 0) return;

          const result = scoreToken(snapshot);
          if (result.score < this.minScore) return;

          // STRICT GATE 1: Verification confidence floor must be >= 58%
          if (result.verificationConfidencePct < this.minVerificationConfidencePct) return;

          let rugAssessment;
          try {
            rugAssessment = await this._assessRug(address, snapshot, result.liqMcPct);
          } catch (err) {
            return;
          }

          // STRICT GATE 2: Must have a successfully calculated numeric rug probability percentage
          if (rugAssessment.rugProbabilityPct == null) {
            return;
          }

          // STRICT GATE 3: Block tokens with high rug pull probability (> 65%)
          if (rugAssessment.rugProbabilityPct > 65) {
            return;
          }

          this.alertedMints.add(address);
          try {
            await this.onAlert(snapshot, result, rugAssessment);
          } catch (err) {
            this.onError(err, `onAlert(${address})`);
          }
        })
      );

      if (i + batchSize < candidates.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  start(intervalMs) {
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      await this.pollOnce();
      if (!stopped) this._timer = setTimeout(loop, intervalMs);
    };
    loop();
    return () => {
      stopped = true;
      if (this._timer) clearTimeout(this._timer);
    };
  }
}

module.exports = { Watchlist };
