import { defineConfig } from "vite";

// In dev, /api (token exchange + WebSocket relay) is served by `wrangler dev` on :8787.
export default defineConfig({
  server: {
    host: true,
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
    },
  },
  build: {
    target: "es2022",
    // Rapier (physics, host only, loaded on demand) is ~4 MB.
    chunkSizeWarningLimit: 5000,
    // The machine, and the phone-only remote (PHONE-REMOTE.md) at /remote.
    rollupOptions: { input: { main: "index.html", remote: "remote.html" } },
  },
});
