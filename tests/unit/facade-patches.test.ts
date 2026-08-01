// dispose() is reached from several paths in VFrameElement, so the record of
// what the facade overwrote on the realm's prototypes has to survive being
// unwound twice. These cases stand in for those prototypes with plain objects,
// which is all the registry ever sees.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPatchRegistry } from "../../src/facade/context.js";

interface FakePrototype {
  appendChild(): string;
  readonly baseURI: string;
}

/** One data property and one accessor, the two shapes the facade replaces. */
function createPrototype(): FakePrototype {
  const prototype = {};
  Object.defineProperty(prototype, "appendChild", {
    configurable: true,
    writable: true,
    value: function nativeAppendChild(): string {
      return "native";
    },
  });
  Object.defineProperty(prototype, "baseURI", {
    configurable: true,
    get: function nativeBaseURI(): string {
      return "native";
    },
  });
  return prototype as FakePrototype;
}

test("restores each patched key to the descriptor it replaced", () => {
  const prototype = createPrototype();
  const before = Object.getOwnPropertyDescriptors(prototype);
  const registry = createPatchRegistry();

  registry.patch(prototype, "appendChild", {
    writable: true,
    value: () => "patched",
  });
  registry.patch(prototype, "baseURI", { get: () => "patched" });
  // A key the prototype does not own has to disappear again, not come back undefined.
  registry.patch(prototype, "ownerDocument", { get: () => "patched" });
  assert.equal(prototype.appendChild(), "patched");

  registry.restorePatches();

  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
  assert.equal("ownerDocument" in prototype, false);
  assert.equal(prototype.appendChild(), "native");
  assert.equal(prototype.baseURI, "native");
});

test("leaves the prototypes restored when dispose runs twice", () => {
  const prototype = createPrototype();
  const before = Object.getOwnPropertyDescriptors(prototype);
  const registry = createPatchRegistry();

  // Two patches of one key is what makes the restore order observable: unwinding
  // oldest-first would leave the first patch installed instead of the native
  // descriptor.
  registry.patch(prototype, "appendChild", { writable: true, value: () => "first" });
  registry.patch(prototype, "appendChild", { writable: true, value: () => "second" });
  registry.patch(prototype, "baseURI", { get: () => "patched" });

  registry.restorePatches();
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);

  registry.restorePatches();
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
  assert.equal(prototype.appendChild(), "native");
  assert.equal(prototype.baseURI, "native");
});

test("patches again after a restore instead of replaying the old record", () => {
  const prototype = createPrototype();
  const before = Object.getOwnPropertyDescriptors(prototype);
  const registry = createPatchRegistry();

  registry.patch(prototype, "appendChild", { writable: true, value: () => "first" });
  registry.restorePatches();
  registry.patch(prototype, "baseURI", { get: () => "second" });
  assert.equal(prototype.baseURI, "second");

  registry.restorePatches();
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
});
