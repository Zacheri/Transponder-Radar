import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
  },
  server: {
    port: 1738,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:2001", ws: true },
      "/health": { target: "http://127.0.0.1:2001" },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
