console.log("🚀 MEME RADAR V6 - SOLANA + ROBINHOOD CHAIN - BUILD 2026-09-10");
"use strict";

// Automatically route /radar to the correct chain.
// Robinhood Chain ERC-20 contracts are EVM addresses (0x + 40 hex chars).
// Solana token mints use base58 and do not have the 0x prefix.
function isRobinhoodAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

require("dotenv").config();
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { Watchlist } = require("./lib/watchlist");
const { buildRadarEmbed } = require("./lib/messageFormatter");
const { RobinhoodWatchlist } = require("./lib/robinhoodWatchlist");
const { buildRobinhoodEmbed } = require("./lib/robinhoodFormatter");

const {
  DISCORD_TOKEN, CHANNEL_ID, BIRDEYE_API_KEY, HELIUS_API_KEY, RPC_URL, RUGCHECK_API_KEY, PING_ROLE_ID,
  POLL_INTERVAL_MS = "30000", MIN_TOKEN_AGE_SECONDS = "60", MAX_TOKEN_AGE_SECONDS = "21600",
  MIN_SCORE_TO_ALERT = "70", MIN_VERIFICATION_CONFIDENCE_PCT = "80", MAX_RUG_PROBABILITY_PCT = "35",
  MIN_LIQUIDITY_USD = "10000", REQUIRE_RUGCHECK = "true", REQUIRE_AUTHORITY_DATA = "true",
  ROBINHOOD_ENABLED = "true", ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com",
  ROBINHOOD_MIN_TOKEN_AGE_SECONDS = "30", ROBINHOOD_MAX_TOKEN_AGE_SECONDS = "21600",
  ROBINHOOD_MIN_SCORE_TO_ALERT = "70", ROBINHOOD_MIN_VERIFICATION_CONFIDENCE_PCT = "80",
  ROBINHOOD_MAX_RUG_PROBABILITY_PCT = "35", ROBINHOOD_MIN_LIQUIDITY_USD = "10000",
  ROBINHOOD_MIN_HOLDERS = "25", ROBINHOOD_REQUIRE_LAUNCHPAD = "true",
} = process.env;

for (const key of ["DISCORD_TOKEN", "CHANNEL_ID"]) {
  if (!process.env[key]) { console.error(`[startup] Missing required env var: ${key}`); process.exit(1); }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  new SlashCommandBuilder().setName("radar").setDescription("Run an on-demand radar check (Solana or Robinhood Chain)").addStringOption((opt) => opt.setName("address").setDescription("Solana mint or Robinhood Chain 0x contract").setRequired(true)),
  new SlashCommandBuilder().setName("rh-radar").setDescription("Run an on-demand radar check on a Robinhood Chain token").addStringOption((opt) => opt.setName("address").setDescription("Robinhood Chain ERC-20 contract").setRequired(true)),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try { await rest.put(Routes.applicationCommands(client.application.id), { body: commands.map((x) => x.toJSON()) }); console.log("[startup] Slash commands registered."); }
  catch (err) { console.error("[startup] Slash command registration failed:", err.message); }
}

let solanaWatchlist;
let robinhoodWatchlist;

async function postSolanaAlert(snapshot, result, rugAssessment, earlySignal = null, behavior = null) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.send) return;
  const embed = buildRadarEmbed(snapshot, result, rugAssessment, earlySignal, behavior);
  const content = result.score >= 70 && PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;
  await channel.send({ content, embeds: [embed] }).catch((err) => console.error("[Solana alert]", err.message));
}

