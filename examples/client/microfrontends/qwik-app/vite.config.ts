import { defineConfig } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";

export default defineConfig({
  plugins: [qwikVite({ csr: true, entryStrategy: { type: "inline" } })],
  build: {
    outDir: "dist",
  },
});
