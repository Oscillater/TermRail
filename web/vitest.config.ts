import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    clearMocks: true,
    environment: "jsdom",
    restoreMocks: true,
  },
});
