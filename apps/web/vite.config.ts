import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@horizonquant/agent": path.resolve(__dirname, "../../packages/agent/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
