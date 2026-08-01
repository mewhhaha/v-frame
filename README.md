# v-frame

Render a trusted web application inside a host page, with its DOM and styles
contained in a shadow root and its JavaScript running with normal document,
history, and location APIs.

`v-frame` supports two ways to start an application:

| Mode | Use it when | Initial HTML request |
| --- | --- | --- |
| Document | The browser should load the guest application after the host starts. | Fetches `src`. |
| Server-rendered adoption | The host server already rendered the guest into its HTML response. | Does not fetch `src`. |

Server-rendered adoption is the recommended path when the guest should be
visible in the first response and hydrate in place.

> [!IMPORTANT]
> `v-frame` runs trusted code. It is not a sandbox or a security boundary. The
> guest shares the host origin and can access same-origin capabilities.

## Requirements

- A current browser with custom elements, Declarative Shadow DOM, and the
  Navigation API. Chromium and Firefox are tested. Safari 26.2+ is best effort.
- Guest URLs exposed to the browser must be same-origin `http:` or `https:`
  URLs. Proxy independently deployed applications through the host origin.
- The host must trust the guest JavaScript it executes.

## Install

```sh
npm install v-frame
```

Register the custom element once in the host application's browser entry:

```ts
import "v-frame/register";
```

You can now render an ordinary guest document:

```html
<v-frame src="/applications/orders/"></v-frame>
```

Give the element a size like any other custom element:

```css
v-frame {
  display: block;
  width: 100%;
  min-height: 30rem;
}
```

The route at `src` returns a normal HTML document. It does not need special
headers, request detection, middleware, or a `v-frame` server package.

## Render a guest with SSR

SSR has two participants with a clean boundary:

1. The guest server returns its ordinary HTML document.
2. The host server materializes that document and places it inside an adopting
   `<v-frame>`.

The browser displays the Declarative Shadow DOM immediately. When
`v-frame/register` loads, the element starts the guest's scripts and replaces
the preview with the activated tree in one synchronous handoff. It does not
refetch the entry document.

### 1. Return a normal guest document

The guest does not need a `v-frame` response format. Render the same document
used when the application runs standalone or loads through `src`:

```tsx
import { renderToString } from "react-dom/server";
import { OrdersApp } from "./OrdersApp.js";

export function renderOrdersDocument(): string {
  const applicationMarkup = renderToString(<OrdersApp />);

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <style>
          :root { color-scheme: light; }
          html, body { margin: 0; }
          .orders-app { color: #18181b; }
        </style>
      </head>
      <body>
        <div id="orders-root">${applicationMarkup}</div>
        <script type="module" src="/applications/orders/client.js"></script>
      </body>
    </html>
  `;
}
```

There is no separate preview contract: ordinary document selectors, executable
scripts, framework metadata, and document structure are all allowed.

### 2. Materialize at the host boundary

Before inserting the guest response into the host page, the host transforms
the trusted document:

- `html`, `head`, and `body` become `v-html`, `v-head`, and `v-body`.
- Inline stylesheet selectors, imports, and URLs are rewritten for the guest's
  public URL.
- Scripts become parser-inert while preserving their original type.
- The materialized document receives its required display rules.

`v-frame/server` ships this transformation. On Cloudflare Workers,
`materializeVFrameDocument` streams it through `HTMLRewriter`; it accepts a
normal `Response` and the public guest URL:

```ts
import { materializeVFrameDocument } from "v-frame/server";

const guestURL = new URL("/applications/orders/", request.url);
const guestResponse = await ordersService.fetch(
  new Request("https://orders.internal/document"),
);

if (!guestResponse.ok) {
  throw new Error(
    `orders SSR returned ${guestResponse.status} for ${guestURL.href}`,
  );
}

