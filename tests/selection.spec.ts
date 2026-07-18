import { expect, test } from "@playwright/test";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function mountFrame(page: import("@playwright/test").Page, id = "selection-frame") {
  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = source.id;
    frame.src = source.url;
    document.querySelector("#host")?.append(frame);
  }, { id, url: `${fixture.origin}/documents/dom.html` });
  const frame = page.locator(`#${id}`);
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  return frame;
}

test("dispatches one asynchronous selectionchange for each virtual native transition", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  const events = await childValue(frame, async (window) => {
    const eventRecords: Array<{
      bubbles: boolean;
      cancelable: boolean;
      targetIsDocument: boolean;
      currentTargetIsDocument: boolean;
      childRealmEvent: boolean;
    }> = [];
    const waitForEvent = () => new Promise<void>((resolve) => {
      window.document.addEventListener("selectionchange", (event) => {
        eventRecords.push({
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          targetIsDocument: event.target === window.document,
          currentTargetIsDocument: event.currentTarget === window.document,
          childRealmEvent: event instanceof window.Event,
        });
        resolve();
      }, { once: true });
    });
    const copy = window.document.createElement("p");
    copy.textContent = "virtual selection";
    window.document.body.append(copy);
    const text = copy.firstChild!;
    const selection = window.getSelection()!;
    const range = window.document.createRange();
    range.selectNodeContents(text);

    let event = waitForEvent();
    selection.addRange(range);
    await event;

    event = waitForEvent();
    selection.collapse(text, 1);
    await event;

    event = waitForEvent();
    selection.removeAllRanges();
    await event;

    return eventRecords;
  });

  expect(events).toEqual([
    {
      bubbles: false,
      cancelable: false,
      targetIsDocument: true,
      currentTargetIsDocument: true,
      childRealmEvent: true,
    },
    {
      bubbles: false,
      cancelable: false,
      targetIsDocument: true,
      currentTargetIsDocument: true,
      childRealmEvent: true,
    },
    {
      bubbles: false,
      cancelable: false,
      targetIsDocument: true,
      currentTargetIsDocument: true,
      childRealmEvent: true,
    },
  ]);
});

test("dispatches private selection transitions without exposing host selections", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  await page.evaluate(() => {
    const copy = document.createElement("p");
    copy.textContent = "host selection";
    document.body.append(copy);
    const range = document.createRange();
    range.selectNodeContents(copy);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const result = await childValue(frame, async (window) => {
    const selection = window.getSelection()!;
    const copy = window.document.createElement("p");
    copy.textContent = "private selection";
    window.document.body.append(copy);
    const range = window.document.createRange();
    range.selectNodeContents(copy);
    let eventCount = 0;
    window.document.addEventListener("selectionchange", () => eventCount++);

    selection.addRange(range);
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    const selected = selection.toString();
    selection.removeRange(range);
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    return { eventCount, selected, rangeCount: selection.rangeCount };
  });

  expect(result).toEqual({ eventCount: 2, selected: "private selection", rangeCount: 0 });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("host selection");
});

test("supports replacing and clearing document.onselectionchange", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  const result = await childValue(frame, async (window) => {
    const selection = window.getSelection()!;
    const copy = window.document.createElement("p");
    copy.textContent = "selection handler";
    window.document.body.append(copy);
    const range = window.document.createRange();
    range.selectNodeContents(copy);
    let firstCalls = 0;
    const secondCalls: Array<{ thisIsDocument: boolean; targetIsDocument: boolean; childRealmEvent: boolean }> = [];

    window.document.onselectionchange = () => firstCalls++;
    window.document.onselectionchange = function (event) {
      secondCalls.push({
        thisIsDocument: this === window.document,
        targetIsDocument: event.target === window.document,
        childRealmEvent: event instanceof window.Event,
      });
    };
    selection.addRange(range);
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    window.document.onselectionchange = null;
    selection.removeAllRanges();
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    return {
      firstCalls,
      secondCalls,
      cleared: window.document.onselectionchange === null,
    };
  });

  expect(result).toEqual({
    firstCalls: 0,
    secondCalls: [{ thisIsDocument: true, targetIsDocument: true, childRealmEvent: true }],
    cleared: true,
  });
});

