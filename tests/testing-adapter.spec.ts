import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import type * as ChannelModule from "../src/channel.js";
import type * as TestingModule from "../src/testing.js";
import {
  bundleRoute,
  channelBundleRoute,
  htmlDocument,
  startHTTPFixture,
  testingBundleRoute,
  type HTTPFixture,
} from "./support/http-fixture.js";
import { installBundle, mountFrame } from "./support/mount-frame.js";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument(`
        <header>
          <h1>Shell Workspace</h1>
          <button type="button" data-testid="shell-action">Refresh Shell</button>
        </header>
        <main id="host"></main>
      `),
      "/mock-host": htmlDocument(`<main id="mock-host"></main>`),
      "/dist/index.js": bundleRoute,
      "/dist/channel.js": channelBundleRoute,
      "/dist/testing.js": testingBundleRoute,
      "/orders": htmlDocument(
        `
        <section aria-label="Orders Panel">
          <h2>Orders</h2>
          <p>Order <strong>#42</strong> ready</p>
          <label for="order-search">Search orders</label>
          <input id="order-search" type="search" placeholder="Filter by ID" value="ORD-42" />
          <label>
            Include archived
            <input type="checkbox" checked />
          </label>
          <select aria-label="Order status">
            <option value="open">Open</option>
            <option value="shipped" selected>Shipped</option>
          </select>
          <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Order preview" />
          <span title="Priority shipping">Express</span>
          <button type="button" id="select-order" aria-pressed="false" data-testid="select-btn">
            Save
          </button>
          <button type="button" hidden>Hidden Save</button>
          <div id="aria-title">Custom Widget Title</div>
          <button type="button" aria-labelledby="aria-title" aria-describedby="aria-desc">
            Ignored Text
          </button>
          <span id="aria-desc">Opens widget details</span>
          <div id="wc-host"></div>
          <v-frame id="nested-notes" src="/notes"></v-frame>
        </section>
        <script type="module">
          import { channel } from "/dist/channel.js";
          const selected = channel("orders.selected.v1");
          const btn = document.querySelector("#select-order");
          btn.addEventListener("click", () => {
            const next = btn.getAttribute("aria-pressed") !== "true";
            btn.setAttribute("aria-pressed", String(next));
            selected.publish({ id: "42", active: next }, { retain: true });
          });

          const wc = document.querySelector("#wc-host");
          const shadow = wc.attachShadow({ mode: "open" });
          shadow.innerHTML =
            '<button type="button" data-testid="wc-btn">Inside Guest Shadow</button>';
        </script>
        `,
        `<title>Hidden Orders Head Title</title><style>body { color: rgb(20, 30, 40); }</style>`,
      ),
      "/notes": htmlDocument(`
        <article>
          <h3>Nested Notes</h3>
          <button type="button" id="add-note">Add Note</button>
          <div id="note-list"></div>
        </article>
        <script>
          document.querySelector("#add-note").addEventListener("click", () => {
            setTimeout(() => {
              const p = document.createElement("p");
              p.textContent = "Note saved asynchronously";
              document.querySelector("#note-list").append(p);
            }, 30);
          });
        </script>
      `),
      "/details": htmlDocument(`
        <section aria-label="Details Panel">
          <h2>Details</h2>
          <button type="button">Save</button>
          <p id="selected-output" data-testid="details-output">None</p>
        </section>
        <script type="module">
          import { channel } from "/dist/channel.js";
          const selected = channel("orders.selected.v1");
          selected.subscribe((value) => {
            document.querySelector("#selected-output").textContent =
              "Selected #" + value.id + " (" + value.active + ")";
          });
        </script>
      `),
      "/details-v2": htmlDocument(`
        <section aria-label="Details Panel">
          <h2>Details v2</h2>
          <button type="button">Archive Order</button>
        </section>
      `),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

