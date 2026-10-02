import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const manualChecks = [
  "macOS Safari + VoiceOver",
  "iOS Safari + VoiceOver",
  "Windows Firefox + NVDA",
];

export interface ReleaseCandidate {
  npmVersion: string;
  jsrVersion: string;
  tag?: string;
  commit?: string;
  expectedCommit?: string;
  notes?: string;
}

export function validateRelease(candidate: ReleaseCandidate): void {
  const { npmVersion, jsrVersion, tag, commit, expectedCommit, notes } = candidate;
  if (npmVersion !== jsrVersion)
    throw new Error("package.json and jsr.json versions differ");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion))
    throw new Error("Invalid release version");
  if (tag !== undefined && tag !== `v${npmVersion}`)
    throw new Error(`Release tag must be v${npmVersion}`);
  if (expectedCommit !== undefined && commit !== expectedCommit)
    throw new Error("Checked-out commit differs from the release event commit");
  if (notes !== undefined) {
    if (!commit || !/^[0-9a-f]{40}$/.test(commit))
      throw new Error("Manual verification requires a full commit SHA");
    const lines = notes.split(/\r?\n/).map((line) => line.trim());
    if (!lines.includes(`Manual verification commit: ${commit}`))
      throw new Error("Manual verification is missing or belongs to a different commit");
    for (const check of manualChecks) {
      if (!lines.includes(`- [x] ${check}`))
        throw new Error(`Missing manual verification: ${check}`);
    }
  }
}

if (import.meta.main) {
  try {
    const npm = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const jsr = JSON.parse(readFileSync("jsr.json", "utf8")) as { version: string };
    const release = process.argv.includes("--release");
    const tag = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    validateRelease({
      npmVersion: npm.version,
      jsrVersion: jsr.version,
      ...(tag ? { tag } : {}),
      ...(release
        ? {
            commit: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            expectedCommit: process.env.GITHUB_SHA ?? "",
            notes: process.env.RELEASE_NOTES ?? "",
          }
        : {}),
    });
    console.log(`Release metadata valid for ${tag ?? npm.version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
