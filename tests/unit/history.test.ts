import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualHistorySession } from "../../src/history.js";

const START = "https://host.test/app/";

function session(): VirtualHistorySession {
  return new VirtualHistorySession(START);
}

/** The whole entry list, which the class only exposes one index at a time. */
function urls(history: VirtualHistorySession): string[] {
  const collected: string[] = [];
  for (let index = 0; index < history.length; index += 1) {
    collected.push(history.entryAt(index)?.url ?? "<missing>");
  }
  return collected;
}

test("a fresh session holds one entry for the initial URL", () => {
  const history = session();
  assert.equal(history.length, 1);
  assert.equal(history.currentIndex, 0);
  assert.equal(history.currentURL, START);
  assert.equal(history.currentState, null);
  assert.equal(history.currentDocumentID, 0);
  assert.equal(history.scrollRestoration, "auto");
});

test("pushState appends an entry and keeps the document", () => {
  const history = session();
  history.pushState(`${START}one`, { step: 1 });
  assert.deepEqual(urls(history), [START, `${START}one`]);
  assert.equal(history.currentIndex, 1);
  assert.deepEqual(history.currentState, { step: 1 });
  assert.equal(history.currentDocumentID, 0);
});

test("pushState truncates the forward entries", () => {
  const history = session();
  history.pushState(`${START}one`, null);
  history.pushState(`${START}two`, null);
  history.traverse(0);
  history.pushState(`${START}three`, null);
  assert.deepEqual(urls(history), [START, `${START}three`]);
  assert.equal(history.currentIndex, 1);
});

test("replaceState overwrites the current entry in place", () => {
  const history = session();
  history.pushState(`${START}one`, { step: 1 });
  history.replaceState(`${START}two`, { step: 2 });
  assert.deepEqual(urls(history), [START, `${START}two`]);
  assert.equal(history.currentIndex, 1);
  assert.deepEqual(history.currentState, { step: 2 });
});

test("navigateFragment replaces when the URL is unchanged and pushes otherwise", () => {
  const history = session();
  history.navigateFragment(`${START}#one`, { step: 1 });
  assert.equal(history.length, 2);
  history.navigateFragment(`${START}#one`, { step: 2 });
  assert.equal(history.length, 2);
  assert.deepEqual(history.currentState, { step: 2 });
  history.navigateFragment(`${START}#two`, null);
  assert.equal(history.length, 3);
  assert.deepEqual(urls(history), [START, `${START}#one`, `${START}#two`]);
});

test("replaceCurrentURL keeps the state and the document", () => {
  const history = session();
  history.pushState(`${START}one`, { step: 1 });
  history.replaceCurrentURL(`${START}renamed`);
  assert.equal(history.currentURL, `${START}renamed`);
  assert.deepEqual(history.currentState, { step: 1 });
  assert.equal(history.currentDocumentID, 0);
  assert.equal(history.length, 2);
});

test("traverse moves the index without touching the entries", () => {
  const history = session();
  history.pushState(`${START}one`, null);
  history.pushState(`${START}two`, null);
  history.traverse(1);
  assert.equal(history.currentIndex, 1);
  assert.equal(history.currentURL, `${START}one`);
  assert.equal(history.length, 3);
});

test("entryAt returns undefined outside the entry list", () => {
  const history = session();
  assert.equal(history.entryAt(-1), undefined);
  assert.equal(history.entryAt(1), undefined);
});

test("currentEntry throws rather than reading past the entry list", () => {
  const history = session();
  history.traverse(4);
  assert.throws(() => history.currentURL, {
    message: "v-frame history has no entry at index 4",
  });
});

test("clone copies the entries so the original cannot be mutated through it", () => {
  const history = session();
  history.pushState(`${START}one`, { step: 1 });
  history.scrollRestoration = "manual";

  const copy = history.clone();
  assert.deepEqual(urls(copy), urls(history));
  assert.equal(copy.currentIndex, history.currentIndex);
  assert.equal(copy.scrollRestoration, "manual");

  copy.pushState(`${START}two`, null);
  copy.scrollRestoration = "auto";
  assert.deepEqual(urls(history), [START, `${START}one`]);
  assert.equal(history.currentIndex, 1);
  assert.equal(history.scrollRestoration, "manual");
});

test("forkDocumentNavigation pushes a new document without disturbing the source", () => {
  const history = session();
  const forked = history.forkDocumentNavigation(`${START}next`, "push");

  assert.deepEqual(urls(forked), [START, `${START}next`]);
  assert.equal(forked.currentIndex, 1);
  assert.equal(forked.currentDocumentID, 1);
  assert.equal(forked.currentState, null);
  assert.deepEqual(urls(history), [START]);
  assert.equal(history.currentDocumentID, 0);
});

test("forkDocumentNavigation in replace mode keeps the index and the length", () => {
  const history = session();
  history.pushState(`${START}one`, { step: 1 });
  const forked = history.forkDocumentNavigation(`${START}next`, "replace");

  assert.deepEqual(urls(forked), [START, `${START}next`]);
  assert.equal(forked.currentIndex, 1);
  assert.equal(forked.currentDocumentID, 1);
  // A document navigation starts a fresh document, so the pushed state is gone.
  assert.equal(forked.currentState, null);
});

test("forkDocumentNavigation truncates the forward entries", () => {
  const history = session();
  history.pushState(`${START}one`, null);
  history.pushState(`${START}two`, null);
  history.traverse(0);
  const forked = history.forkDocumentNavigation(`${START}next`, "push");
  assert.deepEqual(urls(forked), [START, `${START}next`]);
});

test("two forks of the same session reuse the same document id", () => {
  // The counter lives on the session being cloned, so a session that is forked
  // twice — a navigation that starts and is then replaced — numbers both the
  // same. Document ids are only unique along a single chain of forks.
  const history = session();
  const first = history.forkDocumentNavigation(`${START}a`, "push");
  const second = history.forkDocumentNavigation(`${START}b`, "push");
  assert.equal(first.currentDocumentID, 1);
  assert.equal(second.currentDocumentID, 1);

  const third = first.forkDocumentNavigation(`${START}c`, "push");
  assert.equal(third.currentDocumentID, 2);
});

test("forkTraversal moves the index on the copy only", () => {
  const history = session();
  history.pushState(`${START}one`, null);
  const forked = history.forkTraversal(0);
  assert.equal(forked.currentIndex, 0);
  assert.equal(forked.currentURL, START);
  assert.equal(history.currentIndex, 1);
  assert.equal(forked.length, 2);
});
