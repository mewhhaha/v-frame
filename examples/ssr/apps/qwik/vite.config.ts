import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { defineConfig } from "vite";

const manifestPath = fileURLToPath(
  new URL("src/manifest.generated.js", import.meta.url),
);
const workerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        chunkFileNames: "build/[name].js",
        entryFileNames: "build/[name].js",
      },
    },
  },
  publicDir: false,
  root: workerRoot,
  plugins: [
    qwikVite({
      client: {
        input: "src/widget.tsx",
        manifestOutput: (manifest) => writeFile(
          manifestPath,
          `export const manifest = ${JSON.stringify(manifest)};\n`,
        ),
        outDir: "dist/client",
      },
      ssr: {
        input: "src/index.tsx",
        outDir: "dist/server",
      },
    }),
  ],
});
