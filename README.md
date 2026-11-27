# v-frame

Render a trusted web application inside a host page—with its DOM and styles
contained in an open shadow root, its JavaScript running with normal `document`,
`history`, and `location` APIs, and zero host SDK required in the guest.

```html
<v-frame src="/applications/orders/" aria-label="Orders"></v-frame>
```

- **Zero guest cooperation:** Any ordinary HTML document (React, Qwik, Angular,
  Solid, or plain HTML) works as-is—no host SDK import, shared bundler, or
  special response contract.
- **Real host layout:** Renders into an open Shadow DOM instead of an `<iframe>`
  viewport box, so sizing, scrolling, native popovers, modals, and accessibility
  participate directly in the host page.
- **Scoped JS, CSS, and routing:** Guest scripts run in a hidden same-origin
  realm with virtualized `Document`, `History`, `Location`, CSSOM
  (including `document.adoptedStyleSheets`), same-origin `GET`/`POST` forms,
  and base-URL-aware networking. Guest styles stay scoped to the shadow tree,
  and the browser runtime is ~83 KB gzipped with zero runtime dependencies.

Try the live demo: **[Contact Sheet](https://contact-sheet.jactor.dev/)** — an
Apollo 11 photo desk composing three independently deployed sites on one page
(turn on **Show site boundaries** to inspect the fragments, or click any
dashed-underline mission term to lazily load a glossary `<v-frame>` popover).

> [!IMPORTANT]
> `v-frame` runs trusted code. It is **not** a sandbox or a security boundary.
> Guests share the host origin and can access same-origin capabilities. Use a
> sandboxed `<iframe>` for third-party or untrusted code.

## Install

```sh
# pnpm
pnpm add jsr:@mewhhaha/v-frame

# npm
npx jsr add @mewhhaha/v-frame

# deno
deno add jsr:@mewhhaha/v-frame
```

## Quickstart

### 1. Register `<v-frame>` once in your host browser entry

```ts
import "@mewhhaha/v-frame/register";
```

### 2. Mount any same-origin HTML route and give it a size

```html
<v-frame id="orders" src="/applications/orders/" aria-label="Orders"></v-frame>
```

```css
v-frame {
  display: block;
  width: 100%;
  min-height: 30rem;
}

/* Built-in CustomStateSet states: idle, loading, ready, error */
v-frame:state(loading) {
  opacity: 0.6;
}
```

The route at `src` returns a normal HTML document—no special headers, request
detection, or middleware. If the guest app is deployed separately, proxy it
under a same-origin path on the host (for example `/applications/orders/*` via
Vite, Nginx, or a Cloudflare Worker).

### 3. Wait for readiness or listen to lifecycle events

```ts
import { VFrameElement } from "@mewhhaha/v-frame";

const frame = document.querySelector("#orders");
if (!(frame instanceof VFrameElement)) {
  throw new Error("host is missing its orders v-frame");
}

frame.addEventListener("v-frame-load", (event) => {
  console.log("orders ready:", event.detail.url);
});

frame.addEventListener("v-frame-error", (event) => {
  console.error("orders failed:", event.detail.phase, event.detail.error);
});

// Or await readiness directly (rejects on fatal load error or disconnect)
await frame.whenReady();
```

> [!NOTE]
> The package does not augment `HTMLElementTagNameMap` (JSR forbids global
> augmentation), which is why the snippet narrows with `instanceof`. See
> [Typing the element](./docs/api.md#typing-the-element) for the one-line global
> declaration to add in your host app.

## Entrypoints

| Import                       | What it provides                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `@mewhhaha/v-frame/register` | Defines `<v-frame>` in `customElements`; safe no-op during SSR.                                   |
| `@mewhhaha/v-frame`          | `VFrameElement`, `defineVFrame()`, `VFrameStatus`, and event/option types.                        |
| `@mewhhaha/v-frame/channel`  | `channel<T>(name)` for typed, page-scoped messaging between host and fragments.                   |
| `@mewhhaha/v-frame/server`   | `composeFrames()` for server-rendered first paint (Declarative Shadow DOM) + low-level helpers.   |
| `@mewhhaha/v-frame/testing`  | Zero-dependency shadow-piercing Testing Library queries, `resetChannels()`, `defineMockVFrame()`. |

## Examples

### Server-rendered first paint (SSR composition)

Keep the exact same `<v-frame src="...">` markup in your shell HTML and run the
shell `Response` through `composeFrames()` on the server. Each guest is fetched,
rewritten into Declarative Shadow DOM, and streamed with the shell—so users see
styled guest content before JavaScript boots, and an unavailable guest never
blocks healthy siblings.

```ts
import { composeFrames } from "@mewhhaha/v-frame/server";

export default {
  async fetch(request: Request): Promise<Response> {
    const shellResponse = await renderShell(request);

    return composeFrames(shellResponse, {
      request,
      fetchGuest: (guestRequest) => routeToTeamService(guestRequest),
      timeoutMs: 3000,
      onSlotError: ({ src, error }) => {
        console.warn("guest fallback to client load:", src, error);
      },
    });
  },
};
```

Nested guests can call `composeFrames()` the same way on their own responses.
See [SSR and server composition](./docs/ssr.md#compose-the-shell-response).

### Communicate between fragments

Use `@mewhhaha/v-frame/channel` to share events or retained state across
independently bundled fragments on the same page. Payloads are structured-cloned
and isolated to the current page/tab.

```ts
import { channel } from "@mewhhaha/v-frame/channel";

const selectedOrder = channel<{ id: string }>("orders.selected.v1");

// Orders fragment: publish and retain the latest selection
selectedOrder.publish({ id: "A42" }, { retain: true });

// Details fragment: late-mounted or reloaded guests receive the retained snapshot immediately
const controller = new AbortController();
selectedOrder.subscribe(({ id }) => renderOrderDetails(id), {
  signal: controller.signal,
});

// Inspect or clear retained state directly
const current = selectedOrder.get(); // { id: "A42" }
selectedOrder.clear();
```

Use `publish(value)` (without `{ retain: true }`) for one-time events. See
[Fragment communication](./docs/api.md#communicate-between-fragments).

### Lazy click-to-load popover fragment

Because `<v-frame>` renders inside the host document, a native top-layer
`popover="auto"` breaks cleanly out of clipped containers (`overflow: hidden`)
and can mount a `<v-frame>` on demand—fetching zero bytes until the user clicks
a term, and letting links inside the popover navigate in-place without changing
the host URL.

```html
<p>
  Wrap the legacy API in a measured
  <button type="button" class="term" data-term="compatibility-layer">
    compatibility layer</button
  >.
</p>

<div id="explainer" popover="auto" role="dialog" aria-label="Term explanation">
  <v-frame id="explainer-frame" aria-label="Concept explainer"></v-frame>
</div>
```

```css
.term {
  padding: 0;
  border: 0;
  border-bottom: 1.5px dashed currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
```

```ts
import { VFrameElement } from "@mewhhaha/v-frame";

const popover = document.querySelector<HTMLElement>("#explainer")!;
const frame = document.querySelector("#explainer-frame");

document.addEventListener("click", (event) => {
  const trigger = (event.target as Element | null)?.closest<HTMLButtonElement>(
    "[data-term]",
  );
  if (!trigger || !(frame instanceof VFrameElement)) return;

  frame.src = `/widgets/explainer?term=${encodeURIComponent(trigger.dataset.term!)}`;
  popover.showPopover();
});
```

See this pattern running live in **[Contact Sheet](https://contact-sheet.jactor.dev/)**
(click any dashed-underline Apollo 11 term in the photo captions or flight log)
and end-to-end with keyboard focus restoration, related concept navigation, and
WCAG audits in [`examples/ssr`](./examples/ssr).

### Coordinate routing between shell and guests

By default (`navigation="guest"`), guest links, `history.pushState`, and
`location` stay scoped inside the `<v-frame>`. The host can steer a guest
without reloading its document and react when a guest navigates itself:

```ts
import { VFrameElement } from "@mewhhaha/v-frame";

const frame = document.querySelector("#orders");
if (frame instanceof VFrameElement) {
  // Move the live guest to another route (guest receives popstate, no reload)
  await frame.navigate("/applications/orders/42", { replace: true });

  // Follow guest-initiated navigations in the host shell
  frame.addEventListener("v-frame-navigated", (event) => {
    console.log("guest moved:", event.detail.from, "->", event.detail.to);
  });
}
```

Set `<v-frame navigation="host" ...>` when the shell owns top-level URLs and
history. See [Navigation](./docs/navigation.md).

### Test across fragments (zero extra dependencies)

Standard `@testing-library/dom` queries stop at shadow boundaries.
`@mewhhaha/v-frame/testing` provides zero-dependency shadow-piercing Testing
Library–style queries, cross-shadow focus inspection, channel cleanup, and a
mock `<v-frame>` for jsdom/happy-dom shell unit tests:

```ts
import {
  activeShadowElement,
  resetChannels,
  shadowScreen,
  withinFrame,
} from "@mewhhaha/v-frame/testing";
import type { VFrameElement } from "@mewhhaha/v-frame";

afterEach(() => {
  resetChannels();
});

test("selecting an order updates the details fragment", async () => {
  const orders = withinFrame(document.querySelector<VFrameElement>("#orders")!);
  const details = withinFrame(document.querySelector<VFrameElement>("#details")!);
  await Promise.all([orders.ready(), details.ready()]);

  // Pierce host + sibling frames + nested frames + guest Web Components
  shadowScreen.getByRole("heading", { name: "Order Desk", level: 1 });

  // Scope when sibling fragments share button names
  orders.getByRole("button", { name: "Order #42" }).click();
  await details.findByRole("heading", { name: "Order #42" });

  // Inspect deepest focused element across shadow boundaries
  expect(activeShadowElement()).toBe(orders.getByRole("button", { name: "Order #42" }));
});
```

In jsdom or happy-dom shell unit tests, swap `<v-frame>` with
`defineMockVFrame({ "/applications/orders/": "<h2>Orders</h2>" })`. See
[Testing composed applications](./docs/testing.md).

## Trade-offs & when to use `v-frame`

**Against an `<iframe>`.** There is no separate layout viewport: the guest
participates in host layout, inherits sizing, and its dialogs, popovers, and
tooltips escape clipping boundaries. The trade-off is security—an `<iframe>` is
a security boundary and `v-frame` is not. Use an `<iframe>` for code you do not
control.

**Against Module Federation, Web Fragments, or single-spa.** Guests need zero
cooperation—no host SDK import, no shared module graph, no build coupling, and
no response contract. The trade-off is that DOM/browser emulation is never
total; read [Limitations](./docs/limitations.md) before adopting.

**Guest DOM size.** Emulation is paid per node. Default activation costs about
4.8 µs per element against 0.57 µs for putting the same markup straight into the
host page, so a 1,000-element guest activates in ~36 ms, a 20,000-element one in
~129 ms, and a 50,000-element one in ~0.27 s (or ~95 ms through first geometry
with opt-in `lazy-attributes`, `lazy-events`, and `content-visibility="auto"`);
appending 1,000 rows to a settled guest costs about 7–8 ms default (~6 ms with
`lazy-attributes` + `lazy-events`) whatever its size (Chromium 153, Ryzen 7
7800X3D, `pnpm bench`). Firefox is somewhat dearer on insertion (~18 ms default,
~12 ms lazy) and its retained heap cannot be measured. That suits guests whose
live DOM stays in the low thousands of elements (forms, dashboards, virtualized
tables) and does not suit pages materializing tens of thousands of nodes at
once, which are better served by an `<iframe>`. Full measurements are in
[Guest size and activation cost](./docs/limitations.md#guest-size-and-activation-cost).

## Requirements

- **Modern browser baseline:** Custom elements, Declarative Shadow DOM, and the
  Navigation API. Chromium, Firefox, and Playwright WebKit are tested in CI,
  including touch-device emulation. Real Safari/iOS and screen-reader validation
  are a [manual release gate](./docs/releasing.md), not implied by WebKit
  passing.
- **Same-origin URLs:** Guest URLs exposed to the browser must be same-origin
  `http:` or `https:` URLs (proxy independently deployed services through the
  host origin).
- **Trusted code:** The host must trust all guest JavaScript it executes.

## Demo & local examples

- **[Contact Sheet](https://contact-sheet.jactor.dev/)** — live production demo
  composing three independently deployed websites (photo archive, flight log,
  and notebook) plus lazy click-to-load glossary popovers.
- **[`examples/ssr`](./examples/ssr)** — flagship local example. A Cloudflare
  Workers host composes four independently built guests (React Router, Qwik,
  Angular, and SolidStart) with SSR Declarative Shadow DOM adoption, hydration,
  resumption, nested adopted frames, click-to-load Qwik term explainer popovers,
  host-owned routing, and WCAG checks:

  ```sh
  pnpm install
  pnpm --filter example-ssr dev
  ```

- **[`examples/client`](./examples/client)** — client-only example. A React
  shell mounts an independently built Solid app via `src`, including Kobalte
  tooltips, popovers, and modals inside a clipped frame:

  ```sh
  pnpm install
  pnpm --filter example-client dev
  ```

The overlay contracts demonstrated in `examples/client`—top-layer coordinate
translation, focus, and portal containment—are asserted by
[`tests/overlays.spec.ts`](./tests/overlays.spec.ts) on every push.

## Documentation

| Page                                         | Contents                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| [API reference](./docs/api.md)               | Attributes, properties, methods, events, custom states, CSP and Trusted Types. |
| [SSR](./docs/ssr.md)                         | Server-rendered adoption and the `@mewhhaha/v-frame/server` materializer.      |
| [Navigation](./docs/navigation.md)           | Guest and host navigation modes, interception, and the imperative routing API. |
| [Testing](./docs/testing.md)                 | Cross-app testing with `@mewhhaha/v-frame/testing`, Playwright, and jsdom.     |
| [Limitations](./docs/limitations.md)         | Every API that throws inside a guest, why, and the workaround.                 |
| [Troubleshooting](./docs/troubleshooting.md) | Symptoms and their causes.                                                     |

## License

MIT. See [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
