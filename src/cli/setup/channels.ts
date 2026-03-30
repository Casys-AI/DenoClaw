import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { requireInteractive } from "../output.ts";
import { ask, choose, error, print, success } from "../prompt.ts";

export async function setupChannel(): Promise<void> {
  requireInteractive("denoclaw setup channel");
  const config = await getConfigOrDefault();

  const choice = await choose("Which channel should be configured?", [
    "telegram  — Bot Telegram",
    "webhook   — Generic HTTP webhook",
  ]);
  const channelName = choice.split("—")[0].trim().split(/\s+/)[0];

  switch (channelName) {
    case "telegram": {
      const token = await ask("Telegram bot token (from @BotFather)");
      if (!token) {
        error("Empty token, canceled.");
        return;
      }

      const allowFrom = await ask(
        "Allowed user IDs (comma-separated, empty = all)",
      );
      config.channels.telegram = {
        enabled: true,
        token,
        allowFrom: allowFrom
          ? allowFrom.split(",").map((value) => value.trim())
          : undefined,
      };

      success("Telegram configured. Start local dev mode:");
      print("  denoclaw dev");
      break;
    }

    case "webhook": {
      const port = parseInt(await ask("Port", "8787"));
      const secret = await ask(
        "Secret (Authorization header, empty = no secret)",
      );
      config.channels.webhook = {
        enabled: true,
        port: port || 8787,
        secret: secret || undefined,
      };

      success(`Webhook configured on port ${port || 8787}.`);
      print("  denoclaw dev");
      break;
    }
  }

  await saveConfig(config);
}
