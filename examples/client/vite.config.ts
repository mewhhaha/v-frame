import {
  defineConfig,
  type Connect,
  type Plugin,
  type ProxyOptions,
} from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import {
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "../../src/gateway-contract";

const frontendPrefix = "/frontends/";

function gatewayMarker(): Plugin {
  const install = (middlewares: Connect.Server): void => {
    middlewares.use((request, response, next) => {
      if (
        !request.url?.startsWith(frontendPrefix) ||
        request.headers["sec-fetch-dest"] !== "iframe"
      ) {
        next();
        return;
      }

      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Vary", "Sec-Fetch-Dest");
      response.setHeader(V_FRAME_GATEWAY_HEADER, V_FRAME_GATEWAY_VERSION);
      response.end(
        `<!doctype html><meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
      );
    });
  };

  return {
    name: "v-frame-gateway-marker",
    configureServer: (server) => install(server.middlewares),
    configurePreviewServer: (server) => install(server.middlewares),
  };
}

function frontendProxy(prefix: string, port: number): ProxyOptions {
  return {
    target: `http://localhost:${port}`,
    changeOrigin: true,
    rewrite: (path) => path.slice(prefix.length) || "/",
    configure(proxy) {
      proxy.on("proxyRes", (response) => {
        const currentVary = response.headers.vary;
        const vary = Array.isArray(currentVary)
          ? currentVary.join(", ")
          : currentVary;
        response.headers.vary = vary
          ? `${vary}, Sec-Fetch-Dest`
          : "Sec-Fetch-Dest";
        response.headers[V_FRAME_GATEWAY_HEADER.toLowerCase()] = V_FRAME_GATEWAY_VERSION;
      });
    },
  };
}

const proxy = {
  "/frontends/angular": frontendProxy("/frontends/angular", 43171),
  "/frontends/solid": frontendProxy("/frontends/solid", 43172),
  "/frontends/qwik": frontendProxy("/frontends/qwik", 43173),
  "/frontends/react": frontendProxy("/frontends/react", 43174),
};

export default defineConfig({
  plugins: [gatewayMarker(), react()],
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