test("notifies when a native selection leaves a frame while isolating host and sibling changes", async ({ page }) => {
  await installBundle(page);
  const first = await mountFrame(page, "first-selection-frame");
  const second = await mountFrame(page, "second-selection-frame");

  const result = await page.evaluate(async () => {
    const frameWindow = (id: string) =>
      (document.querySelector(`#${id}`) as HTMLElement & { contentWindow: Window }).contentWindow;
    const firstWindow = frameWindow("first-selection-frame");
    const secondWindow = frameWindow("second-selection-frame");
    let firstEvents = 0;
    let secondEvents = 0;
    firstWindow.document.addEventListener("selectionchange", () => firstEvents++);
    secondWindow.document.addEventListener("selectionchange", () => secondEvents++);

    const hostCopy = document.createElement("p");
    hostCopy.textContent = "host-only";
    document.body.append(hostCopy);
    const hostRange = document.createRange();
    hostRange.selectNodeContents(hostCopy);
    const hostSelection = window.getSelection()!;
    hostSelection.removeAllRanges();
    hostSelection.addRange(hostRange);
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    const copy = firstWindow.document.createElement("p");
    copy.textContent = "first frame";
    firstWindow.document.body.append(copy);
    const range = document.createRange();
    range.selectNodeContents(copy);
    hostSelection.removeAllRanges();
    hostSelection.addRange(range);
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    hostSelection.removeAllRanges();
    hostSelection.addRange(hostRange);
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    return {
      firstEvents,
      secondEvents,
      firstRangeCount: firstWindow.getSelection()!.rangeCount,
      firstType: firstWindow.getSelection()!.type,
    };
  });

  expect(result).toEqual({
    firstEvents: 2,
    secondEvents: 0,
    firstRangeCount: 0,
    firstType: "None",
  });
});

test("cancels queued selectionchange when the frame is removed", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  await page.evaluate(() => {
    const frame = document.querySelector("#selection-frame") as HTMLElement & {
      contentWindow: Window;
    };
    const child = frame.contentWindow;
    (window as Window & typeof globalThis & { __selectionChangeAfterDispose: number })
      .__selectionChangeAfterDispose = 0;
    child.document.addEventListener("selectionchange", () => {
      (window as Window & typeof globalThis & { __selectionChangeAfterDispose: number })
        .__selectionChangeAfterDispose++;
    });
    const copy = child.document.createElement("p");
    copy.textContent = "removed frame";
    child.document.body.append(copy);
    const range = child.document.createRange();
    range.selectNodeContents(copy);
    child.getSelection()!.addRange(range);
    frame.remove();
  });
  await page.waitForTimeout(20);

  expect(await page.evaluate(
    () => (window as Window & typeof globalThis & { __selectionChangeAfterDispose: number })
      .__selectionChangeAfterDispose,
  )).toBe(0);
});

async function childValue<T>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis) => T,
) {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate((element as HTMLElement & { contentWindow: Window | null }).contentWindow);
  }, expression.toString()) as Promise<T>;
}