test("shadowScreen and withinFrame pierce host, sibling frames, nested frames, and guest shadow roots", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { id: "orders", src: `${fixture.origin}/orders` });
  await mountFrame(page, { id: "details", src: `${fixture.origin}/details` });

  const result = await page.evaluate(async (origin) => {
    const testing = (await import(`${origin}/dist/testing.js`)) as typeof TestingModule;
    const {
      shadowScreen,
      withinFrame,
      withinShadow,
      queryShadow,
      queryAllShadow,
      prettyShadowDOM,
    } = testing;

    const ordersFrame = document.querySelector("#orders") as VFrameElement;
    const detailsFrame = document.querySelector("#details") as VFrameElement;

    const orders = withinFrame(ordersFrame);
    const details = withinFrame(detailsFrame);
    await orders.ready();
    await details.ready();

    // Wait for nested <v-frame id="nested-notes"> inside orders to become ready.
    const nestedFrame = orders.queryShadow<VFrameElement>("v-frame#nested-notes");
    if (!nestedFrame) throw new Error("nested frame not found");
    await withinFrame(nestedFrame).ready();

    // 1. Page-wide queries across host + orders + details + nested + guest Web Component
    const shellHeading = shadowScreen.getByRole("heading", {
      name: "Shell Workspace",
      level: 1,
    });
    const ordersHeading = shadowScreen.getByRole("heading", { name: "Orders", level: 2 });
    const nestedHeading = shadowScreen.getByRole("heading", {
      name: "Nested Notes",
      level: 3,
    });
    const wcButton = shadowScreen.getByRole("button", { name: "Inside Guest Shadow" });
    const allSaveButtons = shadowScreen.getAllByRole("button", { name: "Save" });

    // Hidden button is excluded unless hidden: true, and <v-head> <title> text is excluded.
    const hiddenExcluded = shadowScreen.queryByRole("button", { name: "Hidden Save" });
    const hiddenIncluded = shadowScreen.getByRole("button", {
      name: "Hidden Save",
      hidden: true,
    });
    const headTitleLeak = shadowScreen.queryByText("Hidden Orders Head Title");

    // Inline formatted text, labels, placeholders, display values, alt, title, testid, ARIA attrs.
    const formattedOrderText = orders.getByText("Order #42 ready");
    const searchInput = orders.getByLabelText<HTMLInputElement>("Search orders");
    const searchByPlaceholder =
      orders.getByPlaceholderText<HTMLInputElement>("Filter by ID");
    const searchByDisplayValue = orders.getByDisplayValue<HTMLInputElement>("ORD-42");
    const selectByDisplayValue = orders.getByDisplayValue<HTMLSelectElement>("Shipped");
    const checkbox = orders.getByRole<HTMLInputElement>("checkbox", {
      name: "Include archived",
      checked: true,
    });
    const imgByAlt = orders.getByAltText<HTMLImageElement>("Order preview");
    const expressByTitle = orders.getByTitle("Priority shipping");
    const labelledByButton = orders.getByRole("button", {
      name: "Custom Widget Title",
      description: "Opens widget details",
    });

    // 2. Scoped queries disambiguate duplicate "Save" buttons across sibling frames.
    const ordersSave = orders.getByRole("button", { name: "Save", pressed: false });
    const detailsSave = details.getByRole("button", { name: "Save" });

    // 3. Cross-app interaction via channel: click in orders -> verify details updates!
    ordersSave.click();
    const pressedAfterClick = orders.getByRole("button", { name: "Save", pressed: true });
    const detailsOutput = await details.findByTestId("details-output");
    const syncedText = await testing.waitFor(() => {
      const el = details.getByTestId("details-output");
      if (el.textContent !== "Selected #42 (true)") {
        throw new Error(`unexpected text: ${el.textContent}`);
      }
      return el.textContent;
    });

    // 4. Async findByText inside nested <v-frame>.
    const addNoteBtn = shadowScreen.getByRole("button", { name: "Add Note" });
    addNoteBtn.click();
    const asyncNote = await shadowScreen.findByText(
      "Note saved asynchronously",
      undefined,
      {
        timeout: 1500,
      },
    );

    // 5. withinFrame stays valid across document replacement / shadowRoot swap!
    const shadowBeforeSwap = detailsFrame.shadowRoot;
    detailsFrame.src = `${origin}/details-v2`;
    await details.ready();
    const shadowSwapped = detailsFrame.shadowRoot !== shadowBeforeSwap;
    const v2Heading = details.getByRole("heading", { name: "Details v2" });
    const archiveButton = details.getByRole("button", { name: "Archive Order" });

    // 6. queryShadow / queryAllShadow / withinShadow / prettyShadowDOM
    const allHeadings = queryAllShadow(document, "h1, h2, h3");
    const directWc = queryShadow(ordersFrame, '[data-testid="wc-btn"]');
    const scopedByShadow = withinShadow(ordersFrame).getByTestId("select-btn");
    const dump = prettyShadowDOM(ordersFrame);

    let multipleError = "";
    try {
      shadowScreen.getByRole("button", { name: "Save" });
    } catch (error) {
      multipleError = error instanceof Error ? error.message : String(error);
    }

    return {
      shellHeading: shellHeading.textContent,
      ordersHeading: ordersHeading.textContent,
      nestedHeading: nestedHeading.textContent,
      wcButton: wcButton.textContent,
      saveCount: allSaveButtons.length,
      hiddenExcluded: hiddenExcluded === null,
      hiddenIncluded: hiddenIncluded.textContent,
      headTitleLeak: headTitleLeak === null,
      formattedTag: formattedOrderText.tagName,
      sameSearchInput:
        searchInput === searchByPlaceholder && searchInput === searchByDisplayValue,
      selectValue: selectByDisplayValue.value,
      checkboxChecked: checkbox.checked,
      imgAlt: imgByAlt.alt,
      expressText: expressByTitle.textContent,
      labelledByTag: labelledByButton.tagName,
      distinctSaves: ordersSave !== detailsSave,
      pressedUpdated: pressedAfterClick === ordersSave,
      detailsOutputTag: detailsOutput.tagName,
      syncedText,
      asyncNoteText: asyncNote.textContent,
      shadowSwapped,
      v2Heading: v2Heading.textContent,
      archiveButton: archiveButton.textContent,
      headingCount: allHeadings.length,
      directWcMatch: directWc === wcButton,
      scopedByShadowMatch: scopedByShadow === ordersSave,
      dumpHasShadowMarker: dump.includes("#shadow-root (open)"),
      dumpSkipsVHead: !dump.includes("Hidden Orders Head Title"),
      // After details navigated to v2, only orders still has "Save", so verify no error there
      multipleError,
    };
  }, fixture.origin);

  expect(result).toMatchObject({
    shellHeading: "Shell Workspace",
    ordersHeading: "Orders",
    nestedHeading: "Nested Notes",
    wcButton: "Inside Guest Shadow",
    saveCount: 2,
    hiddenExcluded: true,
    hiddenIncluded: "Hidden Save",
    headTitleLeak: true,
    formattedTag: "P",
    sameSearchInput: true,
    selectValue: "shipped",
    checkboxChecked: true,
    imgAlt: "Order preview",
    expressText: "Express",
    labelledByTag: "BUTTON",
    distinctSaves: true,
    pressedUpdated: true,
    detailsOutputTag: "P",
    syncedText: "Selected #42 (true)",
    asyncNoteText: "Note saved asynchronously",
    shadowSwapped: true,
    v2Heading: "Details v2",
    archiveButton: "Archive Order",
    headingCount: 4,
    directWcMatch: true,
    scopedByShadowMatch: true,
    dumpHasShadowMarker: true,
    dumpSkipsVHead: true,
    multipleError: "",
  });
});

