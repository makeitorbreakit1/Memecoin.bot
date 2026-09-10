"use strict";

const { EmbedBuilder } = require("discord.js");

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function pct(v) { const n = Number(v); return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "N/A"; }
function link(label, url) { return url ? `[${label}](${url})` : "N/A"; }

function buildRobinhoodEmbed(s, result, risk) {
  const color = risk.rugProbabilityPct <= 15 ? 0x2ecc71 : risk.rugProbabilityPct <= 35 ? 0xf1c40f : 0xe74c3c;
  const age = s.tokenAgeSeconds == null ? "N/A" : s.tokenAgeSeconds < 3600 ? `${Math.floor(s.tokenAgeSeconds / 60)}m` : `${(s.tokenAgeSeconds / 3600).toFixed(1)}h`;
  const social = s.launch || {};

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔵 ROBINHOOD SNIPER CANDIDATE — $${s.symbol}`)
    .setDescription(`**${s.name}**\n\`${s.tokenAddress}\``)
    .addFields(
      { name: "🎯 Radar Score", value: `${result.score}/100`, inline: true },
      { name: "🛡️ Verification", value: `${s.verificationConfidencePct}%`, inline: true },
      { name: "🚨 Rug Probability", value: `${risk.rugProbabilityPct}%`, inline: true },
      { name: "💧 Liquidity", value: money(s.liquidityUsd), inline: true },
      { name: "💰 Market Cap", value: money(s.marketCapUsd), inline: true },
      { name: "👥 Holders", value: s.holderCount != null ? s.holderCount.toLocaleString() : "N/A", inline: true },
      { name: "📊 24h Volume", value: money(s.volume24hUsd), inline: true },
      { name: "⚡ Buy/Sell", value: s.buySellRatio24 != null ? `${s.buySellRatio24.toFixed(2)}x` : "N/A", inline: true },
      { name: "📈 5m / 1h / 24h", value: `${pct(s.priceChange5mPct)} / ${pct(s.priceChange1hPct)} / ${pct(s.priceChange24hPct)}`, inline: false },
      { name: "⏱️ Age", value: age, inline: true },
      { name: "🧑‍💻 Top 10", value: s.top10Pct != null ? `${s.top10Pct.toFixed(1)}%` : "N/A", inline: true },
      { name: "🏭 Launchpad", value: "Launchpad.meme → Robinhood Chain", inline: true },
      { name: "🌐 Links", value: `${link("Website", social.website)} • ${link("X", social.twitter)}${social.telegram ? ` • ${link("Telegram", social.telegram)}` : ""}`, inline: false },
      { name: "🔐 Contract", value: `Factory: ${String(s.launchFactory || "").slice(0, 10)}…\nOwner: ${s.contract?.ownerActive ? "ACTIVE ⚠️" : "renounced/none"}\nPaused: ${s.contract?.paused == null ? "Unknown" : s.contract.paused ? "YES ⚠️" : "No"}`, inline: false },
    )
    .setFooter({ text: `Robinhood Chain • Chain ID 4663 • Risk model: ${risk.methodology}` })
    .setTimestamp();

  if (social.icon) embed.setThumbnail(social.icon);
  if (risk.reasons?.length) embed.addFields({ name: "⚠️ Risk Factors", value: risk.reasons.map((x) => `• ${x}`).join("\n").slice(0, 1024), inline: false });
  return embed;
}

module.exports = { buildRobinhoodEmbed };
