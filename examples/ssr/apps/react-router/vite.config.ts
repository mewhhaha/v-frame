import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/widgets/react-router/",
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
});
