export function CreateAgentModal({ brokerUrl }: { brokerUrl: string }) {
  return (
    <>
      <dialog id="create-agent-modal" class="modal">
        <div class="modal-box">
          <h3 class="font-bold text-lg mb-4">Create Agent</h3>
          <form id="create-agent-form" class="space-y-3">
            <div class="form-control">
              <label class="label">
                <span class="label-text text-xs font-data uppercase">
                  Agent ID
                </span>
              </label>
              <input
                type="text"
                name="agentId"
                placeholder="e.g. researcher, coder, reviewer"
                class="input input-bordered input-sm w-full font-data"
                pattern="[a-zA-Z0-9._-]+"
                required
              />
            </div>
            <div class="form-control">
              <label class="label">
                <span class="label-text text-xs font-data uppercase">
                  Model
                </span>
              </label>
              <input
                type="text"
                name="model"
                value="ollama/nemotron"
                class="input input-bordered input-sm w-full font-data"
              />
            </div>
            <div class="form-control">
              <label class="label">
                <span class="label-text text-xs font-data uppercase">
                  Description
                </span>
              </label>
              <input
                type="text"
                name="description"
                placeholder="What does this agent do?"
                class="input input-bordered input-sm w-full font-data"
              />
            </div>
            <div class="form-control">
              <label class="label">
                <span class="label-text text-xs font-data uppercase">
                  System Prompt
                </span>
              </label>
              <textarea
                name="systemPrompt"
                rows={3}
                placeholder="Optional system prompt..."
                class="textarea textarea-bordered w-full font-data text-sm"
              />
            </div>
            <div class="form-control">
              <label class="label">
                <span class="label-text text-xs font-data uppercase">
                  Permissions
                </span>
              </label>
              <div class="flex flex-wrap gap-2">
                {["read", "write", "run", "net"].map((p) => (
                  <label class="label cursor-pointer gap-1" key={p}>
                    <input
                      type="checkbox"
                      name="permissions"
                      value={p}
                      class="checkbox checkbox-xs"
                      checked
                    />
                    <span class="label-text text-xs font-data">{p}</span>
                  </label>
                ))}
              </div>
            </div>
            <div class="modal-action">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick="document.getElementById('create-agent-modal').close()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-sm gradient-deno text-white border-none"
              >
                Create
              </button>
            </div>
          </form>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="submit">close</button>
        </form>
      </dialog>

      <script
        type="module"
        dangerouslySetInnerHTML={{
          __html: `
const BROKER = "${brokerUrl}";
const TOKEN = localStorage.getItem("denoclaw_token") || "";
const hdrs = TOKEN ? { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" } : { "Content-Type": "application/json" };

document.getElementById("create-agent-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    agentId: fd.get("agentId"),
    config: {
      model: fd.get("model") || undefined,
      description: fd.get("description") || undefined,
      systemPrompt: fd.get("systemPrompt") || undefined,
      sandbox: {
        backend: "local",
        allowedPermissions: fd.getAll("permissions"),
        execPolicy: { security: "allowlist", allowedCommands: ["git","deno","npm","ls","cat","grep","echo"], ask: "on-miss", askFallback: "deny" }
      }
    }
  };
  const res = await fetch(BROKER + "/api/agents", { method: "POST", headers: hdrs, body: JSON.stringify(body) });
  if (res.ok) {
    document.getElementById("create-agent-modal").close();
    location.reload();
  } else {
    alert("Failed: " + (await res.text()));
  }
});
          `,
        }}
      />
    </>
  );
}

export function CreateAgentButton() {
  return (
    <button
      type="button"
      class="btn btn-sm gradient-deno text-white border-none"
      onclick="document.getElementById('create-agent-modal').showModal()"
    >
      + New Agent
    </button>
  );
}
