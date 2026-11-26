import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeShadowElement,
  defineMockVFrame,
  prettyShadowDOM,
  resetChannels,
  shadowScreen,
  waitFor,
} from "../../src/testing.js";

describe("@mewhhaha/v-frame/testing (Node / SSR safety)", () => {
  it("imports safely without browser globals and throws cleanly only when queried", () => {
    assert.equal(typeof shadowScreen.getByRole, "function");
    assert.equal(typeof shadowScreen.findByText, "function");
    assert.equal(prettyShadowDOM(), "");
    assert.equal(activeShadowElement(), null);
    assert.throws(() => shadowScreen.getByRole("button"), /query root is not available/);
    assert.throws(() => defineMockVFrame(), /requires a DOM environment/);
  });

  it("waitFor retries until callback succeeds and surfaces the last error on timeout", async () => {
    let attempts = 0;
    const value = await waitFor(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt ${attempts}`);
        return "ready";
      },
      { timeout: 500, interval: 5 },
    );
    assert.equal(value, "ready");
    assert.equal(attempts, 3);

    let failedAttempts = 0;
    await assert.rejects(
      () =>
        waitFor(
          () => {
            failedAttempts += 1;
            throw new Error(`still failing #${failedAttempts}`);
          },
          { timeout: 40, interval: 5 },
        ),
      /still failing #\d+/,
    );
    assert.ok(failedAttempts >= 2);
  });

  it("resetChannels clears retained values and optionally detaches the hub", () => {
    const hubKey = Symbol.for("@mewhhaha/v-frame/channel-hub/1");
    const retained = new Map<string, unknown>([
      ["orders.selected.v1", { id: "A42" }],
      ["cart.count.v1", 3],
    ]);
    const fakeDoc = {
      nodeType: 9,
      [hubKey]: { retained },
    } as unknown as Document;

    resetChannels(fakeDoc);
    assert.equal(retained.size, 0);
    assert.ok(hubKey in (fakeDoc as unknown as Record<PropertyKey, unknown>));

    retained.set("orders.selected.v1", { id: "B7" });
    resetChannels({ document: fakeDoc, disconnectSubscribers: true });
    assert.equal(retained.size, 0);
    assert.equal(hubKey in (fakeDoc as unknown as Record<PropertyKey, unknown>), false);
  });
});
