import { solidStart } from "@solidjs/start/config";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/widgets/solid/",
  plugins: [solidStart(), nitro()],
  nitro: {
    baseURL: "/widgets/solid",
    preset: "cloudflare_module",
    compatibilityDate: "2026-07-21",
  },
});
