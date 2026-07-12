import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API + SPA share an origin in production. In dev, forward the API and
// health endpoints to the local Fastify server so relative `/api/...` calls and
// the SSE stream work unchanged.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4173",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:4173",
        changeOrigin: true,
      },
    },
  },
});
