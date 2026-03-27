import type { PageProps } from "@fresh/core";
import { NavBar } from "../components/NavBar.tsx";

export default function App({ Component, url }: PageProps) {
  // Login page — standalone layout (no navbar)
  if (url.pathname === "/login") {
    return (
      <html lang="fr" data-theme="black">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>DenoClaw — Login</title>
          <link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
          <link href="https://cdn.jsdelivr.net/npm/daisyui@5/themes.css" rel="stylesheet" type="text/css" />
          <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
          <link rel="stylesheet" href="/custom.css" />
        </head>
        <body>
          <Component />
        </body>
      </html>
    );
  }

  return (
    <html lang="fr" data-theme="black">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>DenoClaw Dashboard</title>
        {/* DaisyUI 5 + Tailwind CSS v4 — CDN */}
        <link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
        <link href="https://cdn.jsdelivr.net/npm/daisyui@5/themes.css" rel="stylesheet" type="text/css" />
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
        {/* Custom overrides */}
        <link rel="stylesheet" href="/custom.css" />
      </head>
      <body class="min-h-screen bg-base-300">
        <NavBar currentPath={url.pathname} />
        <main class="container mx-auto px-4 py-4">
          <Component />
        </main>
      </body>
    </html>
  );
}
