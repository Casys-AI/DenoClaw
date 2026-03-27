export default function Login() {
  return (
    <div class="min-h-screen bg-base-300 flex items-center justify-center">
      <div class="card bg-base-200 w-full max-w-sm">
        <div class="card-body items-center text-center">
          {/* Logo */}
          <img src="/logo.png" alt="DenoClaw" class="w-20 h-20 mb-2" />
          <h1 class="font-display text-2xl font-bold tracking-tight">DenoClaw</h1>
          <p class="text-sm text-neutral-content mb-4">Agent Orchestration Dashboard</p>

          {/* Login form */}
          <form class="w-full space-y-4" method="POST" action="/login">
            <div class="form-control w-full">
              <label class="label">
                <span class="label-text text-xs font-data uppercase tracking-wider">Instance URL</span>
              </label>
              <input
                type="url"
                name="brokerUrl"
                placeholder="https://broker.example.com"
                class="input input-bordered w-full font-data text-sm"
                value="http://localhost:3000"
              />
            </div>
            <div class="form-control w-full">
              <label class="label">
                <span class="label-text text-xs font-data uppercase tracking-wider">API Token</span>
              </label>
              <input
                type="password"
                name="token"
                placeholder="Enter your API token"
                class="input input-bordered w-full font-data text-sm"
              />
            </div>
            <button type="submit" class="btn w-full gradient-deno text-white border-none">
              Connect
            </button>
          </form>

          <div class="divider text-xs text-neutral-content">OR</div>

          {/* OAuth placeholder */}
          <button class="btn btn-outline btn-sm w-full gap-2" disabled>
            Sign in with Deno Deploy
            <span class="badge badge-xs badge-neutral">soon</span>
          </button>

          <p class="text-xs text-neutral-content mt-4">
            v0.1.0 — Powered by Deno
          </p>
        </div>
      </div>
    </div>
  );
}
