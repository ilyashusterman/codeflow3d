import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const API = `http://127.0.0.1:${process.env.API_PORT ?? 5189}`;

export default defineConfig(({ command }) => ({
  root,
  plugins: [react()],
  // Dev talks to the API port directly; the production build is same-origin.
  define: { __API_BASE__: JSON.stringify(command === "serve" ? API : "") },
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../shared", import.meta.url)) },
  },
  server: {
    port: 5188,
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/exports": { target: API, changeOrigin: true },
      "/ws": { target: API.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "esnext" },
}));
