import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";

// The budget exists so payload regressions surface in CI rather than in a
// consumer's network tab. Ratchet it down whenever the bundle genuinely shrinks.
// The headroom over what this script reports is deliberate, so one small
// addition can land and be judged on its merits instead of failing CI on the
// first byte. The measured size deliberately lives in this script's output and
// nowhere else: the copies that used to sit in this comment and in the
// CHANGELOG were wrong three revisions running.
const budgetBytes = 72_000;

async function measureGzippedBundle() {
  // Building in memory keeps the budget runnable without a prior `pnpm build`,
  // and drops the sourcemap and legal comments that dist/index.js carries but
  // no consumer downloads on the critical path.
  const bundle = await rolldown({
    input: "src/index.ts",
    platform: "browser",
    transform: { target: "es2022" },
  });
  try {
    const generated = await bundle.generate({
      format: "es",
      minify: true,
      comments: false,
    });
    const output = generated.output.find((entry) => entry.type === "chunk");
    if (output === undefined) {
      throw new Error("Rolldown produced no output for src/index.ts");
    }
    return gzipSync(output.code).byteLength;
  } finally {
    await bundle.close();
  }
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
