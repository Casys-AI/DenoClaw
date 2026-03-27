import type { PageProps } from "@fresh/core";
import {
  getDashboardBasePath,
  stripDashboardBasePath,
} from "../lib/base-path.ts";
import { NavBar } from "../components/NavBar.tsx";

export default function App({ Component, url }: PageProps) {
  const currentPath = stripDashboardBasePath(url.pathname);
  const basePath = getDashboardBasePath(url.pathname);
  const baseHref = basePath ? `${basePath}/` : "/";
  const isLogin = currentPath === "/login";
  const pageTitle = currentPath === "/" || currentPath === "/overview"
    ? "Overview"
    : currentPath.split("/").filter(Boolean).map((s) =>
      s.charAt(0).toUpperCase() + s.slice(1)
    ).join(" / ");

  return (
    <html lang="fr" data-theme="denoclaw">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <base href={baseHref} />
        <title>{`DenoClaw — ${pageTitle}`}</title>
      </head>
      <body class="min-h-screen bg-base-300">
        {!isLogin && <NavBar currentPath={currentPath} />}
        <main class={isLogin ? "" : "container mx-auto px-4 py-4"}>
          <Component />
        </main>
      </body>
    </html>
  );
}
