# v-frame

`v-frame` is a TypeScript ESM custom element that loads an HTTP(S) document,
reconstructs it in an open shadow root, and runs its scripts in a disposable,
same-origin iframe realm. Documents can be fetched by the browser or adopted
from server-rendered Declarative Shadow DOM. It is for rendering and running
**trusted** pages in a host application; it is not an isolation or sandboxing
mechanism.

## Install and register

```sh
pnpm add v-frame
```

Importing `v-frame` has no custom-element registration side effect. Register
the element explicitly:

```ts
import { defineVFrame, type VFrameElement } from "v-frame";

defineVFrame();
```

`defineVFrame()` returns `VFrameElement`. It is safe to call more than once
when this package owns the existing `v-frame` registration. It throws if a
different constructor already owns that tag.

## Use

```html
<v-frame
  src="https://example.test/application.html"
  credentials="same-origin"
  nonce="host-csp-nonce"
></v-frame>
```

`src` is resolved against the host document's base URL and must resolve to an
`http:` or `https:` URL. Setting or changing `src` on a connected element
starts a load. An invalid URL or unsupported protocol produces a fatal
`v-frame-error` with phase `entry`.

A same-origin `src` is the high-fidelity deployment. A controlled cross-origin
source can be loaded through CORS, but its scripts still execute in a
host-origin realm. Treat that mode as reduced compatibility and test code that
reads `location`, selects storage, or constructs service-worker and API URLs.

`credentials` controls entry and stylesheet fetches and supplies the default
credential option to patched network APIs where the browser exposes one. Its
accepted values are `"omit"`, `"same-origin"`, and `"include"`; the default is
`"same-origin"`. An unrecognised attribute value also reads as
`"same-origin"`; assigning an invalid value through the property throws a
`TypeError`. Changing `credentials` reloads a connected element.

`nonce` is reflected as a string property and supplies the nonce used for
executed scripts and generated styles. Set it before loading when the host CSP
requires a script or style nonce. Changing it does not itself reload the
element.

### Adopt server-rendered content

Use `adopt` when a server has already composed a materialized widget into the
page:

```html
<v-frame adopt src="/widgets/activity">
  <template shadowrootmode="open">
    <v-html lang="en">
      <v-head>
        <style>
          v-html, v-body { display: block; }
          v-head { display: none; }
        </style>
      </v-head>
      <v-body><p>Server-rendered activity</p></v-body>
    </v-html>
  </template>
</v-frame>
```

Declarative Shadow DOM displays the widget before registration. On its first
connection, `v-frame` uses `src` as the virtual document URL and creates the
realm from the existing `v-html`, `v-head`, and `v-body` content without
fetching the entry document. The `adopt` property reflects the boolean
attribute. Adoption is consumed once; `reload()`, reconnection, a later `src`
change, or a `credentials` change uses the normal network load.

The server-rendered preview stays visible while the live tree loads and
hydrates out of view, and the handoff is a single synchronous swap. Because
the staged tree matches the preview, the swap does not repaint. Frames hand
off independently, so several widgets can activate together.

Adopted markup must already use the materialized shell names and scoped CSS.
URLs should be absolute or resolvable against `src`. Scripts must be inert
during document parsing: set `type="application/vnd.v-frame"` and
`data-v-frame-script`. Add `data-v-frame-type="module"` when restoring a module
script; omit it to restore a classic script. Executable scripts placed directly
inside Declarative Shadow DOM run in the host realm before `v-frame` upgrades
and are unsupported.

```ts
const frame = document.querySelector<VFrameElement>("v-frame")!;

await frame.reload();
console.log(frame.status, frame.currentURL, frame.contentWindow);
```

The readonly properties are:

- `status`: `"idle"`, `"loading"`, `"ready"`, or `"error"`.
- `currentURL`: the fetched response's final URL while a realm is active, then
  the current virtual-history URL; otherwise `null`.
- `contentWindow`: the execution iframe's `Window`, or `null` before the realm
  exists or after it is torn down. It can become available while `status` is
  still `"loading"` during script bootstrap.