test("keeps host selections private while supporting virtual ranges", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  await page.evaluate(() => {
    const copy = document.createElement("p");
    copy.id = "outside-selection";
    copy.textContent = "host selection";
    document.body.append(copy);
    const range = document.createRange();
    range.selectNodeContents(copy.firstChild!);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  const state = await childValue(frame, (window) => {
    const selection = window.getSelection();
    if (selection === null) {
      throw new Error("The child selection facade is unavailable");
    }

    const before = {
      rangeCount: selection.rangeCount,
      anchorNode: selection.anchorNode,
      type: selection.type,
    };
    selection.removeAllRanges();

    const copy = window.document.createElement("p");
    copy.textContent = "virtual selection";
    window.document.body.append(copy);
    const range = window.document.createRange();
    range.selectNodeContents(copy.firstChild!);
    selection.addRange(range);
    const selected = {
      rangeCount: selection.rangeCount,
      rangeIdentity: selection.getRangeAt(0) === range,
      anchorIsVirtualText: selection.anchorNode === copy.firstChild,
      text: selection.toString(),
    };
    selection.removeRange(range);

    return {
      before,
      selected,
      after: {
        rangeCount: selection.rangeCount,
        anchorNode: selection.anchorNode,
        type: selection.type,
      },
      sharedDocumentSelection: selection === window.document.getSelection(),
      childRealmSelection: selection instanceof window.Selection,
      distinctHostSelection: selection !== window.parent.getSelection(),
    };
  });

  expect(state).toEqual({
    before: { rangeCount: 0, anchorNode: null, type: "None" },
    selected: {
      rangeCount: 1,
      rangeIdentity: true,
      anchorIsVirtualText: true,
      text: "virtual selection",
    },
    after: { rangeCount: 0, anchorNode: null, type: "None" },
    sharedDocumentSelection: true,
    childRealmSelection: true,
    distinctHostSelection: true,
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("host selection");
});

test("uses the virtual document element for document-root traversal", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page);

  const traversal = await childValue(frame, (window) => {
    const document = window.document;
    const treeWalker = document.createTreeWalker(document, window.NodeFilter.SHOW_ELEMENT);
    const treeWalkerNames = [(treeWalker.currentNode as Element).tagName.toLowerCase()];
    while (treeWalker.nextNode()) {
      treeWalkerNames.push((treeWalker.currentNode as Element).tagName.toLowerCase());
    }

    const iterator = document.createNodeIterator(document, window.NodeFilter.SHOW_ELEMENT);
    const iteratorNames: string[] = [];
    for (let node = iterator.nextNode(); node !== null; node = iterator.nextNode()) {
      iteratorNames.push((node as Element).tagName.toLowerCase());
    }

    const bodyWalker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_ELEMENT);
    return {
      treeWalkerRoot: treeWalker.root === document.documentElement,
      iteratorRoot: iterator.root === document.documentElement,
      nonDocumentRoot: bodyWalker.root === document.body,
      treeWalkerNames,
      iteratorNames,
    };
  });

  expect(traversal).toEqual({
    treeWalkerRoot: true,
    iteratorRoot: true,
    nonDocumentRoot: true,
    treeWalkerNames: ["v-html", "v-head", "v-body", "main", "input", "button"],
    iteratorNames: ["v-html", "v-head", "v-body", "main", "input", "button"],
  });
});

test("reports direction with the spec enum values and ignores addRange on a set selection", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "direction-frame");

  const state = await childValue(frame, (window) => {
    const document = window.document;
    const copy = document.createElement("p");
    copy.textContent = "direction";
    document.body.append(copy);
    const text = copy.firstChild as Text;
    const selection = window.getSelection();
    if (selection === null) {
      throw new Error("The child selection facade is unavailable");
    }

    selection.setBaseAndExtent(text, 3, text, 7);
    const forward = selection.direction;
    selection.setBaseAndExtent(text, 7, text, 3);
    const backward = selection.direction;
    selection.removeAllRanges();
    const none = selection.direction;

    const first = document.createRange();
    first.setStart(text, 0);
    first.setEnd(text, 2);
    selection.addRange(first);
    const second = document.createRange();
    second.setStart(text, 4);
    second.setEnd(text, 6);
    selection.addRange(second);

    return {
      forward,
      backward,
      none,
      rangeCount: selection.rangeCount,
      keptOffsets: [selection.anchorOffset, selection.focusOffset],
    };
  });

  expect(state).toEqual({
    forward: "forward",
    backward: "backward",
    none: "none",
    rangeCount: 1,
    keptOffsets: [0, 2],
  });
});
