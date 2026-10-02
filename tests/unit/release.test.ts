import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRelease } from "../../scripts/release-check.js";

const commit = "a".repeat(40);
const notes = `Manual verification commit: ${commit}\n- [x] macOS Safari + VoiceOver\n- [x] iOS Safari + VoiceOver\n- [x] Windows Firefox + NVDA`;
const candidate = {
  npmVersion: "0.1.1",
  jsrVersion: "0.1.1",
  tag: "v0.1.1",
  commit,
  expectedCommit: commit,
  notes,
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