`reload()` returns a promise that reloads `currentURL`, or `src` before the
first document becomes active, when the element is connected and has a
non-empty `src`. Otherwise it resets the element to `idle` and resolves.
Reload and fetched document navigation keep the current document visible until
the replacement is ready. A failed replacement restores the current realm and
reports a non-fatal error. Document navigation does not rewrite `src`; changing
`src` explicitly starts a new session instead.
Removing the element, clearing `src`, or superseding a load aborts and disposes
the prior realm. The promise rejects when the selected generation ends fatally
during entry resolution or fetch, or while bootstrapping its realm. The
underlying error phase can be `navigation`. Nonfatal script, stylesheet,
runtime, and recoverable navigation errors are reported through
`v-frame-error`.

## Events

All events are `CustomEvent`s that bubble and are composed. Lifecycle and
error events are not cancelable. A `v-frame-navigate` event is cancelable for
default link, fragment, form, and `window` navigation; programmatic history
events are observational.

| Event | `detail` | Canceling it |
| --- | --- | --- |
| `v-frame-loadstart` | `{ url: string }` — resolved entry URL | No effect (not cancelable) |
| `v-frame-load` | `{ url: string }` — final/current virtual URL | No effect (not cancelable) |
| `v-frame-error` | `{ phase, url, error, fatal }` | No effect (not cancelable) |
| `v-frame-navigate` | `{ from, to, kind, state }` | For default link, fragment, form, and `window` actions, prevents the navigation |

`phase` is one of `entry`, `bootstrap`, `stylesheet`, `script`, `runtime`,
`navigation`, or `network`. `fatal` distinguishes a load-ending failure from a
reported, non-fatal stylesheet, script, or runtime failure. `kind` is one of
`link`, `form`, `window`, `push`, `replace`, `traverse`, or `fragment`.

