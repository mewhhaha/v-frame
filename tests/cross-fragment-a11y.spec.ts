import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import type * as TestingModule from "../src/testing.js";
import { auditAccessibility } from "./support/accessibility.js";
import {
  bundleRoute,
  channelBundleRoute,
  startHTTPFixture,
  testingBundleRoute,
  type HTTPFixture,
} from "./support/http-fixture.js";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame.js";

const sharedStyles = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; color: #111; background: #fff; }
  button, input { font: inherit; color: #111; background: #fff; border: 1px solid #444; padding: 6px 10px; }
  button[aria-pressed="true"] { background: #111; color: #fff; }
  :focus-visible { outline: 3px solid #0645ad; outline-offset: 2px; }
  [hidden] { display: none !important; }
  section { display: grid; gap: 10px; padding: 12px; border: 1px solid #ccc; }
  [popover] { position: fixed; inset: auto; top: 80px; left: 24px; margin: 0; padding: 14px; background: #fff; color: #111; border: 2px solid #111; }
  dialog { padding: 16px; background: #fff; color: #111; border: 2px solid #111; }
  dialog::backdrop { background: rgb(0 0 0 / 45%); }
`;

const hostDocument = `<!doctype html>
<html lang="en">
<head>
  <title>Order Desk</title>
  <style>
    ${sharedStyles}
    header, main, footer { max-width: 960px; margin: 0 auto; padding: 12px 16px; }
    nav { display: flex; gap: 8px; align-items: center; }
    #host { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
    v-frame { display: block; min-height: 220px; }
  </style>
</head>
<body>
  <header>
    <h1>Order Desk</h1>
    <nav aria-label="Workspace filter">
      <button type="button" id="filter-all" aria-pressed="true">All orders</button>
      <button type="button" id="filter-priority" aria-pressed="false">Priority only</button>
    </nav>
    <p id="host-status" role="status" aria-live="polite">Workspace ready</p>
  </header>
  <main>
    <div id="host"></div>
  </main>
  <footer>
    <button type="button" id="host-footer-btn">Help desk</button>
  </footer>
  <script type="module">
    import { channel } from "/dist/channel.js";
    const filter = channel("orders.filter.v1");
    const activity = channel("orders.activity.v1");
    const allBtn = document.querySelector("#filter-all");
    const priorityBtn = document.querySelector("#filter-priority");
    const status = document.querySelector("#host-status");

    const setFilter = (priorityOnly) => {
      allBtn.setAttribute("aria-pressed", String(!priorityOnly));
      priorityBtn.setAttribute("aria-pressed", String(priorityOnly));
      filter.publish({ priorityOnly }, { retain: true });
    };
    allBtn.addEventListener("click", () => setFilter(false));
    priorityBtn.addEventListener("click", () => setFilter(true));
    activity.subscribe((entry) => {
      status.textContent = "Last activity: " + entry.summary;
    });
  </script>
</body>
</html>`;

const catalogDocument = `<!doctype html>
<html lang="en">
<head>
  <title>Catalog fragment</title>
  <style>
    ${sharedStyles}
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  </style>
</head>
<body>
  <section aria-label="Order catalog">
    <h2>Orders</h2>
    <label for="catalog-search">Filter orders</label>
    <input id="catalog-search" type="search" placeholder="Search by mission" />
    <div>
      <button type="button" id="filter-popover-btn" popovertarget="filter-popover">
        Filter options
      </button>
      <button type="button" id="catalog-reset">Reset</button>
    </div>
    <div
      id="filter-popover"
      popover="auto"
      role="dialog"
      aria-labelledby="filter-popover-title"
      aria-describedby="filter-popover-desc"
    >
      <h3 id="filter-popover-title">Filter options</h3>
      <p id="filter-popover-desc">Narrow orders by priority status.</p>
      <label>
        <input id="popover-priority" type="checkbox" />
        Priority missions only
      </label>
      <button type="button" popovertarget="filter-popover" popovertargetaction="hide">
        Close options
      </button>
    </div>
    <ul id="order-list"></ul>
    <button type="button" hidden>Hidden catalog action</button>
  </section>
  <script type="module">
    import { channel } from "/dist/channel.js";
    const filter = channel("orders.filter.v1");
    const selected = channel("orders.selected.v1");

    const orders = [
      { id: "101", label: "#101 Apollo", priority: false },
      { id: "102", label: "#102 Gemini", priority: true },
      { id: "103", label: "#103 Mercury", priority: true },
    ];
    let priorityOnly = false;
    let query = "";
    let activeId = null;

    const list = document.querySelector("#order-list");
    const search = document.querySelector("#catalog-search");
    const popoverPriority = document.querySelector("#popover-priority");
    const resetBtn = document.querySelector("#catalog-reset");

    const render = () => {
      list.replaceChildren();
      for (const order of orders) {
        if (priorityOnly && !order.priority) continue;
        if (query && !order.label.toLowerCase().includes(query.toLowerCase())) continue;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = order.label;
        btn.setAttribute("aria-pressed", String(order.id === activeId));
        if (order.id === activeId) btn.setAttribute("aria-current", "true");
        btn.addEventListener("click", () => {
          activeId = order.id;
          selected.publish(order, { retain: true });
          render();
        });
        li.append(btn);
        list.append(li);
      }
    };

    filter.subscribe((state) => {
      priorityOnly = Boolean(state.priorityOnly);
      popoverPriority.checked = priorityOnly;
      render();
    });
    selected.subscribe((order) => {
      activeId = order?.id ?? null;
      render();
    });
    popoverPriority.addEventListener("change", () => {
      filter.publish({ priorityOnly: popoverPriority.checked }, { retain: true });
    });
    search.addEventListener("input", () => {
      query = search.value;
      render();
    });
    resetBtn.addEventListener("click", () => {
      query = "";
      search.value = "";
      filter.publish({ priorityOnly: false }, { retain: true });
    });
    render();
  </script>
</body>
</html>`;

const inspectorDocument = `<!doctype html>
<html lang="en">
<head>
  <title>Inspector fragment</title>
  <style>
    ${sharedStyles}
    v-frame { display: block; min-height: 110px; }
  </style>
</head>
<body>
  <section aria-label="Order inspector">
    <h2 id="inspector-heading">No order selected</h2>
    <p id="inspector-status" role="status" aria-live="polite">Choose an order from the catalog</p>
    <form id="note-form">
      <label for="inspector-note">Inspector note</label>
      <input id="inspector-note" name="note" required aria-describedby="note-help" />
      <p id="note-help">Recorded in the shared audit log.</p>
      <button type="submit">Save note</button>
      <button type="button" id="inspector-reset">Reset</button>
    </form>
    <button type="button" id="archive-trigger">Archive order</button>
    <dialog id="archive-dialog" aria-labelledby="archive-title" aria-describedby="archive-desc">
      <h3 id="archive-title">Archive order</h3>
      <p id="archive-desc">Move this order into the read-only archive.</p>
      <form method="dialog">
        <button type="submit" value="cancel">Cancel archive</button>
        <button type="submit" value="confirm">Confirm archive</button>
      </form>
    </dialog>
    <v-frame id="audit-log" src="/audit-log" aria-label="Audit log"></v-frame>
  </section>
  <script type="module">
    import { channel } from "/dist/channel.js";
    const selected = channel("orders.selected.v1");
    const activity = channel("orders.activity.v1");

    let currentOrder = null;
    const heading = document.querySelector("#inspector-heading");
    const status = document.querySelector("#inspector-status");
    const noteInput = document.querySelector("#inspector-note");
    const form = document.querySelector("#note-form");
    const resetBtn = document.querySelector("#inspector-reset");
    const archiveTrigger = document.querySelector("#archive-trigger");
    const archiveDialog = document.querySelector("#archive-dialog");

    selected.subscribe((order) => {
      currentOrder = order;
      heading.textContent = "Inspecting " + order.label;
      status.textContent = "Active selection: " + order.label;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = noteInput.value.trim();
      if (!note) return;
      const label = currentOrder ? currentOrder.label : "Unassigned";
      const summary = label + " — " + note;
      status.textContent = "Saved note for " + label;
      activity.publish({ summary }, { retain: true });
      noteInput.value = "";
    });

    resetBtn.addEventListener("click", () => {
      noteInput.value = "";
      status.textContent = "Draft cleared";
    });

    archiveTrigger.addEventListener("click", () => {
      archiveDialog.showModal();
    });

    archiveDialog.addEventListener("close", () => {
      if (archiveDialog.returnValue === "confirm") {
        const label = currentOrder ? currentOrder.label : "order";
        activity.publish({ summary: "Archived " + label }, { retain: true });
      }
    });
  </script>
</body>
</html>`;

const auditLogDocument = `<!doctype html>
<html lang="en">
<head>
  <title>Audit log fragment</title>
  <style>
    ${sharedStyles}
  </style>
</head>
<body>
  <section aria-label="Audit trail">
    <h3>Activity log</h3>
    <div id="badge-host"></div>
    <details id="history-details">
      <summary>Event history</summary>
      <ul id="history-list"></ul>
    </details>
  </section>
  <script type="module">
    import { channel } from "/dist/channel.js";
    const selected = channel("orders.selected.v1");
    const activity = channel("orders.activity.v1");

    const badgeHost = document.querySelector("#badge-host");
    const badgeShadow = badgeHost.attachShadow({ mode: "open" });
    const badgeText = document.createElement("span");
    badgeText.setAttribute("role", "status");
    badgeText.dataset.testid = "nested-badge";
    badgeText.textContent = "Badge: idle";
    badgeShadow.append(badgeText);

    const historyList = document.querySelector("#history-list");

    selected.subscribe((order) => {
      badgeText.textContent = "Badge: " + order.label;
    });

    activity.subscribe((entry) => {
      const li = document.createElement("li");
      li.textContent = entry.summary;
      historyList.append(li);
    });
  </script>
</body>
</html>`;

const archivedInspectorDocument = `<!doctype html>
<html lang="en">
<head>
  <title>Archived order fragment</title>
  <style>
    ${sharedStyles}
  </style>
</head>
<body>
  <section aria-label="Archived order">
    <h2>Order archived</h2>
    <p role="status">This order is now read-only.</p>
    <button type="button" id="reopen-btn">Return to active orders</button>
  </section>
</body>
</html>`;

let fixture: HTTPFixture;

async function auditWCAG(page: Page): Promise<void> {
  const results = await auditAccessibility(page);
  expect(
    results.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function mountWorkspace(page: Page) {
  await installBundle(page, fixture.origin);
  const catalog = await mountFrame(page, {
    id: "catalog",
    src: `${fixture.origin}/catalog`,
  });
  const inspector = await mountFrame(page, {
    id: "inspector",
    src: `${fixture.origin}/inspector`,
  });
  // Wait for nested audit-log frame inside inspector via @mewhhaha/v-frame/testing.
  await page.evaluate(async (origin) => {
    const { withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const inspectorEl = document.querySelector<VFrameElement>("#inspector")!;
    const auditEl = withinFrame(inspectorEl).queryShadow<VFrameElement>("#audit-log");
    if (!auditEl) throw new Error("Nested audit-log frame missing");
    await withinFrame(auditEl).ready();
  }, fixture.origin);
  return { catalog, inspector };
}

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": hostDocument,
      "/dist/index.js": bundleRoute,
      "/dist/channel.js": channelBundleRoute,
      "/dist/testing.js": testingBundleRoute,
      "/catalog": catalogDocument,
      "/inspector": inspectorDocument,
      "/audit-log": auditLogDocument,
      "/inspector/archived": archivedInspectorDocument,
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

test("cross-fragment workflow syncs host, sibling frames, nested frame, and Web Component while staying WCAG-compliant", async ({
  page,
}) => {
  const { catalog, inspector } = await mountWorkspace(page);
  await auditWCAG(page);

  const flow = await page.evaluate(async (origin) => {
    const { shadowScreen, waitFor, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;

    const catalogEl = document.querySelector<VFrameElement>("#catalog")!;
    const inspectorEl = document.querySelector<VFrameElement>("#inspector")!;
    const catalogQ = withinFrame(catalogEl);
    const inspectorQ = withinFrame(inspectorEl);
    const auditEl = inspectorQ.queryShadow<VFrameElement>("#audit-log")!;
    const auditQ = withinFrame(auditEl);

    // 1. Heading hierarchy and landmarks across host -> siblings -> nested fragment
    const h1 = shadowScreen.getByRole("heading", { name: "Order Desk", level: 1 });
    const h2s = shadowScreen
      .getAllByRole("heading", { level: 2 })
      .map((el) => el.textContent);
    const h3 = shadowScreen.getByRole("heading", { name: "Activity log", level: 3 });

    // 2. Disambiguate duplicate "Reset" buttons across sibling fragments
    const totalResets = shadowScreen.getAllByRole("button", { name: "Reset" }).length;
    const distinctResets =
      catalogQ.getByRole("button", { name: "Reset" }) !==
      inspectorQ.getByRole("button", { name: "Reset" });

    // 3. Host filter narrows Catalog fragment items
    shadowScreen.getByRole("button", { name: "Priority only", pressed: false }).click();
    await waitFor(() => {
      if (catalogQ.queryByRole("button", { name: "#101 Apollo" }) !== null) {
        throw new Error("#101 Apollo should be filtered out");
      }
    });
    const priorityPressed =
      shadowScreen.queryByRole("button", { name: "Priority only", pressed: true }) !==
      null;

    // 4. Selecting an order in Catalog updates Inspector + nested Audit Log Web Component
    catalogQ.getByRole("button", { name: "#102 Gemini" }).click();
    const currentItem = catalogQ.getByRole("button", {
      name: "#102 Gemini",
      current: "true",
    });
    const inspectorHeading = (
      await inspectorQ.findByRole("heading", { name: "Inspecting #102 Gemini", level: 2 })
    ).textContent;
    const nestedBadge = (await auditQ.findByText("Badge: #102 Gemini")).textContent;

    // 5. Submitting a note in Inspector updates Host status and nested Audit Log disclosure
    const noteInput = inspectorQ.getByRole<HTMLInputElement>("textbox", {
      name: "Inspector note",
      description: "Recorded in the shared audit log.",
    });
    noteInput.value = "Verified manifest";
    inspectorQ.getByRole("button", { name: "Save note" }).click();

    const hostSummary = await waitFor(() => {
      const el = shadowScreen.getByText("Last activity: #102 Gemini — Verified manifest");
      return el.textContent;
    });

    // Event history item is hidden inside closed <details> until expanded
    const hiddenInClosedDetails =
      auditQ.queryByRole("listitem") === null &&
      auditQ.queryByRole("button", { name: "Event history", expanded: false }) !== null;
    auditQ.getByRole("button", { name: "Event history", expanded: false }).click();
    const expandedHistoryItem = auditQ.getByRole("listitem").textContent;
    const summaryExpanded =
      auditQ.queryByRole("button", { name: "Event history", expanded: true }) !== null;

    // Hidden button inside Catalog remains excluded by default
    const hiddenCatalogExcluded =
      shadowScreen.queryByRole("button", { name: "Hidden catalog action" }) === null;

    return {
      h1: h1.textContent,
      h2s,
      h3: h3.textContent,
      totalResets,
      distinctResets,
      priorityPressed,
      currentItemText: currentItem.textContent,
      inspectorHeading,
      nestedBadge,
      hostSummary,
      hiddenInClosedDetails,
      expandedHistoryItem,
      summaryExpanded,
      hiddenCatalogExcluded,
    };
  }, fixture.origin);

  expect(flow).toEqual({
    h1: "Order Desk",
    h2s: ["Orders", "No order selected"],
    h3: "Activity log",
    totalResets: 2,
    distinctResets: true,
    priorityPressed: true,
    currentItemText: "#102 Gemini",
    inspectorHeading: "Inspecting #102 Gemini",
    nestedBadge: "Badge: #102 Gemini",
    hostSummary: "Last activity: #102 Gemini — Verified manifest",
    hiddenInClosedDetails: true,
    expandedHistoryItem: "#102 Gemini — Verified manifest",
    summaryExpanded: true,
    hiddenCatalogExcluded: true,
  });

  await auditWCAG(page);
  expect(await frameFailures(catalog)).toEqual([]);
  expect(await frameFailures(inspector)).toEqual([]);
});

test("keyboard Tab traversal crosses host, sibling frames, nested frame, and trailing host controls in order", async ({
  page,
}) => {
  await mountWorkspace(page);

  await page.getByRole("button", { name: "All orders" }).focus();
  const expectedSequence = [
    "Priority only",
    "Filter orders",
    "Filter options",
    "Reset",
    "#101 Apollo",
    "#102 Gemini",
    "#103 Mercury",
    "Inspector note",
    "Save note",
    "Reset",
    "Archive order",
    "Event history",
    "Help desk",
  ];

  const visited: string[] = [];
  for (let index = 0; index < expectedSequence.length; index += 1) {
    await page.keyboard.press("Tab");
    const activeLabel = await page.evaluate(async (origin) => {
      const { activeShadowElement } = (await import(
        `${origin}/dist/testing.js`
      )) as typeof TestingModule;
      const active = activeShadowElement();
      if (!active) return "<none>";
      if (active.tagName === "INPUT") {
        const root = Node.prototype.getRootNode.call(active) as Document | ShadowRoot;
        const label = root.querySelector(`label[for="${active.id}"]`);
        return label?.textContent?.trim() ?? active.id;
      }
      return active.textContent?.trim() ?? active.tagName;
    }, fixture.origin);
    visited.push(activeLabel);
  }
  expect(visited).toEqual(expectedSequence);

  // Shift+Tab steps back into the nested Audit Log <summary> across two shadow boundaries.
  await page.keyboard.press("Shift+Tab");
  const backLabel = await page.evaluate(async (origin) => {
    const { activeShadowElement } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    return activeShadowElement()?.textContent?.trim() ?? "";
  }, fixture.origin);
  expect(backLabel).toBe("Event history");
});

test("cross-fragment overlays light-dismiss across siblings, enforce modal inertness, and survive document replacement", async ({
  page,
}) => {
  await mountWorkspace(page);

  // 1. Auto popover in Catalog opens, passes WCAG, and light-dismisses on sibling Inspector click.
  await page.evaluate(async (origin) => {
    const { withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const catalog = withinFrame(document.querySelector<VFrameElement>("#catalog")!);
    catalog.getByRole("button", { name: "Filter options" }).click();
    catalog.getByRole("dialog", {
      name: "Filter options",
      description: "Narrow orders by priority status.",
    });
  }, fixture.origin);
  await auditWCAG(page);

  await page
    .locator("#inspector")
    .getByRole("textbox", { name: "Inspector note" })
    .click();
  const popoverDismissed = await page.evaluate(async (origin) => {
    const { withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const catalog = withinFrame(document.querySelector<VFrameElement>("#catalog")!);
    return catalog.queryByRole("dialog", { name: "Filter options" }) === null;
  }, fixture.origin);
  expect(popoverDismissed).toBe(true);

  // 2. Modal dialog in Inspector hides host & sibling roles (except with hidden: true) and passes WCAG.
  const modalState = await page.evaluate(async (origin) => {
    const { shadowScreen, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const catalog = withinFrame(document.querySelector<VFrameElement>("#catalog")!);
    const inspector = withinFrame(document.querySelector<VFrameElement>("#inspector")!);

    const archiveBtn = inspector.getByRole("button", { name: "Archive order" });
    archiveBtn.focus();
    archiveBtn.click();
    const dialogVisible =
      shadowScreen.queryByRole("dialog", {
        name: "Archive order",
        description: "Move this order into the read-only archive.",
      }) !== null;
    const hostInert = shadowScreen.queryByRole("button", { name: "Help desk" }) === null;
    const siblingInert = catalog.queryByRole("button", { name: "#101 Apollo" }) === null;
    const siblingFoundWhenHiddenTrue =
      catalog.queryByRole("button", { name: "#101 Apollo", hidden: true }) !== null;
    const confirmVisible =
      shadowScreen.queryByRole("button", { name: "Confirm archive" }) !== null;

    return {
      dialogVisible,
      hostInert,
      siblingInert,
      siblingFoundWhenHiddenTrue,
      confirmVisible,
    };
  }, fixture.origin);
  expect(modalState).toEqual({
    dialogVisible: true,
    hostInert: true,
    siblingInert: true,
    siblingFoundWhenHiddenTrue: true,
    confirmVisible: true,
  });
  await auditWCAG(page);

  // Escape closes the modal and restores focus to the trigger + restores sibling roles.
  await page.keyboard.press("Escape");
  const afterEscape = await page.evaluate(async (origin) => {
    const { activeShadowElement, shadowScreen, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const inspectorEl = document.querySelector<VFrameElement>("#inspector")!;
    const inspector = withinFrame(inspectorEl);
    const triggerFocused =
      activeShadowElement() === inspector.getByRole("button", { name: "Archive order" });
    const siblingRestored =
      shadowScreen.queryByRole("button", { name: "#101 Apollo" }) !== null;

    // 3. Full document replacement swaps inspector shadowRoot; existing withinFrame handle follows it.
    const previousRoot = inspectorEl.shadowRoot;
    inspectorEl.src = `${origin}/inspector/archived`;
    await inspector.ready();
    return {
      triggerFocused,
      siblingRestored,
      swapped: inspectorEl.shadowRoot !== previousRoot,
      archivedHeading: inspector.getByRole("heading", {
        name: "Order archived",
        level: 2,
      }).textContent,
      archivedStatus: inspector.getByRole("status").textContent,
    };
  }, fixture.origin);
  expect(afterEscape).toEqual({
    triggerFocused: true,
    siblingRestored: true,
    swapped: true,
    archivedHeading: "Order archived",
    archivedStatus: "This order is now read-only.",
  });
  await auditWCAG(page);
});

test("late-mounted fragments replay retained selection and resetChannels isolates reloaded fragments", async ({
  page,
}) => {
  await mountWorkspace(page);

  const outcome = await page.evaluate(async (origin) => {
    const { resetChannels, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;

    const catalog = withinFrame(document.querySelector<VFrameElement>("#catalog")!);
    catalog.getByRole("button", { name: "#103 Mercury" }).click();

    // Mount a brand-new inspector fragment after selection: should immediately replay #103 Mercury.
    const lateEl = document.createElement("v-frame") as VFrameElement;
    lateEl.id = "late-inspector";
    lateEl.src = `${origin}/inspector`;
    document.querySelector("#host")!.append(lateEl);

    const late = withinFrame(lateEl);
    await late.ready();
    const replayedHeading = (
      await late.findByRole("heading", { name: "Inspecting #103 Mercury", level: 2 })
    ).textContent;

    // Reset all retained channels and reload late-inspector: handle stays valid and shows clean state.
    resetChannels();
    await lateEl.reload();
    await late.ready();
    const cleanHeading = (
      await late.findByRole("heading", { name: "No order selected", level: 2 })
    ).textContent;

    return { replayedHeading, cleanHeading };
  }, fixture.origin);

  expect(outcome).toEqual({
    replayedHeading: "Inspecting #103 Mercury",
    cleanHeading: "No order selected",
  });
});
