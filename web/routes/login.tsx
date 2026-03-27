export default function Login() {
  return (
    <div class="min-h-screen bg-base-300 flex items-center justify-center">
      <div class="card bg-base-200 w-full max-w-sm">
        <div class="card-body items-center text-center">
          {/* Logo */}
          <img src="/logo.png" alt="DenoClaw" class="w-20 h-20 mb-2" />
          <h1 class="font-display text-2xl font-bold tracking-tight">
            DenoClaw
          </h1>
          <p class="text-sm text-neutral-content mb-4">
            Agent Orchestration Dashboard
          </p>

          {/* Login form */}
          <form class="w-full space-y-4" method="POST" action="/login">
            <div class="form-control w-full">
              <label class="label">
                <span class="label-text text-xs font-data uppercase tracking-wider">
                  Instance URL
                </span>
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
                <span class="label-text text-xs font-data uppercase tracking-wider">
                  API Token
                </span>
              </label>
              <input
                type="password"
                name="token"
                placeholder="Enter your API token"
                class="input input-bordered w-full font-data text-sm"
              />
            </div>
            <button
              type="submit"
              class="btn w-full gradient-deno text-white border-none"
            >
              Connect
            </button>
          </form>

          <div class="divider text-xs text-neutral-content">OR</div>

          {/* GitHub OAuth */}
          <a
            href="/auth/github"
            class="btn btn-outline btn-sm w-full gap-2"
          >
            <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Sign in with GitHub
          </a>

          <p class="text-xs text-neutral-content mt-4">
            v0.1.0 — Powered by Deno
          </p>
        </div>
      </div>
    </div>
  );
}
