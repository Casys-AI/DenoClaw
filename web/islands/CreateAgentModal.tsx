import { useRef, useState } from "preact/hooks";

const DEFAULT_MODEL = "ollama/nemotron";
const PERMISSIONS = ["read", "write", "run", "net"] as const;
const ALLOWED_COMMANDS = [
  "git",
  "deno",
  "npm",
  "ls",
  "cat",
  "grep",
  "echo",
];

export default function CreateAgentModal() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const openModal = () => {
    setError(null);
    dialogRef.current?.showModal();
  };

  const closeModal = () => {
    if (isSubmitting) return;
    setError(null);
    dialogRef.current?.close();
  };

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement | null;
    if (!form) return;

    setError(null);
    setIsSubmitting(true);

    const formData = new FormData(form);
    const headers: HeadersInit = { "Content-Type": "application/json" };

    const body = {
      agentId: formData.get("agentId"),
      config: {
        model: formData.get("model") || undefined,
        description: formData.get("description") || undefined,
        systemPrompt: formData.get("systemPrompt") || undefined,
        sandbox: {
          backend: "local",
          allowedPermissions: formData.getAll("permissions"),
          execPolicy: {
            security: "allowlist",
            allowedCommands: ALLOWED_COMMANDS,
            ask: "on-miss",
            askFallback: "deny",
          },
        },
      },
    };

    try {
      const response = await fetch("api/agents", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setError(await response.text());
        return;
      }

      form.reset();
      dialogRef.current?.close();
      globalThis.location.reload();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Failed to create agent",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        class="btn btn-sm gradient-deno text-white border-none"
        onClick={openModal}
      >
        + New Agent
      </button>

      <dialog ref={dialogRef} class="modal">
        <div class="modal-box">
          <h3 class="font-bold text-lg mb-4">Create Agent</h3>

          {error && (
            <div role="alert" class="alert alert-error mb-4 text-sm">
              <span>{error}</span>
            </div>
          )}

          <form class="space-y-3" onSubmit={handleSubmit}>
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
                defaultValue={DEFAULT_MODEL}
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
                {PERMISSIONS.map((permission) => (
                  <label class="label cursor-pointer gap-1" key={permission}>
                    <input
                      type="checkbox"
                      name="permissions"
                      value={permission}
                      class="checkbox checkbox-xs"
                      defaultChecked
                    />
                    <span class="label-text text-xs font-data">
                      {permission}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div class="modal-action">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onClick={closeModal}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-sm gradient-deno text-white border-none"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>

        <form method="dialog" class="modal-backdrop">
          <button type="submit" onClick={() => setError(null)}>close</button>
        </form>
      </dialog>
    </>
  );
}
