import type { PageProps } from "@fresh/core";
import { NavBar } from "../components/NavBar.tsx";

export default function App({ Component, url }: PageProps) {
  const isLogin = url.pathname === "/login";
  const pageTitle = url.pathname === "/" || url.pathname === "/overview"
    ? "Overview"
    : url.pathname.split("/").filter(Boolean).map((s) =>
      s.charAt(0).toUpperCase() + s.slice(1)
    ).join(" / ");

  return (
    <html lang="fr" data-theme="black">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{`DenoClaw — ${pageTitle}`}</title>
        {/* DaisyUI 5 + Tailwind CSS v4 — CDN */}
        <link
          href="https://cdn.jsdelivr.net/npm/daisyui@5"
          rel="stylesheet"
          type="text/css"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/daisyui@5/themes.css"
          rel="stylesheet"
          type="text/css"
        />
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
        {/* Custom overrides */}
        <link rel="stylesheet" href="/custom.css" />
      </head>
      <body class="min-h-screen bg-base-300">
        {!isLogin && <NavBar currentPath={url.pathname} />}
        <main class={isLogin ? "" : "container mx-auto px-4 py-4"}>
          <Component />
        </main>
      </body>
    </html>
  );
}
