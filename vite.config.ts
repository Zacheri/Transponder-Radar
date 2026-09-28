import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/health": { target: "http://127.0.0.1:8787" },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
