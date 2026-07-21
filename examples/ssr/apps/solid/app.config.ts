import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    baseURL: "/widgets/solid",
    preset: "cloudflare_module",
    rollupConfig: {
      external: ["__STATIC_CONTENT_MANIFEST", "node:async_hooks"],
    },
  },
});
