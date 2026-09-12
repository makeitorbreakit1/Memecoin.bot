console.log("🚀 TOKEN RADAR V6 - MULTI-CHAIN + HELIUS RATE-LIMIT PROTECTION");
"use strict";

require("dotenv").config();
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { Watchlist } = require("./lib/watchlist");
const { buildRadarEmbed } = require("./lib/messageFormatter");

const {
  DISCORD_TOKEN, CHANNEL_ID, BIRDEYE_API_KEY, HELIUS_API_KEY, RPC_URL, RUGCHECK_API_KEY, PING_ROLE_ID,
  POLL_INTERVAL_MS = "30000", MIN_TOKEN_AGE_SECONDS = "60", MAX_TOKEN_AGE_SECONDS = "21600",
  MIN_SCORE_TO_ALERT = "70", MIN_VERIFICATION_CONFIDENCE_PCT = "80", MAX_RUG_PROBABILITY_PCT = "35",
  MIN_LIQUIDITY_USD = "10000", REQUIRE_RUGCHECK = "true", REQUIRE_AUTHORITY_DATA = "true",
} = process.env;

for (const key of ["DISCORD_TOKEN", "CHANNEL_ID"]) {
  if (!process.env[key]) { console.error(`[startup] Missing required env var: ${key}`); process.exit(1); }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const radarCommand = new SlashCommandBuilder()
  .setName("radar")
  .setDescription("Run a radar check on a token on any DexScreener-supported chain")
  .addStringOption((opt) => opt.setName("address").setDescription("Token mint / contract address").setRequired(true));

async function registerCommands() {
  if (!client.application?.id) return;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), { body: [radarCommand.toJSON()] });
    console.log("[startup] Slash command /radar registered for multi-chain V6.");
  } catch (err) { console.error("[startup] Slash command registration failed:", err.message); }
}

let watchlist;

async function runRadar(address, reply) {
  if (!watchlist) return reply("Radar is still starting up. Try again in a few seconds.");
  const evaluation = await watchlist.evaluateOne(address);
  if (!evaluation) return reply("Couldn't find a usable DEX pair for that address. Make sure you pasted the token contract/mint address.");
  const embed = buildRadarEmbed(evaluation.snapshot, evaluation.result, evaluation.rugAssessment, null, evaluation);
  return reply({ embeds: [embed] });
}

async function postAlert(snapshot, result, rugAssessment, earlySignal = null, behavior = null) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch((err) => { console.error("[postAlert] Channel fetch failed:", err.message); return null; });
  if (!channel?.send) return;
  const embed = buildRadarEmbed(snapshot, result, rugAssessment, earlySignal, behavior);
  const content = result.score >= 70 && PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;
  await channel.send({ content, embeds: [embed] }).catch((err) => console.error("[postAlert] Send failed:", err.message));
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[startup] Logged in as ${c.user.tag}`);
  await registerCommands();
  watchlist = new Watchlist({
    minAgeSeconds: Number(MIN_TOKEN_AGE_SECONDS), maxAgeSeconds: Number(MAX_TOKEN_AGE_SECONDS), minScore: Number(MIN_SCORE_TO_ALERT),
    minVerificationConfidencePct: Number(MIN_VERIFICATION_CONFIDENCE_PCT), maxRugProbabilityPct: Number(MAX_RUG_PROBABILITY_PCT),
    minLiquidityUsd: Number(MIN_LIQUIDITY_USD), requireRugCheck: REQUIRE_RUGCHECK.toLowerCase() === "true",
    requireAuthorityData: REQUIRE_AUTHORITY_DATA.toLowerCase() === "true", birdeyeApiKey: BIRDEYE_API_KEY, heliusApiKey: HELIUS_API_KEY,
    rpcUrl: RPC_URL || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null), rugcheckApiKey: RUGCHECK_API_KEY,
    onAlert: postAlert, onError: (err, ctx) => console.error(`[watchlist:${ctx}]`, err.message),
  });
  const stopPolling = watchlist.start(Number(POLL_INTERVAL_MS));
  console.log(`[startup] Polling every ${POLL_INTERVAL_MS}ms.`);
  const shutdown = () => { stopPolling(); client.destroy(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "radar") return;
  const address = interaction.options.getString("address", true).trim();
  await interaction.deferReply();
  await runRadar(address, (payload) => interaction.editReply(payload));
});

// V6 also supports the original prefix style: .radar ADDRESS
// This prevents the old prefix workflow from depending on a stale Discord slash command.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = String(message.content || "").trim();
  const match = content.match(/^\.radar(?:\s+)(\S+)$/i);
  if (!match) return;
  await runRadar(match[1], (payload) => message.reply(payload));
});

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
client.on(Events.Error, (err) => console.error("[discord.js client error]", err));
client.login(DISCORD_TOKEN).catch((err) => { console.error("[startup] Failed to log in:", err.message); process.exit(1); });
