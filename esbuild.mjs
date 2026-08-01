import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "external",
});

await build({
  entryPoints: ["src/register.ts"],
  outfile: "dist/register.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "external",
  external: ["./index.js"],
});

// The server entry runs on whatever runtime a host uses, so it is built without
// a platform and must stay free of every DOM-dependent module in src/.
await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "external",
});