test("getBy* throws descriptive errors with expanded shadow DOM when missing or duplicated", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { id: "orders", src: `${fixture.origin}/orders` });
  await mountFrame(page, { id: "details", src: `${fixture.origin}/details` });

  const errors = await page.evaluate(async (origin) => {
    const { shadowScreen } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    let duplicateMsg = "";
    let missingMsg = "";
    try {
      shadowScreen.getByRole("button", { name: "Save" });
    } catch (error) {
      duplicateMsg = error instanceof Error ? error.message : String(error);
    }
    try {
      shadowScreen.getByRole("button", { name: "Does Not Exist" });
    } catch (error) {
      missingMsg = error instanceof Error ? error.message : String(error);
    }
    return { duplicateMsg, missingMsg };
  }, fixture.origin);

  expect(errors.duplicateMsg).toContain("Found multiple elements (2)");
  expect(errors.duplicateMsg).toContain("#shadow-root (open)");
  expect(errors.missingMsg).toContain('Unable to find an element matching role "button"');
  expect(errors.missingMsg).toContain("#shadow-root (open)");
});

test("resetChannels clears retained cross-frame channel state", async ({ page }) => {
  await installBundle(page, fixture.origin);

  const result = await page.evaluate(async (origin) => {
    const { channel } = (await import(
      `${origin}/dist/channel.js`
    )) as typeof ChannelModule;
    const { resetChannels } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;

    const topicA = channel<{ id: string }>("orders.selected.v1");
    const topicB = channel<number>("cart.count.v1");
    const received: string[] = [];
    const unsubscribe = topicA.subscribe((value) => received.push(value.id));

    topicA.publish({ id: "A1" }, { retain: true });
    topicB.publish(5, { retain: true });

    const before = { a: topicA.get(), b: topicB.get() };
    resetChannels();
    const afterRetainedReset = { a: topicA.get(), b: topicB.get() };

    // Subscribers remain connected after default resetChannels().
    topicA.publish({ id: "A2" });
    const receivedAfterDefault = [...received];

    // With disconnectSubscribers: true, old listeners are detached.
    resetChannels({ disconnectSubscribers: true });
    topicA.publish({ id: "A3" });
    const receivedAfterDisconnect = [...received];
    unsubscribe();

    return { before, afterRetainedReset, receivedAfterDefault, receivedAfterDisconnect };
  }, fixture.origin);

  expect(result).toEqual({
    before: { a: { id: "A1" }, b: 5 },
    afterRetainedReset: { a: undefined, b: undefined },
    receivedAfterDefault: ["A1", "A2"],
    receivedAfterDisconnect: ["A1", "A2"],
  });
});

