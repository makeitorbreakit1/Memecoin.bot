"use strict";

const { EmbedBuilder } = require("discord.js");

function money(v) {
  if (v == null || !Number.isFinite(Number(v))) return "N/A";
  const n = Number(v);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n < 0.001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(n < 1 ? 6 : 2)}`;
}
function pct(v) { return v == null || !Number.isFinite(Number(v)) ? "N/A" : `${Number(v).toFixed(1)}%`; }
function num(v) { return v == null || !Number.isFinite(Number(v)) ? "N/A" : Number(v).toLocaleString(); }
function age(sec) {
  if (sec == null) return "N/A";
  const m = Math.floor(Number(sec) / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function buildRadarEmbed(snapshot, result, rug, earlySignal = null, behavior = null) {
  const score = Number(result?.score ?? 0);
  const rugPct = rug?.rugProbabilityPct;
  const isSniper = !!earlySignal;
  const title = `${isSniper ? "🎯 SNIPER CANDIDATE" : "📡 RADAR ALERT"} — ${snapshot.symbol || "TOKEN"} ${score}/100`;
  const color = score >= 70 && (rugPct == null || rugPct <= 35) ? 0x2ecc71 : score >= 55 ? 0xf1c40f : 0xe74c3c;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`${snapshot.name || "Unknown"}\n\n**Chain:** ${String(snapshot.chain || "unknown").toUpperCase()}\n${snapshot.pairUrl ? `[View on DexScreener](${snapshot.pairUrl})` : "No DEX link available"}`)
    .setColor(color)
    .addFields(
      { name: "💰 Price", value: money(snapshot.priceUsd), inline: true },
      { name: "💧 Liquidity", value: money(snapshot.liquidityUsd), inline: true },
      { name: "📊 Market Cap", value: money(snapshot.marketCapUsd), inline: true },
      { name: "📈 24h Volume", value: money(snapshot.volume24hUsd), inline: true },
      { name: "🕐 Age", value: age(snapshot.tokenAgeSeconds), inline: true },
      { name: "👥 Holders", value: num(snapshot.holderCount), inline: true },
      { name: "🟢 Buys 24h", value: num(snapshot.buys24h), inline: true },
      { name: "🔴 Sells 24h", value: num(snapshot.sells24h), inline: true },
      { name: "⚖️ Buy/Sell", value: snapshot.buySellRatio24 == null ? "N/A" : `${snapshot.buySellRatio24.toFixed(2)}x`, inline: true },
      { name: "📈 1h", value: pct(snapshot.priceChange1hPct), inline: true },
      { name: "📈 24h", value: pct(snapshot.priceChange24hPct), inline: true },
      { name: "🎯 Liquidity/MC", value: pct(result?.liqMcPct), inline: true },
      { name: "🛡️ Verification", value: `${result?.verificationConfidencePct ?? 0}%`, inline: true },
      { name: "🚨 Rug Probability", value: rugPct == null ? (snapshot.chain === "solana" ? "Unknown" : "N/A — EVM mode") : `${rugPct}% (${rug.riskLevel})`, inline: true },
      { name: "🔐 Authorities", value: snapshot.chain === "solana" ? `${rug?.mintAuthorityRenounced ? "Mint ✓" : "Mint ⚠️"}  ${rug?.freezeAuthorityRenounced ? "Freeze ✓" : "Freeze ⚠️"}` : "N/A — EVM mode", inline: true },
    )
    .setFooter({ text: isSniper ? "Early-launch screening • Automated • Not financial advice" : "Automated screening — not financial advice" })
    .setTimestamp();

  if (isSniper) {
    const s = earlySignal.social || {};
    embed.addFields({
      name: "🔥 Early Launch Signal",
      value: [
        `Signal score: **${earlySignal.signalScore ?? 0}/85**`,
        `Social link: ${s.hasTwitter ? "✅ X/Twitter" : "❌ None detected"}`,
        `Website: ${s.hasWebsite ? "✅" : "❌"}`,
        `Launch language: ${s.hasLaunchLanguage ? "✅" : "❌"}`,
        s.twitterUrl ? `[Open social profile](${s.twitterUrl})` : null,
      ].filter(Boolean).join("\n"),
      inline: false,
    });
  }

  const hi = behavior?.holderIntelligence;
  const mb = behavior?.marketBehavior;
  const bh = behavior?.behavior;

  if (hi?.available) {
    const labelMap = {
      LONG_TERM_NARRATIVE_CANDIDATE: "🟢 LONG-TERM NARRATIVE CANDIDATE",
      HEALTHY_MOMENTUM: "🟢 HEALTHY MOMENTUM",
      SPECULATIVE: "🟡 SPECULATIVE / EARLY",
      PUMP_AND_DUMP_RISK_MEDIUM: "🟠 PUMP & DUMP RISK — MEDIUM",
      PUMP_AND_DUMP_RISK_HIGH: "🔴 PUMP & DUMP RISK — HIGH",
    };
    embed.addFields({
      name: "🐋 Holder Intelligence",
      value: [
        `Classification: **${labelMap[mb?.classification] || "UNKNOWN"}**`,
        `Largest holder: ${pct(hi.largestHolderPct)}`,
        `Top 10 wallets: ${pct(hi.top10Pct)}`,
        `Top 20 wallets: ${pct(hi.top20Pct)}`,
        `Concentration: **${hi.concentration || "UNKNOWN"}**`,
        `Creator wallet: ${hi.creatorWallet ? `\`${hi.creatorWallet.slice(0, 6)}...${hi.creatorWallet.slice(-4)}\`` : "Not identified"}`,
        `Creator holding: ${pct(hi.creatorPct)}`,
        bh?.holderGrowthPct != null ? `Holder growth since last check: ${bh.holderGrowthPct >= 0 ? "+" : ""}${bh.holderGrowthPct.toFixed(1)}%` : "Holder trend: collecting baseline",
      ].join("\n").slice(0, 1024),
      inline: false,
    });

    if (mb?.reasons?.length || bh?.signals?.length) {
      embed.addFields({
        name: "📉 Behavior Signals",
        value: [...new Set([...(mb?.reasons || []), ...(bh?.signals || [])])].map((x) => `• ${x}`).join("\n").slice(0, 1024),
        inline: false,
      });
    }
  }

  if (rug?.reasons?.length) embed.addFields({ name: "⚠️ Contract / Rug Signals", value: rug.reasons.map((x) => `• ${x}`).join("\n").slice(0, 1024) });
  return embed;
}

module.exports = { buildRadarEmbed };
