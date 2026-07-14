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

When the browser supports element-scoped View Transitions, `v-frame` keeps a
snapshot of the server-rendered widget visible while it installs the live tree.
Frames transition independently, so several widgets can activate together.
Reduced-motion preferences and browsers without scoped transitions use the
same direct handoff without animation.

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

`reload()` returns a promise for a new load when the element is connected and
has a non-empty `src`. Otherwise it resets the element to `idle` and resolves.
Removing the element, clearing `src`, or superseding a load aborts and disposes
the prior realm. The promise rejects when the selected generation ends fatally
during entry resolution or fetch, or while bootstrapping its realm. The
underlying error phase can be `navigation`. Nonfatal script, stylesheet, and
runtime errors are reported through `v-frame-error`.

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
`currentURL`. Direct `Location` APIs are unsupported. A detected native URL or
document transition ends the realm with a fatal `navigation` error. Browsers
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
- direct `Location` APIs and navigation;
- native form and document navigation;
- native nested-iframe fidelity;
- fullscreen and pointer lock;
- source-origin service workers;
- native iframe viewport semantics.

Links, forms, `window.open`, and virtual `history` operations are intercepted
to report `v-frame-navigate`; same-origin supported virtual history changes
update `currentURL` without fetching a new document. A `_blank` link or GET
form may open a native window only after its navigation event is allowed.
Because document reload is excluded, virtual `history.go()` and
`history.go(0)` are no-ops.
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

`examples/host` is a React host that switches among Angular, Solid, and Qwik
microfrontends with load-gated View Transitions.

`examples/workers-composition` uses Cloudflare service bindings to compose
React Router and Qwik SSR widgets into adopted `<v-frame>` elements before the
host HTML is delivered.
