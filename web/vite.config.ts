import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // Vite keeps 5173 and moves to 5174, 5175, ... when another project owns it.
    // start.ps1 probes the range and opens whichever port actually serves TermRail.
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
