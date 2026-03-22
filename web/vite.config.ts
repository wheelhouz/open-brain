import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8420",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8420",
        changeOrigin: true,
      },
      "/mcp": {
        target: "http://localhost:8420",
        changeOrigin: true,
      },
    },
  },
});
