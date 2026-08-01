import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

function frontendProxy(prefix: string, port: number): ProxyOptions {
  return {
    target: `http://localhost:${port}`,
    changeOrigin: true,
    rewrite: (path) => path.slice(prefix.length) || "/",
  };
}

const proxy = {
  "/frontends/solid": frontendProxy("/frontends/solid", 43172),
};

export default defineConfig({
  plugins: [react()],
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
