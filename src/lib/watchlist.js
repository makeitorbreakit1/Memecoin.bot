"use strict";

/**
 * watchlist.js
 * ------------------------------------------------------------------
 * Orchestrates the poll loop: discover candidate tokens -> build
 * snapshots -> score -> assess rug risk -> emit alerts for anything
 * crossing the score/confidence thresholds that hasn't already been
 * alerted. Keeps a small in-memory dedupe set so restarting the
 * process is the only way to re-alert on the same mint (fine for a
 * lightweight bot; swap for Redis/sqlite if you need persistence
 * across restarts).
 * ------------------------------------------------------------------
 */

const pLimit = require("p-limit");
const { discoverNewTokens, getRugCheckReport } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");
const { fetchMintAuthorityStatus, assessRugRisk } = require("./rugChecker");

class Watchlist {
  /**
   * @param {object} opts
   * @param {number} opts.minAgeSeconds
   * @param {number} opts.maxAgeSeconds
   * @param {number} opts.minScore
   * @param {number} [opts.minVerificationConfidencePct] - alerts below this Verification confidence % are filtered out (default 58)
   * @param {string} [opts.birdeyeApiKey]
   * @param {string} [opts.heliusApiKey]
   * @param {string} [opts.rpcUrl] - Solana RPC endpoint used for mint/freeze authority checks
   * @param {string} [opts.rugcheckApiKey] - optional RugCheck.xyz API key
   * @param {(snapshot: object, result: object, rugAssessment: object) => Promise<void>} opts.onAlert
   * @param {(err: Error, context: string) => void} [opts.onError]
   */
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
    this.limit = pLimit(5); // cap concurrent snapshot builds to be API-friendly
  }

  /** Run the mint-authority + RugCheck lookups for one address and combine into a RugAssessment. */
  async _assessRug(address, snapshot, liqMcPct) {
    const [mintAuthorityStatus, rugCheckReport] = await Promise.all([
      fetchMintAuthorityStatus(address, this.rpcUrl),
      getRugCheckReport(address, this.rugcheckApiKey),
    ]);
    return assessRugRisk({ snapshot, liqMcPct, mintAuthorityStatus, rugCheckReport });
  }

  /** Manually queue a specific token address for evaluation (e.g. from a Discord command). */
  async evaluateOne(tokenAddress) {
    try {
      const snapshot = await buildSnapshot(tokenAddress, {
        birdeyeApiKey: this.birdeyeApiKey,
        heliusApiKey: this.heliusApiKey,
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

    const jobs = candidates.map((address) =>
      this.limit(async () => {
        if (this.alertedMints.has(address)) return;

        let snapshot;
        try {
          snapshot = await buildSnapshot(address, {
            birdeyeApiKey: this.birdeyeApiKey,
            heliusApiKey: this.heliusApiKey,
          });
        } catch (err) {
          this.onError(err, `buildSnapshot(${address})`);
          return;
        }

        if (snapshot.tokenAgeSeconds != null) {
          if (
            snapshot.tokenAgeSeconds < this.minAgeSeconds ||
            snapshot.tokenAgeSeconds > this.maxAgeSeconds
          ) {
            return; // outside the "freshly launched" window
          }
        }

        // Liquidity must be confirmed (a live, non-null liquidity reading) —
        // a token with no resolvable liquidity figure is not eligible for
        // an alert regardless of score.
        if (snapshot.liquidityUsd == null) return;

        const result = scoreToken(snapshot);
        if (result.score < this.minScore) return;

        // Verification confidence floor — anything below this is filtered
        // out of automatic call-outs, even if the score itself is high.
        if (result.verificationConfidencePct < this.minVerificationConfidencePct) return;

        let rugAssessment;
        try {
          rugAssessment = await this._assessRug(address, snapshot, result.liqMcPct);
        } catch (err) {
          this.onError(err, `assessRug(${address})`);
          rugAssessment = {
            rugProbabilityPct: null,
            riskLevel: "Unknown",
            flags: ["Rug check failed to run"],
            unresolvedNotes: ["rug check threw an error"],
            dataCoveragePct: 0,
          };
        }

        this.alertedMints.add(address);
        try {
          await this.onAlert(snapshot, result, rugAssessment);
        } catch (err) {
          this.onError(err, `onAlert(${address})`);
        }
      })
    );

    await Promise.all(jobs);
  }

  /** Start polling on an interval. Returns a stop() function. */
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
