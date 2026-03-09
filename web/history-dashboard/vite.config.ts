import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/history-static/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/history-dashboard.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || "asset";
          if (name.endsWith(".css")) {
            return "assets/history-dashboard.css";
          }
          return "assets/[name][extname]";
        }
      }
    }
  }
});
