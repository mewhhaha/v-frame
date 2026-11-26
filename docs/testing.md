# Testing composed applications

A host page that composes multiple `<v-frame>` guests renders each guest inside an
open `ShadowRoot` backed by a real browser execution realm. Because each guest is
just an ordinary HTML document, you can test applications at three levels:

1. **Each guest app in isolation** — run your team's existing test setup (Vitest,
   Jest, Testing Library, Playwright) against the guest directly, without `v-frame`.
2. **Composed cross-app tests in a real browser** — Playwright, or browser-based
   component runners (Vitest Browser Mode, Web Test Runner) using the built-in,
   zero-dependency `@mewhhaha/v-frame/testing` shadow-piercing queries.
3. **Fast host shell unit tests in jsdom / happy-dom** — swap `<v-frame>` with
   `defineMockVFrame()` from `@mewhhaha/v-frame/testing`.

## Testing Library–style queries across `<v-frame>` (`@mewhhaha/v-frame/testing`)

Standard `@testing-library/dom` queries (`screen.getByRole`, `getByText`, etc.) do
not pierce shadow DOM boundaries, so they cannot see inside `<v-frame>` guests.
`@mewhhaha/v-frame/testing` ships a zero-dependency shadow-piercing query adapter
that traverses the host document, `<v-frame>` guests, nested `<v-frame>`s, and
guest Web Component shadow roots while skipping `<v-head>` metadata and hidden
staging buffers.

```ts
import { resetChannels, shadowScreen, withinFrame } from "@mewhhaha/v-frame/testing";
import type { VFrameElement } from "@mewhhaha/v-frame";

afterEach(() => {
  resetChannels();
});

test("selecting an order in one frame updates the details frame", async () => {
  const ordersFrame = document.querySelector<VFrameElement>("#orders")!;
  const detailsFrame = document.querySelector<VFrameElement>("#details")!;

  const orders = withinFrame(ordersFrame);
  const details = withinFrame(detailsFrame);
  await Promise.all([orders.ready(), details.ready()]);

  // Query across the whole composed page (host + every frame + nested shadow roots):
  shadowScreen.getByRole("heading", { name: "Shell Workspace", level: 1 });

  // Scope queries to a specific frame when siblings share similar controls:
  orders.getByRole("button", { name: "Save" }).click();

  // Wait for another frame to react (e.g. via @mewhhaha/v-frame/channel):
  await details.findByText("Selected #42");
});
```

### Supported query families

Both `shadowScreen`, `withinShadow(root)`, and `withinFrame(frame)` expose the full
Testing Library query matrix (`queryBy*`, `queryAllBy*`, `getBy*`, `getAllBy*`,
`findBy*`, `findAllBy*`):

- `*ByRole(role, options?)` — supports `name`, `description`, `hidden`, `level`,
  `checked`, `pressed`, `selected`, `expanded`, `current`, and `busy`, resolving
  `aria-labelledby` and `<label for>` within each shadow root.
- `*ByLabelText(text, options?)`
- `*ByPlaceholderText(text, options?)`
- `*ByText(text, options?)` — ignores `<v-head>`, `<style>`, `<script>`, and
  matches deepest elements so inline formatting (`<p>Order <strong>#42</strong></p>`)
  works cleanly.
- `*ByDisplayValue(value, options?)`
- `*ByAltText(text, options?)`
- `*ByTitle(title, options?)`
- `*ByTestId(id, options?)` — defaults to `data-testid`; override via
  `withinShadow(root, { testIdAttribute: "data-test" })`.
- `queryShadow(selector)` / `queryAllShadow(selector)` — shadow-piercing CSS
  selectors (also exported as standalone functions `queryShadow(root, selector)`
  and `queryAllShadow(root, selector)`).

### Handles stay valid across navigations

`v-frame` swaps its visible `shadowRoot` when a guest reloads or navigates to a new
document. `withinFrame(frame)` resolves `frame.shadowRoot` lazily on every query,
so an existing `withinFrame(frame)` handle keeps working after `frame.src` changes,
guest document navigations, or `frame.reload()`.

When a `getBy*` query fails or finds multiple matches, the error includes a
`prettyShadowDOM()` tree dump with expanded `#shadow-root (open)` sections so you
can see what each frame rendered.

### Clearing channel state between tests

Retained `@mewhhaha/v-frame/channel` values live on the host document until page
unload. Call `resetChannels()` in `afterEach` to clear all retained topics without
needing to import every topic name:

