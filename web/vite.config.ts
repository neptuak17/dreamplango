import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // MapLibre's worker is bundled as an ES module worker (see src/maplibre-worker.ts).
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:8787" },
  },
});