async function postRobinhoodAlert(snapshot, result, risk) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.send) return;
  const embed = buildRobinhoodEmbed(snapshot, result, risk);
  const content = result.score >= 70 && PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;
  await channel.send({ content, embeds: [embed] }).catch((err) => console.error("[Robinhood alert]", err.message));
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[startup] Logged in as ${c.user.tag}`);
  await registerCommands();

  solanaWatchlist = new Watchlist({
    minAgeSeconds: Number(MIN_TOKEN_AGE_SECONDS), maxAgeSeconds: Number(MAX_TOKEN_AGE_SECONDS), minScore: Number(MIN_SCORE_TO_ALERT),
    minVerificationConfidencePct: Number(MIN_VERIFICATION_CONFIDENCE_PCT), maxRugProbabilityPct: Number(MAX_RUG_PROBABILITY_PCT),
    minLiquidityUsd: Number(MIN_LIQUIDITY_USD), requireRugCheck: REQUIRE_RUGCHECK.toLowerCase() === "true", requireAuthorityData: REQUIRE_AUTHORITY_DATA.toLowerCase() === "true",
    birdeyeApiKey: BIRDEYE_API_KEY, heliusApiKey: HELIUS_API_KEY,
    rpcUrl: RPC_URL || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null), rugcheckApiKey: RUGCHECK_API_KEY,
    onAlert: postSolanaAlert, onError: (err, ctx) => console.error(`[watchlist:${ctx}]`, err.message),
  });
  const stopSolana = solanaWatchlist.start(Number(POLL_INTERVAL_MS));

  let stopRobinhood = () => {};
  if (ROBINHOOD_ENABLED.toLowerCase() === "true") {
    robinhoodWatchlist = new RobinhoodWatchlist({
      minAgeSeconds: Number(ROBINHOOD_MIN_TOKEN_AGE_SECONDS), maxAgeSeconds: Number(ROBINHOOD_MAX_TOKEN_AGE_SECONDS),
      minScore: Number(ROBINHOOD_MIN_SCORE_TO_ALERT), minVerificationConfidencePct: Number(ROBINHOOD_MIN_VERIFICATION_CONFIDENCE_PCT),
      maxRiskPct: Number(ROBINHOOD_MAX_RUG_PROBABILITY_PCT), minLiquidityUsd: Number(ROBINHOOD_MIN_LIQUIDITY_USD),
      minHolders: Number(ROBINHOOD_MIN_HOLDERS), requireLaunchpad: ROBINHOOD_REQUIRE_LAUNCHPAD.toLowerCase() === "true",
      rpcUrl: ROBINHOOD_RPC_URL, onAlert: postRobinhoodAlert, onError: (err, ctx) => console.error(`[watchlist:${ctx}]`, err.message),
    });
    stopRobinhood = robinhoodWatchlist.start(Number(POLL_INTERVAL_MS));
  }

  console.log(`[startup] Solana + Robinhood polling every ${POLL_INTERVAL_MS}ms. Robinhood enabled=${ROBINHOOD_ENABLED}`);
  const shutdown = () => { stopSolana(); stopRobinhood(); client.destroy(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  try {
    if (interaction.commandName === "radar") {
      const address = interaction.options.getString("address", true).trim();

      // /radar automatically selects the chain from the address format.
      if (isRobinhoodAddress(address)) {
        if (!robinhoodWatchlist) return interaction.editReply("Robinhood radar is disabled or still starting up.");
        const e = await robinhoodWatchlist.evaluateOne(address);
        if (!e) return interaction.editReply("Couldn't build a usable Robinhood Chain snapshot.");
        return interaction.editReply({ embeds: [buildRobinhoodEmbed(e.snapshot, e.result, e.rugAssessment)] });
      }

      if (!solanaWatchlist) return interaction.editReply("Solana radar is still starting up.");
      const e = await solanaWatchlist.evaluateOne(address);
      if (!e) return interaction.editReply("Couldn't build a usable Solana snapshot.");
      return interaction.editReply({ embeds: [buildRadarEmbed(e.snapshot, e.result, e.rugAssessment, null, e)] });
    }
    if (interaction.commandName === "rh-radar") {
      if (!robinhoodWatchlist) return interaction.editReply("Robinhood radar is disabled.");
      const address = interaction.options.getString("address", true).trim();
      const e = await robinhoodWatchlist.evaluateOne(address);
      return interaction.editReply({ embeds: [buildRobinhoodEmbed(e.snapshot, e.result, e.rugAssessment)] });
    }
  } catch (err) {
    console.error("[interaction]", err);
    await interaction.editReply("Radar evaluation failed. Check Railway logs for details.");
  }
});

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
client.login(DISCORD_TOKEN).catch((err) => { console.error("[startup] Failed to log in:", err.message); process.exit(1); });
