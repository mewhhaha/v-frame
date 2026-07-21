import { defineConfig } from "vite";

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    emptyOutDir: !isSsrBuild,
    outDir: isSsrBuild ? "dist/server" : "dist/client",
    target: "es2022",
    rollupOptions: isSsrBuild
      ? {
          output: { entryFileNames: "index.js" },
        }
      : {
          input: "src/client.ts",
          output: {
            chunkFileNames: "assets/[name]-[hash].js",
            entryFileNames: "assets/v-frame.js",
          },
        },
  },
  publicDir: false,
  ssr: { noExternal: true, target: "webworker" },
}));
