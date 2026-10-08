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

test("WeakValueMap returns the held value and forgets what was never kept", async () => {
  const { WeakValueMap } = await import("../../src/enumerable-weak.js");
  const map = new WeakValueMap<string, object>();
  const kept = {};
  map.set("kept", kept);
  assert.equal(map.get("kept"), kept);
  assert.equal(map.get("missing"), undefined);
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) return;
  map.set("dropped", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
  assert.equal(map.get("dropped"), undefined);
  assert.equal(map.get("kept"), kept);
});

test("DOMString conversion follows WebIDL", async () => {
  const { toDOMString, toLegacyNullToEmptyString, toNullableDOMString } =
    await import("../../src/facade/webidl.js");
  assert.equal(toDOMString(null), "null");
  assert.equal(toDOMString(undefined), "undefined");
  assert.equal(toLegacyNullToEmptyString(null), "");
  assert.equal(toLegacyNullToEmptyString(undefined), "undefined");
  assert.equal(toNullableDOMString(undefined), null);
  assert.equal(toNullableDOMString(1), "1");
  assert.throws(() => toDOMString(Symbol("x")), TypeError);
});

test("the authored style values are parsed once per attribute text", async () => {
  const { createAuthoredValueCache } = await import("../../src/facade/style.js");
  const { parse } = await import("../../src/css-tree-subpaths.js");
  let parses = 0;
  const values = createAuthoredValueCache(((...args: Parameters<typeof parse>) => {
    parses += 1;
    return parse(...args);
  }) as typeof parse);
  const element = {};
  const source = 'background: url("a.png"); color: red';
  assert.equal(values(element, source).get("background"), "url(a.png)");
  assert.equal(values(element, source).get("background"), "url(a.png)");
  assert.equal(parses, 1);
  // A new authored string is a new parse; one without a parenthesis needs none.
  assert.equal(values(element, "color: blue").size, 0);
  assert.equal(parses, 1);
  assert.equal(
    values(element, 'background: url("b.png")').get("background"),
    "url(b.png)",
  );
  assert.equal(parses, 2);
  // Another element has its own entry.
  values({}, source);
  assert.equal(parses, 3);
});

test("a patched member takes the name and length of the native one", () => {
  const prototype = createPrototype();
  const registry = createPatchRegistry();
  registry.patch(prototype, "appendChild", {
    writable: true,
    value(this: unknown) {
      return "patched";
    },
  });
  registry.patch(prototype, "baseURI", {
    get() {
      return "patched";
    },
  });
  assert.equal(prototype.appendChild.name, "appendChild");
  assert.equal(
    Object.getOwnPropertyDescriptor(prototype, "baseURI")!.get!.name,
    "get baseURI",
  );
});
