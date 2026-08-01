import { build } from "esbuild";
import { gzipSync } from "node:zlib";

// The budget exists so payload regressions surface in CI rather than in a
// consumer's network tab. Ratchet it down whenever the bundle genuinely shrinks.
// Set at 68,000 against a measured 65,183 bytes, so one small addition can land
// and be judged on its merits instead of failing CI on the first byte.
const budgetBytes = 68_000;

async function measureGzippedBundle() {
  // Building in memory keeps the budget runnable without a prior `pnpm build`,
  // and drops the sourcemap and legal comments that dist/index.js carries but
  // no consumer downloads on the critical path.
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