For example, a host can decide which default link actions to allow:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  const { kind, to } = event.detail;
  if ((kind === "link" || kind === "fragment") && !to.startsWith("https://example.test/")) {
    event.preventDefault();
  }
});
```

## Execution, origin, and security

The response HTML is parsed and rebuilt as `v-html`, `v-head`, and `v-body`
inside the element's open shadow root. CSS is rewritten and linked stylesheets
are fetched and converted to styles. Page scripts execute in an invisible
same-origin iframe, with patched document, network, history, and selected
window APIs that operate on the reconstructed page.

The iframe is initialized with an empty document that inherits the host page's
URL and origin without fetching or executing the host document again. It does
**not** become a native frame at the fetched source URL. Its native session
history mirrors the virtual page's pathname, search, and hash on the host
origin. Consequently, `contentWindow.location.origin` is the host origin while
its path components follow `currentURL`; the virtual `document.URL` and
`document.documentURI` continue to expose the source-origin virtual
`currentURL`. A direct same-document hash change is folded back into virtual
history and can be canceled through `v-frame-navigate`. Other direct
`Location` APIs are unsupported. A detected native URL or document transition
ends the realm with a fatal `navigation` error. Browsers
expose no interception event when a `javascript:` Location URL executes and
completes without a string,
so that code can run in the existing document without producing a fatal error.
Do not load child code that uses `javascript:` Location URLs; a host CSP that
disallows that inline execution is required when this must be enforced.

Only load code you trust. The execution iframe inherits the host origin, so
page code can access host-origin cookies, storage, DOM capabilities available
to it, and other same-origin resources according to browser policy. Fetched
source is not a security boundary; `parent` and `top` still expose the host
window.

The host page's CSP governs the reconstructed styles and the execution realm;
provide `nonce` when its `script-src` or `style-src` policy requires one. The
fetched response's CSP, framing headers, and origin do not become a separate
policy for the reconstructed page. CORS still applies: the entry page,
stylesheets, scripts, and in-page network requests are made from the host
origin/context and must be permitted accordingly. Source-origin storage and
source-origin service workers are not used. Cookies, local/session storage,
IndexedDB, Cache Storage, and service-worker registration all follow the host
origin rather than emulating the fetched page's origin. Arbitrary remote sites
without controlled CORS are outside the supported deployment model.

Browsers report inline module evaluation failures on `window` without
identifying the originating script element. When several inline modules are
pending, v-frame attributes those failures by eliminating modules that later
complete successfully. An unrelated runtime exception raised during that same
interval can therefore be reported as a non-fatal `script` failure instead of
a `runtime` failure.

## How this differs from Web Fragments

`v-frame` and [Web Fragments](https://github.com/web-fragments/web-fragments)
use the same broad composition shape: application DOM lives in a shadow root
while its scripts execute in a hidden, same-origin iframe. They do not provide
the same routing contract. `v-frame` deliberately keeps each embedded
application's URL and history separate from the shell. Web Fragments provides
a gateway and makes a fragment without `src` *bound* to the shell's location
and history by default.

This comparison was checked against Web Fragments
[`eb44af6`](https://github.com/web-fragments/web-fragments/tree/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb).
The relevant implementation is in its
[`reframed.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/reframed/reframed.ts)
and
[`web.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/gateway/middleware/web.ts).
Upstream behavior may change.

| Behavior | `v-frame` | Web Fragments | Practical impact |
| --- | --- | --- | --- |
| Execution iframe startup | Creates an empty host-origin document without a network request. The source URL is represented virtually. | Requests the public fragment route in an iframe; the gateway returns a small initialization document so the iframe has that native URL. | `v-frame` needs no gateway request, but cannot safely use native `Location` navigation. |
| Default navigation model | Every frame has an independent virtual URL and history. | A fragment without `src` shares the shell URL and history. A fragment with `src` is unbound and has independent history. | A router inside `v-frame` does not automatically become the shell router. |
| `history.pushState()` and `replaceState()` | Update `currentURL` and the frame's session-history stack. They do not update the address bar or shell history. Cross-document back and forward traversal fetches and activates the recorded document. | In a bound fragment, operate on shell history. In an unbound fragment, operate on an independent stack. | Deep links, analytics, and browser back/forward integration require an explicit host routing contract with `v-frame`. |
| Direct `Location` mutation | Direct hash changes participate in virtual history. Other `location.assign()`, `location.replace()`, `location.href`, and `location.reload()` transitions are unsupported and fatal. | In a bound fragment, hard navigation or reload is propagated to the shell. | Applications that use hard navigation need modification or a host-owned navigation API before running in `v-frame`. |
| Links and forms | Same-context HTTP(S) links, `window.open(..., "_self")`, and GET forms fetch a replacement document in a new realm. Non-GET forms report a non-fatal navigation error. | Native navigation is backed by the gateway and, for bound fragments, the shell route. | `v-frame` provides independent document navigation but does not turn it into shell navigation. |
| Route requests | Entry HTML, styles, scripts, and patched network calls are fetched directly, subject to browser CORS. | Route patterns let the gateway proxy fragment documents, assets, and data through the shell origin. | `v-frame` has less server infrastructure, while Web Fragments can give independently deployed applications one public origin. |
| Top-level document navigation | Outside `v-frame`; the host decides how a frame route maps to a shell route. | The gateway distinguishes iframe, soft-navigation, asset, and top-level document requests and can pierce a server-rendered fragment into the shell. | A `v-frame` deployment must implement its own hard-navigation fallback and route mapping. |
| Server-rendered startup | The host explicitly materializes Declarative Shadow DOM and marks the frame `adopt`; first activation does not fetch the entry document. | The gateway can fetch and pierce registered fragments into the shell response, then the client portals and activates them. | `v-frame` keeps SSR composition framework-agnostic but makes it the host application's responsibility. |

Web Fragments' unbound mode is not equivalent to a normal standalone browser
document either. In the compared revision, soft history is independent, but a
hard navigation or reload clears the fragment after its iframe realm unloads.
The bound mode is the relevant comparison when an application expects its
navigation to control the whole page.

### Navigation pitfalls

An SPA router using only the History API can maintain internal state inside a
`v-frame`:

```js
history.pushState({ orderId: 42 }, "", "/orders/42");
```

After this call, `frame.currentURL` and the child `history` reflect
`/orders/42`, but the browser address bar and host history do not. No document
is fetched. `push`, `replace`, and `traverse` navigation events are
observational and cannot be canceled. Mechanically mirroring them into host
history creates two stacks that can diverge, so define which application owns
each route and synchronize semantic route changes instead.

The equivalent hard-navigation code is incompatible:

```js
location.assign("/orders/42");
```

It starts a real navigation in the hidden iframe, destroying the JavaScript
realm. `v-frame` reports that escape as a fatal navigation error rather than
pretending the new document was reconstructed in the existing shadow root.

Ordinary same-context HTTP(S) links fetch and render their destination in a
fresh realm:

```html
<a href="/orders/42">Open order</a>
```

The old document remains visible while the destination loads. Successful
navigation preserves the frame's session history, so `history.back()` and
`history.forward()` can fetch earlier or later document entries. A failed
navigation restores the old live realm. `_top`, `_parent`, named-target, and
non-HTTP(S) links only report their requested navigation. `_blank` links can
open a native window after the host allows the navigation event.

Same-context GET forms fetch a document after replacing the action query with
their successful controls. A non-GET request is not sent; allowing its
navigation event produces a non-fatal `NotSupportedError`, and its body is not
included in `v-frame-navigate`. A permitted `_blank` GET form can open a native
window.

The host can take ownership of a link before the virtual default runs:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  if (event.detail.kind !== "link") return;

  event.preventDefault();
  hostRouter.navigate(event.detail.to);
});
```

Do the same for forms or `window.open()` only when the host has enough
application-specific information to reproduce the intended operation. This is
required for non-GET forms because the event is not a general HTTP request
description.

### URL and origin pitfalls

For a cross-origin source, the execution realm's native and virtual URLs
intentionally disagree:

```js
location.origin; // the shell origin
document.URL;    // the source document's virtual URL
```

DOM URL attributes and patched network APIs resolve against the virtual
document base, but arbitrary application code such as
`new URL("/api", location.href)` resolves against the shell origin. Code that
uses `location` to select an API origin, compares `location.href` with
`document.URL`, registers a source-origin service worker, or expects
source-origin storage can therefore misbehave. Prefer same-origin deployment
when possible and test those assumptions explicitly when loading through
CORS.

In short, `v-frame` is suited to embedded applications whose navigation is
internal or coordinated explicitly with the host. Web Fragments' bound mode is
closer to a transparent replacement for an application that expects to own the
page URL, browser history, hard navigation, and server routing.

## Dynamic CSSOM

Virtual `<style>` elements support `sheet.insertRule()`, legacy `sheet.addRule()`,
`CSSStyleRule.selectorText`, and `CSSStyleDeclaration.cssText`. These inputs
receive the same shell-selector rewriting as loaded stylesheets, and relative
`url()` values are resolved against the current virtual document base URL.
`@import` passed to `insertRule()` throws `NotSupportedError` because loading it
would be asynchronous. `document.adoptedStyleSheets` (both reading and
assigning) and constructable stylesheets are not supported for the virtual
document.

For a newly inserted or text-mutated `<style>` that is still resolving
asynchronous `@import` rules, wait for its rewritten rules to appear before
using CSSOM mutation APIs. Mutations made against the temporary empty sheet can
be replaced when the pending text rewrite commits.

Inline `style` attributes are exposed logically without placing a CSP-unsafe
attribute on the connected element. `getAttribute()`, `hasAttribute()`, cloning,
and the element's `style` declaration retain the authored value, while a
nonce-bearing internal stylesheet applies it. Element declarations support
`cssText`, indexed access, property lookup and priority, `setProperty()`,
`removeProperty()`, and ordinary property assignment. Relative `url()` values
are resolved against the live virtual document base and rebuilt when that base
changes.

The internal rules use a selector with 32 ID components to approximate native
inline specificity. A page selector with more than 32 IDs can therefore outrank
a virtual inline declaration even though it could not outrank a native inline
declaration. Important declarations in named cascade layers can also outrank
the generated unlayered important rule because layer precedence is resolved
before selector specificity. Ordinary page selectors retain the expected
inline-style ordering.

Individual declaration updates on stylesheet rules, including
`CSSStyleRule.style.setProperty()` and assignments such as
`rule.style.backgroundImage = value`, are not rewritten. Use
`rule.style.cssText` when a stylesheet rule declaration contains a relative
`url()`.

URL-bearing `getAttribute()` values retain their authored text while HTML URL
properties resolve against the live virtual document base. Internally, those
attributes must contain absolute URLs so adopted shadow-tree nodes load against
the virtual page instead of the host document. Code that bypasses
`getAttribute()` and reads raw `Attr` nodes through `element.attributes` or
`getAttributeNode()` therefore sees those internal absolute values.

## Compatibility

| Browser family | Support |
| --- | --- |
| Current Chromium | Supported |
| Current Firefox | Supported |
| WebKit / Safari | Best effort; verify the pages and policies you need |

The implementation needs modern custom elements, shadow DOM, fetch, and
`ResizeObserver` support. Test against the browsers and CSP/CORS deployment
that will host your page. Compatibility is limited to behavior covered by the
Chromium and Firefox acceptance suite; this package does not claim general
React, Vue, or other framework compatibility.

## v1 scope and exclusions

`v-frame` deliberately does not provide a full browser-document environment.
In particular, v1 excludes:

- child-defined custom elements;
- import maps;
- `document.open()` and `document.write()`, including parser-interleaving
  semantics;
- direct mutation of the `Document` child list and preservation of source
  doctype public or system identifiers;
- direct `Location` document navigation and reload (direct hash changes are
  supported);
- non-GET form navigation;
- native nested-iframe fidelity;
- fullscreen and pointer lock;
- source-origin service workers;
- native iframe viewport semantics.

Links, forms, `window.open`, and virtual `history` operations are intercepted
to report `v-frame-navigate`. Same-document history changes update
`currentURL` without fetching, while allowed same-context HTTP(S) links,
`window.open(..., "_self")`, and GET forms fetch a document into a fresh realm.
A `_blank` link or GET form may open a native window only after its navigation
event is allowed. Direct document reload is excluded, so virtual
`history.go()` and `history.go(0)` are no-ops.
Middle-button and Ctrl/Meta/Shift link activations use the same gated `_blank`
behavior. Link and submit defaults run after event propagation, so
`event.preventDefault()` cancels them; returning `false` also cancels them from
an inline handler or DOM event-handler property, but not from an
`addEventListener()` callback. Stopping propagation alone does not. GET forms
use submitter overrides when present, replace the action query with successful
controls, and serialize file controls by filename.
Viewport measurements are adapted to the host element and host scrolling, not
to a separate browser viewport. Shadow CSS media queries, viewport units, and
fixed positioning still use browser-viewport semantics. Use a native
`<iframe>` or another isolation mechanism for pages that require these
guarantees.

Some transports expose no browser API for applying the component credential
mode exactly. Entry and stylesheet fetches, patched `fetch` and `Request`, and
asynchronous XHR suppress same-origin cookies with `credentials="omit"`.
Synchronous XHR and XHR username/password arguments are not supported in that
mode. Browser-native external scripts, EventSource, classic workers,
WebSocket, and `sendBeacon` can still use ambient same-origin credentials;
module workers receive the configured credential option. Prefer patched
`fetch` when exact credential control is required.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm build` type-checks, bundles the ESM output, and emits declarations.
`pnpm test` builds first and runs the Playwright suite.

## Examples

`examples/client` is a React host that switches among Angular, Solid, and Qwik
microfrontends with load-gated View Transitions.

`examples/ssr` uses Cloudflare service bindings to compose
React Router and Qwik SSR widgets into adopted `<v-frame>` elements before the
host HTML is delivered.
