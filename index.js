"use strict";

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const { Watchlist } = require("./lib/watchlist");
const { buildRadarEmbed } = require("./lib/messageFormatter");

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  BIRDEYE_API_KEY,
  HELIUS_API_KEY,
  RPC_URL,
  RUGCHECK_API_KEY,
  PING_ROLE_ID,
  POLL_INTERVAL_MS = "30000",
  MIN_TOKEN_AGE_SECONDS = "60",
  MAX_TOKEN_AGE_SECONDS = "21600",
  MIN_SCORE_TO_ALERT = "55",
  MIN_VERIFICATION_CONFIDENCE_PCT = "58",
} = process.env;

const REQUIRED_VARS = ["DISCORD_TOKEN", "CHANNEL_ID"];
for (const key of REQUIRED_VARS) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

if (!BIRDEYE_API_KEY && !HELIUS_API_KEY) {
  console.warn("[startup] No Birdeye or Helius key set; using public DexScreener data only where possible.");
}
if (!RPC_URL && !HELIUS_API_KEY) {
  console.warn("[startup] No RPC_URL or HELIUS_API_KEY set; on-chain authority checks may be unavailable.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const radarCommand = new SlashCommandBuilder()
  .setName("radar")
  .setDescription("Run an on-demand radar check on a Solana token")
  .addStringOption((opt) =>
    opt.setName("address")
      .setDescription("Token mint / contract address")
      .setRequired(true)
  );

async function registerCommands() {
  if (!client.application?.id) return;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), {
      body: [radarCommand.toJSON()],
    });
    console.log("[startup] Slash command /radar registered.");
  } catch (err) {
    console.error("[startup] Slash command registration failed:", err.message);
  }
}

let watchlist;

async function postAlert(snapshot, result, rugAssessment) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch((err) => {
    console.error("[postAlert] Channel fetch failed:", err.message);
    return null;
  });
  if (!channel?.send) return;

  const embed = buildRadarEmbed(snapshot, result, rugAssessment);
  const content = result.score >= 70 && PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;

  await channel.send({ content, embeds: [embed] }).catch((err) => {
    console.error("[postAlert] Send failed:", err.message);
  });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[startup] Logged in as ${c.user.tag}`);
  await registerCommands();

  watchlist = new Watchlist({
    minAgeSeconds: Number(MIN_TOKEN_AGE_SECONDS),
    maxAgeSeconds: Number(MAX_TOKEN_AGE_SECONDS),
    minScore: Number(MIN_SCORE_TO_ALERT),
    minVerificationConfidencePct: Number(MIN_VERIFICATION_CONFIDENCE_PCT),
    birdeyeApiKey: BIRDEYE_API_KEY,
    heliusApiKey: HELIUS_API_KEY,
    rpcUrl: RPC_URL || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null),
    rugcheckApiKey: RUGCHECK_API_KEY,
    onAlert: postAlert,
    onError: (err, ctx) => console.error(`[watchlist:${ctx}]`, err.message),
  });

  const stopPolling = watchlist.start(Number(POLL_INTERVAL_MS));
  console.log(`[startup] Polling every ${POLL_INTERVAL_MS}ms.`);

  const shutdown = () => {
    console.log("[shutdown] Stopping poll loop...");
    stopPolling();
    client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "radar") return;

  const address = interaction.options.getString("address", true).trim();
  await interaction.deferReply();

  if (!watchlist) {
    await interaction.editReply("Radar is still starting up. Try again in a few seconds.");
    return;
  }

  const evaluation = await watchlist.evaluateOne(address);
  if (!evaluation) {
    await interaction.editReply("Couldn't build a usable snapshot for that address. Check the mint and try again.");
    return;
  }

  const embed = buildRadarEmbed(evaluation.snapshot, evaluation.result, evaluation.rugAssessment);
  await interaction.editReply({ embeds: [embed] });
});

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
client.on(Events.Error, (err) => console.error("[discord.js client error]", err));
client.on(Events.ShardDisconnect, (event, id) => console.warn(`[shard ${id}] Disconnected:`, event?.reason || event?.code));
client.on(Events.ShardReconnecting, (id) => console.log(`[shard ${id}] Reconnecting...`));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[startup] Failed to log in:", err.message);
  process.exit(1);
});
