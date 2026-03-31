export function printHelp(): void {
  console.log(`
DenoClaw — Agent IA Deno-natif

Workflow:
  denoclaw init                 Guided setup (provider + channel + agent)
  denoclaw dev                  Work locally (gateway + agents + dashboard)
  denoclaw deploy               Deploy/update the broker on Deno Deploy
  denoclaw publish [agent]      Push agent(s) to the remote broker
  denoclaw status               Show local + remote status
  denoclaw logs                 Stream broker logs

Agents:
  denoclaw agent list           List all agents
  denoclaw agent create <name>  Create an agent
  denoclaw agent delete <name>  Delete an agent

Channels:
  denoclaw setup channel        Configure Telegram / Discord / webhook transport
  denoclaw channel route        Create or edit an ingress routing scope
  denoclaw channel route list   List configured ingress routing scopes
  denoclaw channel route discover  List observed Telegram/Discord scopes from sessions
  denoclaw channel route delete Remove a configured ingress routing scope

Advanced:
  denoclaw tunnel [url]         Connect a local tunnel to the broker

Options:
  -m, --message    Send a one-off message (with dev --agent)
  -s, --session    Session ID (default: "default")
  -a, --agent      Target agent
  --model          Override the LLM model
  --org            Deno Deploy organization
  --app            Deno Deploy app name
  --json           Structured JSON output (AX mode)
  --yes, -y        Skip all confirmations
`);
}
