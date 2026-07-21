import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "/frontends/solid/",
  plugins: [solid()],
  build: {
    outDir: "dist",
  },
});
