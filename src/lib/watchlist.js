"use strict";

/**
 * watchlist.js
 * ------------------------------------------------------------------
 * Orchestrates the poll loop: discover candidate tokens -> build
 * snapshots -> score -> emit alerts for anything crossing the score
 * threshold that hasn't already been alerted. Keeps a small in-
 * memory dedupe set so restarting the process is the only way to
 * re-alert on the same mint (fine for a lightweight bot; swap for
 * Redis/sqlite if you need persistence across restarts).
 * ------------------------------------------------------------------
 */

const pLimit = require("p-limit");
const { discoverNewTokens } = require("./apiClient");
const { buildSnapshot } = require("./snapshotBuilder");
const { scoreToken } = require("./scoringEngine");

class Watchlist {
  /**
   * @param {object} opts
   * @param {number} opts.minAgeSeconds
   * @param {number} opts.maxAgeSeconds
   * @param {number} opts.minScore
   * @param {string} [opts.birdeyeApiKey]
   * @param {string} [opts.heliusApiKey]
   * @param {(snapshot: object, result: object) => Promise<void>} opts.onAlert
   * @param {(err: Error, context: string) => void} [opts.onError]
   */
  constructor(opts) {
    this.minAgeSeconds = opts.minAgeSeconds;
    this.maxAgeSeconds = opts.maxAgeSeconds;
    this.minScore = opts.minScore;
    this.birdeyeApiKey = opts.birdeyeApiKey;
    this.heliusApiKey = opts.heliusApiKey;
    this.onAlert = opts.onAlert;
    this.onError = opts.onError ?? ((err, ctx) => console.error(`[watchlist] ${ctx}:`, err));

    this.alertedMints = new Set();
    this.limit = pLimit(5); // cap concurrent snapshot builds to be API-friendly
  }

  /** Manually queue a specific token address for evaluation (e.g. from a Discord command). */
  async evaluateOne(tokenAddress) {
    try {
      const snapshot = await buildSnapshot(tokenAddress, {
        birdeyeApiKey: this.birdeyeApiKey,
        heliusApiKey: this.heliusApiKey,
      });
      const result = scoreToken(snapshot);
      return { snapshot, result };
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

        const result = scoreToken(snapshot);
        if (result.score < this.minScore) return;

        this.alertedMints.add(address);
        try {
          await this.onAlert(snapshot, result);
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
