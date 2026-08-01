import { build } from "esbuild";
import { gzipSync } from "node:zlib";

// The budget exists so payload regressions surface in CI rather than in a
// consumer's network tab. Ratchet it down whenever the bundle genuinely shrinks.
const budgetBytes = 100_000;

async function measureGzippedBundle() {
  // The shipped build is unminified, so measuring it would report the size a
  // consumer's bundler never serves. Minify in memory instead of touching dist.
  const result = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    write: false,
  });
  const [output] = result.outputFiles;
  if (output === undefined) {
    throw new Error("esbuild produced no output for src/index.ts");
  }
  return gzipSync(output.contents).byteLength;
}

const gzippedBytes = await measureGzippedBundle();
const percentage = Math.round((gzippedBytes / budgetBytes) * 100);
console.log(
  `v-frame gzip ${gzippedBytes} bytes / ${budgetBytes} budget (${percentage}%)`,
);
if (gzippedBytes > budgetBytes) {
  console.error(`The bundle exceeds its budget by ${gzippedBytes - budgetBytes} bytes.`);
  process.exit(1);
}
