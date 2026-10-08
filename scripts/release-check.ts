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
  /** The text of CHANGELOG.md. */
  changelog?: string;
  /** Whether publication, rather than a routine push, depends on this check. */
  release?: boolean;
}

interface ChangelogSection {
  /** The first word of the `## ` heading, without Keep a Changelog's brackets. */
  name: string;
  body: string;
}

function changelogSections(changelog: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  for (const line of changelog.split(/\r?\n/)) {
    const name = /^## +\[?([^\s\]]+)/.exec(line)?.[1];
    if (name !== undefined) {
      current = { name, body: "" };
      sections.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return sections;
}

// A release must have its notes written. Between releases the notes may sit under
// "Unreleased", so a routine check only insists that the manifest version is either
// already recorded or pending there. That catches a version bump that skipped the
// changelog before it reaches a release.
function validateChangelog(changelog: string, version: string, release: boolean): void {
  const sections = changelogSections(changelog);
  const released = sections.find((section) => section.name === version);
  if (release) {
    if (!released) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
    if (released.body.trim() === "")
      throw new Error(`CHANGELOG.md section "## ${version}" is empty`);
  } else if (
    !released &&
    !sections.some((section) => /^unreleased$/i.test(section.name))
  ) {
    throw new Error(`CHANGELOG.md needs a "## ${version}" or "## Unreleased" section`);
  }
}

export function validateRelease(candidate: ReleaseCandidate): void {
  const {
    npmVersion,
    jsrVersion,
    tag,
    commit,
    expectedCommit,
    notes,
    changelog,
    release,
  } = candidate;
  if (npmVersion !== jsrVersion)
    throw new Error("package.json and jsr.json versions differ");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(npmVersion))
    throw new Error("Invalid release version");
  if (tag !== undefined && tag !== `v${npmVersion}`)
    throw new Error(`Release tag must be v${npmVersion}`);
  if (expectedCommit !== undefined && commit !== expectedCommit)
    throw new Error("Checked-out commit differs from the release event commit");
  if (changelog !== undefined) validateChangelog(changelog, npmVersion, release === true);
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
      changelog: readFileSync("CHANGELOG.md", "utf8"),
      release,
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
