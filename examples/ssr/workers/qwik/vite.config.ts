import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { qwikVite } from "@builder.io/qwik/optimizer";

const manifestPath = fileURLToPath(
  new URL("../../qwik-client-manifest/index.js", import.meta.url),
);
const workerRoot = fileURLToPath(new URL(".", import.meta.url));

export default {
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
        outDir: "public",
      },
    }),
  ],
};