const materializedResponse = materializeVFrameDocument(
  guestResponse,
  guestURL.href,
);
```

Server HTML transformation APIs differ between runtimes, so only the
`HTMLRewriter` adapter is runtime-specific. A host on another runtime drives the
same decisions — `rewriteShellElement`, `rewriteScriptElement`, and
`materializeStylesheet`, all exported from `v-frame/server` — from a
standards-compliant streaming HTML parser. Do not transform HTML with regular
expressions.

For first-paint fidelity, the adapter expects critical CSS to be
inline and markup asset URLs to be root-relative or absolute. Linked
stylesheets and relative markup URLs work after activation, but need additional
host-side rebasing to be correct in the inert server preview.

### 3. Compose the host response

Insert the transformed response into Declarative Shadow DOM. The HTML sent to
the browser has this shape:

```html
<v-frame adopt src="/applications/orders/" aria-label="Orders">
  <template shadowrootmode="open">
    <v-html lang="en">
      <v-head>
        <style>
          v-html, v-body { display: block; }
          v-head { display: none; }
          .orders-app { color: #18181b; }
        </style>
      </v-head>
      <v-body>
        <div id="orders-root"><!-- guest SSR output --></div>
        <script
          type="application/vnd.v-frame"
          data-v-frame-script
          data-v-frame-type="module"
          src="/applications/orders/client.js"
        ></script>
      </v-body>
    </v-html>
  </template>
</v-frame>
```

The host owns this wrapper; the guest does not produce it. Treat the transformed
document as executable application content and only compose responses from a
trusted guest service.

The host page also loads the registration entry:

```ts
import "v-frame/register";
```

Declarative Shadow DOM renders before that module finishes loading, so the
server preview remains useful even when the browser bundle is deferred.

### 4. Hydrate or resume normally

The guest browser bundle uses its framework's normal client entry. It can query
the guest document as if it were a regular page:

```tsx
import { hydrateRoot } from "react-dom/client";
import { OrdersApp } from "./OrdersApp.js";

const root = document.getElementById("orders-root");
if (root === null) {
  throw new Error("orders guest is missing #orders-root");
}

hydrateRoot(root, <OrdersApp />);
```

React can hydrate, Qwik can resume, and other frameworks can use their normal
browser startup as long as the client renders the same markup the guest server
placed in the preview.

### 5. Use the same document for `src`

Even adopted frames need `src`. It supplies the guest's URL and base URL during
activation. It is also used by later network loads.

The same ordinary document can serve both host composition and the public
`src` route. The initial adopted activation does not request `src`; reloads,
reconnection, source changes, and guest document navigation use it normally.

The public URL must be same-origin. The host may call the guest through an
internal service address for SSR, but it must give the materializer the public
`src` URL so CSS and assets resolve correctly.

### 6. Verify SSR adoption

Listen for lifecycle events in the host:

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

In the browser's network panel, the first activation should not request the URL
in `src`. External guest scripts, stylesheets, images, and API calls still load
normally.

Adoption is consumed once. Calling `reload()`, reconnecting the element, or
changing `src` performs a normal network load.

## Navigation

Guest navigation is independent by default:

```html
<v-frame src="/applications/orders/"></v-frame>
```

Links, GET forms, `window.open(..., "_self")`, History methods, and Location
changes stay inside the frame. The guest sees its own URL through
`location.href`, `document.URL`, and the History API. A guest SPA can use the
Navigation API normally:

```ts
navigation.addEventListener("navigate", (event) => {
  if (!event.canIntercept) return;

  event.intercept({
    handler: () => renderRoute(event.destination.url),
  });
});
```

Use host navigation only when the shell deliberately owns the guest's route:

```html
<v-frame
  adopt
  navigation="host"
  src="/applications/orders/"
>
  <template shadowrootmode="open"><!-- materialized preview --></template>
</v-frame>
```

In host mode, guest history follows shell history and document navigation is
promoted to the host page.

The host can cancel link, form, fragment, and window navigation:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  const destination = new URL(event.detail.to);
  if (destination.origin !== location.origin) {
    event.preventDefault();
  }
});
```

## Configuration

| Attribute or property | Default | Purpose |
| --- | --- | --- |
| `src` | None | Same-origin guest document URL. An empty or missing value keeps the frame idle. |
| `adopt` | `false` | Activates initial Declarative Shadow DOM instead of fetching `src`. |
| `navigation` | `"guest"` | Use `"host"` when the shell owns guest navigation. |
| `credentials` | `"same-origin"` | Entry and stylesheet fetch mode: `"omit"`, `"same-origin"`, or `"include"`. |
| `nonce` | `""` | CSP nonce applied to executed scripts and generated styles. |
| `trusted-types-policy` | None | Name of an identity Trusted Types policy allowed by the host CSP. |

Readonly element properties:

| Property | Value |
| --- | --- |
| `status` | `"idle"`, `"loading"`, `"ready"`, or `"error"`. |
| `currentURL` | Current guest URL, or `null` without an active guest. |
| `contentWindow` | Guest `Window`, or `null` before creation and after teardown. |

Reload the current guest document with:

```ts
await frame.reload();
```

The current content remains visible until its replacement is ready. A failed
reload restores the current guest and emits a nonfatal error.

Each status is also available as a custom-element state:

```css
v-frame:state(loading) {
  cursor: progress;
}

v-frame:state(error) {
  outline: 2px solid firebrick;
}
```

## Events

All events bubble through the host DOM and are composed.

| Event | Detail |
| --- | --- |
| `v-frame-loadstart` | `{ url }` for the selected entry URL. |
| `v-frame-load` | `{ url }` when the guest is ready. |
| `v-frame-error` | `{ phase, url, error, fatal }`. |
| `v-frame-navigate` | `{ from, to, kind, state }`; cancelable for default link, form, fragment, and window actions. |

Error phases are `entry`, `bootstrap`, `stylesheet`, `script`, `runtime`,
`navigation`, and `network`. A fatal error ends the current load. Nonfatal
script, stylesheet, runtime, network, or replacement-load errors are reported
without discarding a working guest.

## CSP and Trusted Types

Guest execution inherits the host page's Content Security Policy. The fetched
guest document's CSP and framing headers are not applied as a separate policy.
Set `nonce` when the host requires one:

```html
<v-frame nonce="server-generated-nonce" src="/applications/orders/"></v-frame>
```

When the host enforces Trusted Types, allow a policy name in its CSP and put
that name on the frame:

```html
<v-frame
  trusted-types-policy="orders-frame"
  src="/applications/orders/"
></v-frame>
```

For example, the host policy can include:

```text
trusted-types orders-frame; require-trusted-types-for 'script'
```

The named policy is an identity policy intended for a guest already trusted to
execute. Consumers that need validation or transformation can assign a full
`trustedTypesPolicy` definition through JavaScript instead.

## SSR troubleshooting

### The preview is visible but never becomes interactive

Confirm that the host imports `v-frame/register` and that the host materializer
preserved the guest scripts as `data-v-frame-script` elements with parser-time
type `application/vnd.v-frame`.

### The guest script ran in the host page

The host inserted the ordinary guest response directly into Declarative Shadow
DOM. Run it through the materializer before composition; the guest should keep
returning its normal executable scripts.

### Adoption falls back to a network request

The frame must have `adopt`, and the materialized Declarative Shadow DOM must
contain one `v-html` with direct `v-head` and `v-body` children. Adoption is
available only on the first connection.

### Reload returns 404

`src` still needs to serve an ordinary guest document even though the initial
SSR activation does not request it.

### Styles differ after activation

Confirm that the host materializer rewrites document selectors and that server
and client rendering produce the same application markup. The guest stylesheet
should continue using normal document selectors.

### Relative assets resolve against the wrong application

Pass the public `src` URL—not an internal service URL—to the materializer. It
uses that URL when rebasing stylesheet resources. The experimental adapter does
not yet rebase markup attributes, so use root-relative or absolute asset URLs in
the server preview.

### Form input, focus, or scroll changes disappear during activation

The live guest is prepared separately and then swapped with the preview.
Changes a user makes to the inert server preview before activation are not
preserved. Load the registration bundle early when that interval matters.

## Complete SSR example

The repository includes a working server-composed example with React Router,
Qwik, Angular, SolidStart, nested adopted frames, hydration, routing, and
network reloads:

```sh
pnpm install
pnpm --filter example-ssr run dev
```

See [`examples/ssr`](./examples/ssr) for the ordinary guest document endpoints,
Cloudflare materializer, and host composition code.
