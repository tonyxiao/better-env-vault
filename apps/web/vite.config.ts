import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(dirname(fileURLToPath(import.meta.url)), "src") },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
