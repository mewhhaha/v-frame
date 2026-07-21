import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

function frontendProxy(prefix: string, port: number): ProxyOptions {
  return {
    target: `http://localhost:${port}`,
    changeOrigin: true,
    rewrite: (path) => path.slice(prefix.length) || "/",
  };
}

const proxy = {
  "/frontends/angular": frontendProxy("/frontends/angular", 43171),
  "/frontends/solid": frontendProxy("/frontends/solid", 43172),
  "/frontends/qwik": frontendProxy("/frontends/qwik", 43173),
  "/frontends/react": frontendProxy("/frontends/react", 43174),
};

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
    proxy,
  },
  preview: {
    port: 43170,
    proxy,
  },
});