test("defineMockVFrame mocks routes, shadow rendering, events, navigation, history, and restore", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/mock-host`);

  const result = await page.evaluate(async (origin) => {
    const { defineMockVFrame, shadowScreen, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;

    const mock = defineMockVFrame({
      "/orders": `<!doctype html><html><head><title>Ignored Title</title></head><body>
        <h2>Mock Orders</h2>
        <button type="button">Create Order</button>
      </body></html>`,
      "/orders/42": () => ({
        html: `<h2>Order 42</h2><p>Mock details</p>`,
      }),
      "/broken": { html: "boom", status: 500 },
    });

    const events: string[] = [];
    const frame = document.createElement("v-frame") as VFrameElement;
    frame.addEventListener("v-frame-loadstart", () => events.push("loadstart"));
    frame.addEventListener("v-frame-load", () => events.push("load"));
    frame.addEventListener("v-frame-navigated", (e) =>
      events.push(`navigated:${(e as CustomEvent<{ kind: string }>).detail.kind}`),
    );
    frame.addEventListener("v-frame-error", () => events.push("error"));
    frame.src = "/orders";
    document.querySelector("#mock-host")!.append(frame);

    const scoped = withinFrame(frame);
    await scoped.ready();
    const initialHeading = shadowScreen.getByRole("heading", {
      name: "Mock Orders",
    }).textContent;
    const titleNotLeaked = shadowScreen.queryByText("Ignored Title") === null;

    await frame.navigate("/orders/42");
    const secondHeading = scoped.getByRole("heading", { name: "Order 42" }).textContent;
    const historyAtSecond = { back: frame.canGoBack, forward: frame.canGoForward };

    await frame.back();
    const backHeading = scoped.getByRole("heading", { name: "Mock Orders" }).textContent;
    const historyAfterBack = { back: frame.canGoBack, forward: frame.canGoForward };

    await frame.forward();
    const forwardHeading = scoped.getByRole("heading", { name: "Order 42" }).textContent;

    // Route update + reload
    mock.setRoutes({
      "/orders/42": "<h2>Order 42 Refreshed</h2>",
      "/broken": { html: "err", status: 500 },
    });
    await frame.reload();
    const reloadedHeading = scoped.getByRole("heading", {
      name: "Order 42 Refreshed",
    }).textContent;

    // Error handling
    const errorFrame = document.createElement("v-frame") as VFrameElement;
    errorFrame.src = "/broken";
    document.querySelector("#mock-host")!.append(errorFrame);
    let errorRejected = false;
    try {
      await errorFrame.whenReady();
    } catch {
      errorRejected = true;
    }

    const requestCount = mock.requests.length;
    mock.clearRequests();
    const clearedCount = mock.requests.length;
    mock.restore();

    // Calling defineMockVFrame again reuses the existing mock element definition cleanly.
    const secondMock = defineMockVFrame({
      "/second": "<p>Second suite</p>",
    });
    const frame2 = document.createElement("v-frame") as VFrameElement;
    frame2.src = "/second";
    document.querySelector("#mock-host")!.append(frame2);
    await frame2.whenReady();
    const secondSuiteText = withinFrame(frame2).getByText("Second suite").textContent;
    secondMock.restore();

    return {
      initialHeading,
      titleNotLeaked,
      secondHeading,
      historyAtSecond,
      backHeading,
      historyAfterBack,
      forwardHeading,
      reloadedHeading,
      errorRejected,
      errorStatus: errorFrame.status,
      events,
      requestCount,
      clearedCount,
      secondSuiteText,
    };
  }, fixture.origin);

  expect(result).toEqual({
    initialHeading: "Mock Orders",
    titleNotLeaked: true,
    secondHeading: "Order 42",
    historyAtSecond: { back: true, forward: false },
    backHeading: "Mock Orders",
    historyAfterBack: { back: false, forward: true },
    forwardHeading: "Order 42",
    reloadedHeading: "Order 42 Refreshed",
    errorRejected: true,
    errorStatus: "error",
    events: [
      "loadstart",
      "load",
      "loadstart",
      "navigated:push",
      "load",
      "loadstart",
      "navigated:traverse",
      "load",
      "loadstart",
      "navigated:traverse",
      "load",
      "loadstart",
      "load",
    ],
    requestCount: 6,
    clearedCount: 0,
    secondSuiteText: "Second suite",
  });
});