```ts
import { resetChannels } from "@mewhhaha/v-frame/testing";

afterEach(() => {
  // Clears retained values across all topics:
  resetChannels();

  // Or also detach subscribers from earlier tests in a single-page test runner:
  resetChannels({ disconnectSubscribers: true });
});
```

## End-to-end tests with Playwright

Playwright's built-in locators (`getByRole`, `getByLabel`, `getByText`,
`getByTestId`, CSS selectors) automatically pierce open shadow roots, so
cross-application flows work out of the box with no extra adapter:

```ts
import { expect, test } from "@playwright/test";

test("orders and details frames communicate", async ({ page }) => {
  await page.goto("/");

  // Scope inside a specific guest frame:
  const orders = page.locator('v-frame[src^="/applications/orders"]');
  const details = page.locator('v-frame[src^="/applications/details"]');

  await orders.getByRole("button", { name: "Order #42" }).click();
  await expect(details.getByRole("heading", { name: "Order #42" })).toBeVisible();
});
```

Wait for a frame to settle using `frame.whenReady()` (or poll `frame.status === "ready"`)
rather than guessing with fixed timeouts.

## Unit-testing the host shell in jsdom or happy-dom

A real `<v-frame>` requires a browser engine with Declarative Shadow DOM, custom
element states, live same-origin `<iframe>` realms, and the Navigation API, so it
cannot execute real guest apps inside jsdom or happy-dom.

To test host shell wiring (attributes, lifecycle events, navigation, error states,
and layout) in a fast unit test, register the built-in mock element with
`defineMockVFrame()`:

```ts
import {
  defineMockVFrame,
  resetChannels,
  shadowScreen,
  withinFrame,
} from "@mewhhaha/v-frame/testing";
import type { VFrameElement } from "@mewhhaha/v-frame";

let mock: ReturnType<typeof defineMockVFrame>;

beforeEach(() => {
  mock = defineMockVFrame({
    "/applications/orders/": `
      <h2>Orders</h2>
      <button type="button">Create order</button>
    `,
    "/applications/orders/42": () => ({
      html: `<h2>Order #42</h2>`,
    }),
  });
});

afterEach(() => {
  mock.restore();
  resetChannels({ disconnectSubscribers: true });
});

test("shell mounts and navigates orders frame", async () => {
  const frame = document.createElement("v-frame") as VFrameElement;
  frame.src = "/applications/orders/";
  document.body.append(frame);

  const orders = withinFrame(frame);
  await orders.ready();
  expect(shadowScreen.getByRole("heading", { name: "Orders" })).toBeTruthy();

  await frame.navigate("/applications/orders/42");
  expect(orders.getByRole("heading", { name: "Order #42" })).toBeTruthy();
  expect(mock.requests).toHaveLength(2);
});
```

`defineMockVFrame(routes, options)` renders into an open `ShadowRoot` by default so
the same `shadowScreen` / `withinFrame` queries work identically in jsdom and real
browsers. Pass `{ renderMode: "light" }` if you prefer rendering directly into light
DOM for existing `@testing-library/dom` suites.

Because `customElements.define()` only accepts one registration per tag name per
realm, calling `defineMockVFrame()` again in later tests updates the active route
table and `mock.restore()` restores the previous configuration.

## API summary

| Export                                | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `shadowScreen`                        | Page-wide shadow-piercing Testing Library queries (lazy `document` lookup; safe to import in SSR). |
| `withinShadow(root, options?)`        | Scoped shadow-piercing Testing Library queries for any element, `ShadowRoot`, or lazy resolver.    |
| `withinFrame(frame, options?)`        | Frame-scoped queries that re-resolve `frame.shadowRoot` across navigations, plus `ready()`.        |
| `queryShadow(root, selector)`         | First matching element across open shadow boundaries.                                              |
| `queryAllShadow(root, selector)`      | All matching elements across open shadow boundaries.                                               |
| `activeShadowElement(root?)`          | Deepest focused element across open shadow roots (for keyboard and focus-restoration tests).       |
| `waitFor(callback, options?)`         | Retries `callback` via `MutationObserver` + polling interval until it succeeds or times out.       |
| `prettyShadowDOM(root?, maxLength?)`  | Formats DOM trees with expanded `#shadow-root (open)` markers for readable failure output.         |
| `resetChannels(targetOrOptions?)`     | Clears retained `@mewhhaha/v-frame/channel` values (and optionally detaches leaked subscribers).   |
| `defineMockVFrame(routes?, options?)` | Registers a lightweight mock `<v-frame>` custom element for jsdom/happy-dom host shell unit tests. |
