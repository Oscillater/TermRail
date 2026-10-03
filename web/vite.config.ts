import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = `http://127.0.0.1:${process.env.TERMRAIL_BACKEND_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // Vite keeps 5173 and moves to 5174, 5175, ... when another project owns it.
    // start.ps1 probes the range and opens whichever port actually serves TermRail.
    port: 5173,
    proxy: {
      "/api": backendTarget,
      "/ws": {
        target: backendTarget,
        ws: true,
      },
    },
  },
});
