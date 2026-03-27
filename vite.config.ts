import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  publicDir: "./web/static",
  server: {
    port: 3001,
    strictPort: true,
  },
  plugins: [
    fresh({
      serverEntry: "./web/main.ts",
      clientEntry: "./web/client.ts",
      islandsDir: "./web/islands",
      routeDir: "./web/routes",
    }),
    tailwindcss(),
  ],
});
