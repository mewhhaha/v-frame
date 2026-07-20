import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlays: resolve(__dirname, "overlay-lab.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43170,
    strictPort: true,
  },
  preview: {
    port: 43170,
  },
});
