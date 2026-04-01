import { setupAgentDefaults } from "./setup/agent_defaults.ts";
import { setupChannel } from "./setup/channels.ts";
import { setupProvider } from "./setup/providers.ts";
import { requireInteractive } from "./output.ts";
import { confirm } from "./prompt.ts";

export async function runInitWizard(): Promise<void> {
  requireInteractive("denoclaw init");

  console.log(`
╔═══════════════════════════════════╗
║        DenoClaw — Setup           ║
╚═══════════════════════════════════╝
`);

  console.log("Step 1/3 — LLM provider\n");
  await setupProvider();

  const wantChannel = await confirm(
    "Step 2/3 — Configure a channel (Telegram, Discord, webhook)?",
    false,
  );
  if (wantChannel) {
    await setupChannel();
  }

  const wantCustom = await confirm(
    "Step 3/3 — Customize default agent settings (model, temperature)?",
    false,
  );
  if (wantCustom) {
    await setupAgentDefaults();
  }

  console.log(`
✓ Setup complete!

Next steps:
  denoclaw dev                  Work locally (gateway + agents + dashboard)
  denoclaw channel route        Add room/thread-specific ingress routing scopes
  denoclaw dev --agent <name>   Interactive chat with an agent
  denoclaw deploy               Deploy the broker to Deno Deploy
  denoclaw status               Show system status
`);
}
