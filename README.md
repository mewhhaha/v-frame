# v-frame

Render a trusted web application inside a host page, with its DOM and styles
contained in a shadow root and its JavaScript running with normal document,
history, and location APIs.

```html
<v-frame src="/applications/orders/"></v-frame>
```

The guest is an ordinary HTML document. It does not import a host SDK, emit a
special response format, or build against the shell. `v-frame` executes its
scripts in a hidden same-origin realm whose `Document`, `History`, `Location`,
CSSOM, and network APIs are virtualized, and renders the resulting nodes into
the host's shadow tree so they participate in host layout.

> [!IMPORTANT]
> `v-frame` runs trusted code. It is not a sandbox or a security boundary. The
> guest shares the host origin and can access same-origin capabilities.

## What you are trading

**Against an `<iframe>`.** There is no separate layout viewport. The guest
participates in host layout, inherits sizing, and its dialogs, popovers, and
tooltips are not clipped by a browsing-context boundary. The cost is the line
above: an iframe gives you a security boundary and `v-frame` does not. Use an
iframe for code you do not control.

**Against Module Federation, Web Fragments, or single-spa.** The guest needs
zero cooperation — no host SDK import, no shared module graph, no build
coupling, no response contract. The cost is that the runtime has to emulate a
document, and emulation is never total. The gaps are enumerated in
[Limitations](./docs/limitations.md); read that page before adopting.

**How large a guest.** Emulation is paid per node. Activation costs about
13.6 µs per element against 0.65–0.9 µs for putting the same markup straight into
the host page, so a 1,000-element guest activates in 37 ms, a 20,000-element one
in 359 ms, and a 50,000-element one in about 0.7 s; appending 1,000 rows to a
settled guest costs about 39 ms whatever its size. Firefox is dearer — roughly a
fifth more per element on activation and close to double per appended row — and
its retained heap cannot be measured at all (chromium 149 and firefox 151,
Ryzen 7 7800X3D, `pnpm bench`). That suits a guest whose live DOM stays in the
low thousands of elements — a form, a dashboard, a virtualized table — and does
not suit one that materializes tens of thousands of nodes at once, which pays a
visible fraction of a second on every activation and is better served by an
`<iframe>` and the browser's own parser. The full measurements, and what each
engine was measured for, are in [Guest size and activation
cost](./docs/limitations.md#guest-size-and-activation-cost).

## Requirements

- A current browser with custom elements, Declarative Shadow DOM, and the
  Navigation API. Chromium, Firefox and Playwright WebKit are tested, including
  touch-device emulation. Real Safari/iOS and screen-reader validation are a
  [manual release gate](./docs/releasing.md), not implied by WebKit passing.
- Guest URLs exposed to the browser must be same-origin `http:` or `https:`
  URLs. Proxy independently deployed applications through the host origin.
- The host must trust the guest JavaScript it executes.

## Install

```sh
pnpm add jsr:@mewhhaha/v-frame
```

With npm, run `npx jsr add @mewhhaha/v-frame` instead.

## Quickstart

Register the custom element once in the host application's browser entry:

```ts
import "@mewhhaha/v-frame/register";
```

Render an ordinary guest document and give the element a size, like any other
custom element:

```html
<v-frame src="/applications/orders/" aria-label="Orders"></v-frame>
```

```css
v-frame {
  display: block;
  width: 100%;
  min-height: 30rem;
}
```

The route at `src` returns a normal HTML document. It does not need special
headers, request detection, or middleware. Watch the element's lifecycle from
the host:

```ts
const frame = document.querySelector("v-frame");
if (frame === null) {
  throw new Error("host is missing its orders v-frame");
}

frame.addEventListener("v-frame-load", (event) => {
  console.log("orders ready", event.detail.url);
});

frame.addEventListener("v-frame-error", (event) => {
  console.error("orders failed", event.detail);
});
```

That is the whole client-only path. The recommended production path is
server-rendered adoption, where the host server materializes the guest document
into Declarative Shadow DOM so it paints in the first response and activates in
place without a second request — see [SSR](./docs/ssr.md).

## Documentation

| Page                                         | Contents                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| [Limitations](./docs/limitations.md)         | Every API that throws inside a guest, why, and the workaround.                 |
| [API reference](./docs/api.md)               | Attributes, properties, methods, events, custom states, CSP and Trusted Types. |
| [Navigation](./docs/navigation.md)           | Guest and host navigation modes, interception, and the imperative routing API. |
| [SSR](./docs/ssr.md)                         | Server-rendered adoption and the `@mewhhaha/v-frame/server` materializer.      |
| [Troubleshooting](./docs/troubleshooting.md) | Symptoms and their causes.                                                     |

## Examples

Both examples run from a fresh `pnpm install` at the repository root.

- [`examples/ssr`](./examples/ssr) — the flagship. A Cloudflare Workers host
  composes four independently built guests (React Router, Qwik, Angular,
  SolidStart) into server-rendered `v-frame` elements, with hydration,
  resumption, nested adopted frames, host-owned routing, and network reloads.

  ```sh
  pnpm --filter example-ssr dev
  ```

- [`examples/client`](./examples/client) — the client-only path. A React shell
  renders an independently built and independently served Solid application
  through `src`, including an overlay surface where Kobalte's tooltip, popover,
  and modal primitives run inside a deliberately clipped frame.

  ```sh
  pnpm --filter example-client dev
  ```

The overlay contracts that surface demonstrates — top-layer coordinate
translation, focus, and portal containment — are asserted by
[`tests/overlays.spec.ts`](./tests/overlays.spec.ts), which runs in Chromium and
Firefox on every push.

## License

MIT. See [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
