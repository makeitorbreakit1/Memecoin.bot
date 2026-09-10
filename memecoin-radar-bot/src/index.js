"use strict";

/**
 * index.js — main entry point
 * ------------------------------------------------------------------
 * Boots the Discord client, wires the Watchlist poller to a channel,
 * registers a `/radar <address>` slash command for on-demand checks,
 * and handles reconnects / uncaught errors so the process stays up.
 * ------------------------------------------------------------------
 */

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

// ---- Config / env validation --------------------------------------------
const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  BIRDEYE_API_KEY,
  HELIUS_API_KEY,
  PING_ROLE_ID,
  POLL_INTERVAL_MS = "30000",
  MIN_TOKEN_AGE_SECONDS = "60",
  MAX_TOKEN_AGE_SECONDS = "21600",
  MIN_SCORE_TO_ALERT = "55",
} = process.env;

const REQUIRED_VARS = ["DISCORD_TOKEN", "CHANNEL_ID"];
for (const key of REQUIRED_VARS) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}
if (!BIRDEYE_API_KEY && !HELIUS_API_KEY) {
  console.warn(
    "[startup] No BIRDEYE_API_KEY or HELIUS_API_KEY set — running on DexScreener data only. " +
      "Some fields (holders, MC cross-check) will show as missing."
  );
}

// ---- Discord client ------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const radarCommand = new SlashCommandBuilder()
  .setName("radar")
  .setDescription("Run an on-demand radar check on a token contract address")
  .addStringOption((opt) =>
    opt.setName("address").setDescription("Token mint / contract address").setRequired(true)
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), {
      body: [radarCommand.toJSON()],
    });
    console.log("[startup] Slash command /radar registered.");
  } catch (err) {
    console.error("[startup] Failed to register slash commands:", err);
  }
}

let watchlist;

async function postAlert(snapshot, result) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch((err) => {
    console.error("[postAlert] Failed to fetch channel:", err.message);
    return null;
  });
  if (!channel) return;

  const embed = buildRadarEmbed(snapshot, result);
  const content =
    result.score >= 70 && PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : undefined;

  await channel.send({ content, embeds: [embed] }).catch((err) => {
    console.error("[postAlert] Failed to send message:", err.message);
  });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[startup] Logged in as ${c.user.tag}`);
  await registerCommands();

  watchlist = new Watchlist({
    minAgeSeconds: Number(MIN_TOKEN_AGE_SECONDS),
    maxAgeSeconds: Number(MAX_TOKEN_AGE_SECONDS),
    minScore: Number(MIN_SCORE_TO_ALERT),
    birdeyeApiKey: BIRDEYE_API_KEY,
    heliusApiKey: HELIUS_API_KEY,
    onAlert: postAlert,
    onError: (err, ctx) => console.error(`[watchlist:${ctx}]`, err.message),
  });

  const stopPolling = watchlist.start(Number(POLL_INTERVAL_MS));
  console.log(`[startup] Polling every ${POLL_INTERVAL_MS}ms.`);

  process.on("SIGINT", () => {
    console.log("\n[shutdown] Stopping poll loop and logging out...");
    stopPolling();
    client.destroy();
    process.exit(0);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "radar") return;

  const address = interaction.options.getString("address", true).trim();
  await interaction.deferReply();

  const evaluation = watchlist
    ? await watchlist.evaluateOne(address)
    : null;

  if (!evaluation) {
    await interaction.editReply(
      "Couldn't build a snapshot for that address — check it's a valid mint and try again."
    );
    return;
  }

  const embed = buildRadarEmbed(evaluation.snapshot, evaluation.result);
  await interaction.editReply({ embeds: [embed] });
});

// ---- Resilience: don't let one bad promise take the whole bot down -------
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

client.on(Events.Error, (err) => {
  console.error("[discord.js client error]", err);
});
client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`[shard ${id}] Disconnected:`, event?.reason || event?.code);
});
client.on(Events.ShardReconnecting, (id) => {
  console.log(`[shard ${id}] Reconnecting...`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[startup] Failed to log in — check DISCORD_TOKEN:", err.message);
  process.exit(1);
});
