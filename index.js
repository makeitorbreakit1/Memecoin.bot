console.log("🚀 SOLANA MEMECOIN RADAR V6.2 - HELIUS RPC RATE-LIMIT FIX");
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
  HELIUS_API_KEY,
  RPC_URL,
  RUGCHECK_API_KEY,
  PING_ROLE_ID,
  POLL_INTERVAL_MS = "30000",
  MIN_TOKEN_AGE_SECONDS = "60",
  MAX_TOKEN_AGE_SECONDS = "21600",
  MIN_SCORE_TO_ALERT = "70",
  MIN_VERIFICATION_CONFIDENCE_PCT = "80",
  MAX_RUG_PROBABILITY_PCT = "35",
  MIN_LIQUIDITY_USD = "10000",
  REQUIRE_RUGCHECK = "true",
  REQUIRE_AUTHORITY_DATA = "true",
} = process.env;

for (const key of [
  "DISCORD_TOKEN",
  "CHANNEL_ID",
  "HELIUS_API_KEY",
]) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const radarCommand = new SlashCommandBuilder()
  .setName("radar")
  .setDescription("Run a Solana memecoin radar check")
  .addStringOption((opt) =>
    opt
      .setName("address")
      .setDescription("Solana token mint address")
      .setRequired(true)
  );

async function registerCommands() {
  if (!client.application?.id) return;

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.application.id),
      {
        body: [radarCommand.toJSON()],
      }
    );

    console.log(
      "[startup] Slash command /radar registered for Solana."
    );
  } catch (err) {
    console.error(
      "[startup] Slash command registration failed:",
      err.message
    );
  }
}

let watchlist;

async function runRadar(address, reply) {
  if (!watchlist) {
    return reply(
      "Radar is still starting up. Try again in a few seconds."
    );
  }

  const evaluation = await watchlist.evaluateOne(address);

  if (!evaluation) {
    return reply(
      "Couldn't find a usable Solana DEX pair for that mint address."
    );
  }

  const embed = buildRadarEmbed(
    evaluation.snapshot,
    evaluation.result,
    evaluation.rugAssessment,
    null,
    evaluation
  );

  return reply({
    embeds: [embed],
  });
}

async function postAlert(
  snapshot,
  result,
  rugAssessment,
  earlySignal = null,
  behavior = null
) {
  const channel = await client.channels
    .fetch(CHANNEL_ID)
    .catch((err) => {
      console.error(
        "[postAlert] Channel fetch failed:",
        err.message
      );
      return null;
    });

  if (!channel?.send) {
    console.error(
      "[postAlert] CHANNEL_ID does not point to a sendable channel."
    );
    return;
  }

  const embed = buildRadarEmbed(
    snapshot,
    result,
    rugAssessment,
    earlySignal,
    behavior
  );

  const content =
    result.score >= 70 && PING_ROLE_ID
      ? `<@&${PING_ROLE_ID}>`
      : undefined;

  await channel
    .send({
      content,
      embeds: [embed],
    })
    .then(() => {
      console.log(
        "[postAlert] Discord alert sent successfully."
      );
    })
    .catch((err) => {
      console.error(
        "[postAlert] Send failed:",
        err.message
      );
    });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[startup] Logged in as ${c.user.tag}`);

  await registerCommands();

  // ============================================================
  // TEMPORARY DISCORD TEST
  // ============================================================
  // This confirms:
  // 1. Discord login works
  // 2. CHANNEL_ID is correct
  // 3. The bot can access the channel
  // 4. The bot has permission to send messages
  //
  // REMOVE THIS BLOCK AFTER YOU CONFIRM THE TEST MESSAGE.
  // ============================================================

  const testChannel = await client.channels
    .fetch(CHANNEL_ID)
    .catch((err) => {
      console.error(
        "[TEST] Channel fetch failed:",
        err.message
      );
      return null;
    });

  if (testChannel?.send) {
    await testChannel
      .send(
        "🟢 **SOLANA RADAR TEST — Discord alerts are working!**"
      )
      .then(() => {
        console.log(
          "[TEST] Discord test message sent successfully."
        );
      })
      .catch((err) => {
        console.error(
          "[TEST] Discord test message failed:",
          err.message
        );
      });
  } else {
    console.error(
      "[TEST] CHANNEL_ID does not point to a sendable channel."
    );
  }

  // ============================================================
  // END TEMPORARY DISCORD TEST
  // ============================================================

  watchlist = new Watchlist({
    minAgeSeconds: Number(MIN_TOKEN_AGE_SECONDS),
    maxAgeSeconds: Number(MAX_TOKEN_AGE_SECONDS),
    minScore: Number(MIN_SCORE_TO_ALERT),

    minVerificationConfidencePct:
      Number(MIN_VERIFICATION_CONFIDENCE_PCT),

    maxRugProbabilityPct:
      Number(MAX_RUG_PROBABILITY_PCT),

    minLiquidityUsd:
      Number(MIN_LIQUIDITY_USD),

    requireRugCheck:
      REQUIRE_RUGCHECK.toLowerCase() === "true",

    requireAuthorityData:
      REQUIRE_AUTHORITY_DATA.toLowerCase() === "true",

    heliusApiKey: HELIUS_API_KEY,

    rpcUrl:
      RPC_URL ||
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,

    rugcheckApiKey: RUGCHECK_API_KEY,

    onAlert: postAlert,

    onError: (err, ctx) =>
      console.error(
        `[watchlist:${ctx}]`,
        err.message
      ),
  });

  const stopPolling =
    watchlist.start(Number(POLL_INTERVAL_MS));

  console.log(
    `[startup] Solana polling every ${POLL_INTERVAL_MS}ms.`
  );

  const shutdown = () => {
    stopPolling();
    client.destroy();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "radar"
  ) {
    return;
  }

  const address = interaction.options
    .getString("address", true)
    .trim();

  await interaction.deferReply();

  await runRadar(address, (payload) =>
    interaction.editReply(payload)
  );
});

// Prefix version: .radar MINT_ADDRESS
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = String(message.content || "").trim();

  const match = content.match(
    /^\.radar(?:\s+)(\S+)$/i
  );

  if (!match) return;

  await runRadar(match[1], (payload) =>
    message.reply(payload)
  );
});

process.on("unhandledRejection", (reason) =>
  console.error(
    "[unhandledRejection]",
    reason
  )
);

process.on("uncaughtException", (err) =>
  console.error(
    "[uncaughtException]",
    err
  )
);

client.on(Events.Error, (err) =>
  console.error(
    "[discord.js client error]",
    err
  )
);

client
  .login(DISCORD_TOKEN)
  .catch((err) => {
    console.error(
      "[startup] Failed to log in:",
      err.message
    );
    process.exit(1);
  });
