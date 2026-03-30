import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { requireInteractive } from "../output.ts";
import { ask, confirm, print, success } from "../prompt.ts";

export async function setupAgent(): Promise<void> {
  requireInteractive("denoclaw setup agent");
  const config = await getConfigOrDefault();

  print("\n=== Agent Configuration ===");

  const model = await ask("LLM model", config.agents.defaults.model);
  config.agents.defaults.model = model;

  const temp = parseFloat(
    await ask("Temperature", String(config.agents.defaults.temperature)),
  );
  if (!isNaN(temp)) config.agents.defaults.temperature = temp;

  const tokens = parseInt(
    await ask("Max tokens", String(config.agents.defaults.maxTokens)),
  );
  if (!isNaN(tokens)) config.agents.defaults.maxTokens = tokens;

  const customPrompt = await ask("Custom system prompt (empty = default)");
  if (customPrompt) config.agents.defaults.systemPrompt = customPrompt;

  if (await confirm("Restrict shell commands to the workspace?", false)) {
    config.tools.restrictToWorkspace = true;
  }

  await saveConfig(config);
  success("Agent configured.");
  print("  denoclaw agent       — interactive chat");
  print("  denoclaw agent -m .. — one-off message");
}
