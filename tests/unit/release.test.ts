import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRelease } from "../../scripts/release-check.js";

const commit = "a".repeat(40);
const notes = `Manual verification commit: ${commit}\n- [x] macOS Safari + VoiceOver\n- [x] iOS Safari + VoiceOver\n- [x] Windows Firefox + NVDA`;
const changelog = `# Changelog\n\n## 0.1.1 - 2026-10-02\n\n### Fixed\n\n- Something.\n\n## 0.1.0\n\n- First release.\n`;
const candidate = {
  npmVersion: "0.1.1",
  jsrVersion: "0.1.1",
  tag: "v0.1.1",
  commit,
  expectedCommit: commit,
  notes,
  changelog,
  release: true,
};
test("accepts matching manifests, tag, immutable commit and manual attestation", () =>
  assert.doesNotThrow(() => validateRelease(candidate)));
for (const [name, change, error] of [
  ["version drift", { jsrVersion: "0.1.2" }, /versions differ/],
  ["wrong tag", { tag: "v0.1.0" }, /Release tag/],
  ["wrong commit", { expectedCommit: "b".repeat(40) }, /release event commit/],
  ["missing attestation", { notes: "" }, /Manual verification/],
  [
    "another commit's attestation",
    { notes: notes.replace(commit, "b".repeat(40)) },
    /different commit/,
  ],
  [
    "unchecked screen-reader check",
    { notes: notes.replace("[x] iOS", "[ ] iOS") },
    /iOS Safari/,
  ],
] as const) {
  test(`blocks publication with ${name}`, () =>
    assert.throws(() => validateRelease({ ...candidate, ...change }), error));
}

// A routine check has no commit, tag or notes to verify; only the changelog.
const routine = { npmVersion: "0.1.2", jsrVersion: "0.1.2", release: false };

test("a release requires a changelog section for the manifest version", () => {
  for (const version of ["0.1.2", "0.1.10", "0.1"]) {
    assert.throws(
      () =>
        validateRelease({ ...candidate, changelog: changelog.replace("0.1.1", version) }),
      /no "## 0\.1\.1" section/,
      version,
    );
  }
  assert.throws(
    () =>
      validateRelease({
        ...candidate,
        changelog: "# Changelog\n\n## Unreleased\n\n- New.\n",
      }),
    /no "## 0\.1\.1" section/,
  );
  assert.throws(
    () =>
      validateRelease({
        ...candidate,
        changelog: "# Changelog\n\n### 0.1.1\n\n- New.\n",
      }),
    /no "## 0\.1\.1" section/,
  );
});

test("a release accepts the version heading with or without a date or brackets", () => {
  for (const heading of [
    "## 0.1.1",
    "## 0.1.1 - 2026-10-02",
    "## [0.1.1] - 2026-10-02",
  ]) {
    assert.doesNotThrow(() =>
      validateRelease({
        ...candidate,
        changelog: `# Changelog\n\n${heading}\n\n- Note.\n`,
      }),
    );
  }
});

test("a release matches a pre-release version literally", () => {
  const prerelease = {
    ...candidate,
    npmVersion: "0.2.0-rc.1",
    jsrVersion: "0.2.0-rc.1",
    tag: "v0.2.0-rc.1",
  };
  assert.doesNotThrow(() =>
    validateRelease({
      ...prerelease,
      changelog: "## 0.2.0-rc.1 - 2026-10-09\n\n- Note.\n",
    }),
  );
  assert.throws(
    () => validateRelease({ ...prerelease, changelog: "## 0.2.0\n\n- Note.\n" }),
    /no "## 0\.2\.0-rc\.1" section/,
  );
});

test("a release rejects an empty changelog section", () => {
  assert.throws(
    () =>
      validateRelease({
        ...candidate,
        changelog:
          "# Changelog\n\n## 0.1.1 - 2026-10-02\n\n## 0.1.0\n\n- First release.\n",
      }),
    /"## 0\.1\.1" is empty/,
  );
});

test("a routine check allows notes pending under Unreleased", () => {
  assert.doesNotThrow(() =>
    validateRelease({ ...routine, changelog: `## Unreleased\n\n- New.\n\n${changelog}` }),
  );
  assert.doesNotThrow(() =>
    validateRelease({ ...routine, changelog: `## [Unreleased]\n\n${changelog}` }),
  );
});

test("a routine check allows a version that is already recorded", () => {
  assert.doesNotThrow(() =>
    validateRelease({
      ...routine,
      npmVersion: "0.1.1",
      jsrVersion: "0.1.1",
      changelog,
    }),
  );
});

test("a routine check rejects a version bump that skipped the changelog", () => {
  assert.throws(
    () => validateRelease({ ...routine, changelog }),
    /needs a "## 0\.1\.2" or "## Unreleased" section/,
  );
});
