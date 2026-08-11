import { rm } from "node:fs/promises";
import { rolldown } from "rolldown";

await rm("dist", { recursive: true, force: true });

async function buildEntry(input, file, platform, external = []) {
  const bundle = await rolldown({
    input,
    external,
    platform,
    transform: { target: "es2022" },
  });
  try {
    await bundle.write({
      file,
      format: "es",
      minify: true,
      sourcemap: true,
      comments: { legal: true, annotation: true, jsdoc: false },
    });
  } finally {
    await bundle.close();
  }
}

await buildEntry("src/index.ts", "dist/index.js", "browser");
await buildEntry("src/register.ts", "dist/register.js", "browser", ["./index.js"]);

// The server entry runs on whatever runtime a host uses, so it stays neutral and
// must remain free of every DOM-dependent module in src/.
await buildEntry("src/server/index.ts", "dist/server/index.js", "neutral");
