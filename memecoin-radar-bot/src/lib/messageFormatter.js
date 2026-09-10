"use strict";

/**
 * messageFormatter.js
 * ------------------------------------------------------------------
 * Turns a (snapshot, scoreResult) pair into a Discord EmbedBuilder
 * with the "Contract / Market strength / Flow / Why radar fired /
 * Verification confidence" layout.
 * ------------------------------------------------------------------
 */

const { EmbedBuilder } = require("discord.js");
const { formatAge } = require("./scoringEngine");

const HUMAN_FIELD_NAMES = {
  marketCap: "market cap",
  liquidityUsd: "liquidity",
  volume24hUsd: "24h volume",
  tokenAgeSeconds: "token age",
  buys: "buy count",
  sells: "sell count",
  totalTrades: "total trades",
  holders: "holders",
  uniqueWallets: "unique wallets",
  bundleData: "bundle data",
  devHoldingsPct: "dev holdings",
  insiderHoldingsPct: "insider holdings",
};

function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtPct(n, decimals = 1) {
  if (n == null) return "—";
  return `${n.toFixed(decimals)}%`;
}

function scoreColor(score) {
  if (score >= 70) return 0x22c55e; // green
  if (score >= 45) return 0xf59e0b; // amber
  return 0xef4444; // red
}

function scoreLabel(score) {
  if (score >= 70) return "Strong";
  if (score >= 45) return "Moderate";
  return "Weak";
}

/**
 * Build the Discord embed for a scored token.
 * @param {object} snapshot - TokenSnapshot
 * @param {object} result - ScoreResult from scoreToken()
 */
function buildRadarEmbed(snapshot, result) {
  const title = snapshot.symbol
    ? `🛰 Radar hit — $${snapshot.symbol}`
    : "🛰 Radar hit — unknown symbol";

  const contractBlock = "```\n" + snapshot.tokenAddress + "\n```";

  const marketStrength = [
    `**Market Cap:** ${fmtUsd(snapshot.marketCap)}`,
    `**Liquidity:** ${fmtUsd(snapshot.liquidityUsd)}${
      result.liqMcPct != null ? ` (${fmtPct(result.liqMcPct)} of MC)` : ""
    }`,
    `**Volume (24h):** ${fmtUsd(snapshot.volume24hUsd)}${
      result.volMcMultiplier != null ? ` (${result.volMcMultiplier.toFixed(2)}x MC)` : ""
    }`,
  ].join("\n");

  const buySellRatio =
    snapshot.buys != null && snapshot.sells != null
      ? `${snapshot.buys}/${snapshot.sells}`
      : "—";

  const flow = [
    `**Token Age:** ${formatAge(snapshot.tokenAgeSeconds)}`,
    `**Buys/Sells:** ${buySellRatio}${
      result.buyShare != null ? ` (${fmtPct(result.buyShare * 100, 0)} buys)` : ""
    }`,
    `**Total Trades:** ${snapshot.totalTrades ?? "—"}`,
  ].join("\n");

  const whyFired = result.reasons.map((r) => `• ${r}`).join("\n");

  const missingList =
    result.missingFields.length > 0
      ? result.missingFields.map((f) => HUMAN_FIELD_NAMES[f] ?? f).join(", ")
      : "none";

  const verification = [
    `**Confidence:** ${result.verificationConfidencePct}%`,
    `**Missing data:** ${missingList}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(scoreColor(result.score))
    .setDescription(
      `**Radar score:** ${result.score}/100 — ${scoreLabel(result.score)}${
        result.mcZone ? `  ·  ${result.mcZone}` : ""
      }`
    )
    .addFields(
      { name: "Contract", value: contractBlock, inline: false },
      { name: "Market strength", value: marketStrength, inline: true },
      { name: "Flow", value: flow, inline: true },
      { name: "Why radar fired", value: whyFired, inline: false },
      { name: "Verification confidence", value: verification, inline: false }
    )
    .setFooter({
      text:
        "Unofficial automated screen — not financial advice. Missing API data does not " +
        "hide a runner, and it does not confirm legitimacy either. DYOR.",
    })
    .setTimestamp(new Date());

  if (snapshot.dexUrl) {
    embed.setURL(snapshot.dexUrl);
  }

  return embed;
}

module.exports = { buildRadarEmbed, fmtUsd, fmtPct };
