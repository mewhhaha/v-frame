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
  src="/applications/orders/"
  credentials="same-origin"
  nonce="host-csp-nonce"
></v-frame>
```

Providing `src` creates an unbound frame with independent soft history. It is
resolved against the host document's base URL and must resolve to a
same-origin `http:` or `https:` gateway route. Setting or changing `src` on a
connected element starts a load. An invalid, cross-origin, or unsupported URL
produces a fatal `v-frame-error` with phase `entry`.

Omitting `src` creates a frame bound to the shell, matching Web Fragments'
default:

```html
<v-frame></v-frame>
```

The current shell URL is then both the entry route and the URL visible to the
child. Child History methods operate on shell history, while host history
changes and browser traversal are mirrored back into the child. The gateway
must return the application document for a normal fetch of that URL, its realm
marker for an iframe request, and the composed shell for top-level navigation.
Use an explicit empty `src=""` to keep a connected frame idle.

The gateway route can proxy an application deployed on another origin, but
the URL exposed to the browser and the child application must be same-origin
with the host. See [Gateway and Location](#gateway-and-location).

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

When the host and gateway marker enforce Trusted Types, assign an explicit
policy definition before connecting the element:

```ts
import type { VFrameTrustedTypesPolicy } from "v-frame";

const trustedTypesPolicy: VFrameTrustedTypesPolicy = {
  name: "orders-frame",
  createHTML: (source) => source,
  createScript: (source) => source,
  createScriptURL: (source) => source,
};

const frame = document.createElement("v-frame");
frame.trustedTypesPolicy = trustedTypesPolicy;
frame.src = "/applications/orders/";
document.body.append(frame);
```

Allow that name in both policies with `trusted-types orders-frame` and enable
enforcement with `require-trusted-types-for 'script'`. `v-frame` creates the
native policy inside each hidden execution realm, so the returned trusted
values have the correct realm and CSP. The callbacks also run on browsers
without Trusted Types for consistent transformations. The identity rules above
are appropriate only for application code already trusted to execute; use
stricter rules when the source needs validation. A changed definition applies
when the next realm is created and does not reload an active frame by itself.

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
connection, `v-frame` uses `src` as the document URL and creates the realm from
the existing `v-html`, `v-head`, and `v-body` content without fetching the
entry document. It still requests the small gateway marker to establish the
realm's native URL. The `adopt` property reflects the boolean attribute.
Adoption is consumed once; `reload()`, reconnection, a later `src` change, or a
`credentials` change uses the normal network load.

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
  the selected bound or unbound history URL; otherwise `null`.
- `contentWindow`: the execution iframe's `Window`, or `null` before the realm
  exists or after it is torn down. It can become available while `status` is
  still `"loading"` during script bootstrap.

Each `status` value is also exposed as an exclusive custom-element state, so
hosts can style `v-frame:state(idle)`, `:state(loading)`, `:state(ready)`, and
`:state(error)` without mirroring the property into attributes.

`reload()` returns a promise that reloads `currentURL`, or the selected entry
route before the first document becomes active, when the element is connected
and is not opted out with `src=""`. Otherwise it resets the element to `idle`
and resolves.
Reload keeps the current document visible until the replacement is ready. A
failed reload restores the current realm and reports a non-fatal error.
Changing `src` explicitly starts a new history session instead.
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

Import maps are installed in the execution iframe in document order before
deferred modules run. Custom elements created after their child registry
definition, through `document.createElement()` or HTML mutation APIs such as
`innerHTML`, are constructed by that child registry and remain isolated
between frames. Initial declarative custom elements are adopted into the host
document before scripts define them, so browsers cannot upgrade those
existing nodes through the child registry.

The hidden iframe requests the gateway marker at the selected entry route. In
bound mode its native `Location`, `document.URL`, `document.documentURI`, and
History API mirror the shell. With `src`, those APIs start at the public
application route and soft history remains independent. Hard `Location`
transitions return to the gateway and are promoted to the host document after
`v-frame-navigate` is allowed. Browsers
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

The host page's CSP governs reconstructed styles, while the gateway marker's
CSP governs the execution realm. Provide `nonce` when either policy requires
one. The fetched application response's CSP and framing headers do not become
a separate policy for the reconstructed page. Application documents and
assets deployed elsewhere must be exposed or proxied through the public
gateway route. Cookies, local/session storage, IndexedDB, Cache Storage, and
service-worker registration all follow that shared public origin.

Browsers report inline module evaluation failures on `window` without
identifying the originating script element. When several inline modules are
pending, v-frame attributes those failures by eliminating modules that later
complete successfully. An unrelated runtime exception raised during that same
interval can therefore be reported as a non-fatal `script` failure instead of
a `runtime` failure.

## Gateway and Location

The `v-frame/gateway` entry point exports `serveVFrameRoute()`. Every public
application route selected by `src` or bound navigation must provide the same
contract:

```ts
import { serveVFrameRoute } from "v-frame/gateway";

return serveVFrameRoute({
  request,
  realmHeaders: {
    "Content-Security-Policy": "script-src 'self' 'nonce-host'; style-src 'self' 'nonce-host'",
  },
  loadDocument: () => application.fetch(request),
  loadShell: () => shell.fetch(request),
});
```

For an iframe navigation, the helper returns a fixed marker document without
calling `loadDocument()`. For an ordinary fetch, it returns the application
response with `V-Frame-Gateway: 1`. When optional `loadShell` is present, a
top-level document request returns that composed shell instead. Responses include
`Vary: Sec-Fetch-Dest` so a shared cache cannot serve one representation for
the other. The iframe request must reach the gateway at the same public URL as
`src`. Cross-origin `src` values are rejected; proxy remote deployments behind
the same-origin public route instead.

The marker response becomes the execution realm's policy container after
`document.open()`. Use `realmHeaders` to apply the intended script/style CSP,
including the same nonce passed to the component. Do not send a
`frame-ancestors` policy or framing header that prevents the marker from
loading in the same-origin host.

The hidden iframe requests that marker alongside the ordinary entry fetch.
An unbound frame keeps that application route as its native `Location`; a
bound frame is synchronized to the shell before scripts run. Same-context
links, GET forms, and `window.open(..., "_self")` are promoted to the host
document after an allowed `v-frame-navigate` event. A direct `location.assign()`,
`location.href` change, or `location.reload()` first destroys the child realm,
then the marker load is promoted to the host. Canceling that event reconstructs
the previous frame.
The browser does not expose whether the child used assign or replace after the
realm has navigated, so direct `location.replace()` is also promoted with host
`location.assign()` semantics.

Direct `Location` changes must stay on the public gateway origin. A
cross-origin direct assignment leaves the readable realm before `v-frame` can
recover its destination and therefore ends the frame with a fatal navigation
error. Cross-origin `<a>` and GET form destinations do not have that limitation
because their defaults are intercepted before navigation.

For an unbound frame, the server must separately decide what a top-level
application route means.
It can render the composed shell there, redirect to a canonical shell URL, or
leave the application standalone. The gateway helper deliberately does not
invent that product-level mapping. History remains frame-local with `src`; it
mutates shell history when `src` is omitted.

## How this differs from Web Fragments

`v-frame` and [Web Fragments](https://github.com/web-fragments/web-fragments)
use the same broad composition shape: application DOM lives in a shadow root
while its scripts execute in a hidden, same-origin iframe. They use the same
routing split: a fragment without `src` is bound to shell location and
history, while a fragment with `src` keeps independent soft history. Web
Fragments provides a broader gateway around that model.

This comparison was rechecked on July 21, 2026 against the current Web
Fragments default branch,
[`eb44af6`](https://github.com/web-fragments/web-fragments/tree/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb).
The relevant implementation is in its
[`reframed.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/reframed/reframed.ts),
[`script-execution.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/reframed/script-execution.ts),
[`iframe-patches.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/reframed/iframe-patches.ts),
[`main-patches.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/reframed/main-patches.ts),
[`web-fragment-host.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/elements/web-fragment-host.ts),
and
[`web.ts`](https://github.com/web-fragments/web-fragments/blob/eb44af6d36559df2cf00b2cd2bcb16ae3ecbdabb/packages/web-fragments/src/gateway/middleware/web.ts).
Upstream behavior may change.

| Behavior | `v-frame` | Web Fragments | Practical impact |
| --- | --- | --- | --- |
| Execution iframe startup | Requests a marker from the same-origin public application route in parallel with the application document. | Requests the public fragment route in an iframe; the gateway returns a small initialization document so the iframe has that native URL. | Both require an additional small bootstrap request per realm. |
| Default navigation model | A frame without `src` shares shell URL/history; a frame with `src` is unbound. | The same bound/unbound split. | Existing embeds can stay independent while shell-routed apps need no host synchronization glue. |
| `history.pushState()` and `replaceState()` | Operate on shell history in bound mode and an independent stack in unbound mode. | The same mode-dependent ownership. | Bound routers update the address bar and participate in browser back/forward. |
| Direct `Location` mutation | Promotes hard navigation, reload, and direct hash changes to the shell; canceled navigation rebuilds the child, and replace degrades to assign. | In a bound fragment, hard navigation or reload is propagated to the shell. | Common Location code works, but the server contract is mandatory and replace semantics cannot be preserved. |
| Links and forms | Promotes same-context HTTP(S) links, `_self` windows, and GET forms to the shell. Fragment links update the selected history and scroll inside the frame. Non-GET forms remain unsupported. | Native navigation is backed by the gateway and, for bound fragments, the shell route. | Both require the shell to define the destination route. |
| Route requests | Adds only the iframe/document distinction and a version header; proxying remains the host's responsibility. | Route patterns let the gateway proxy fragment documents, assets, and data through the shell origin. | The `v-frame` gateway is smaller, but independently deployed applications still need host routing or proxy infrastructure. |
| Fragment identity | Bound frames fetch the shell URL without an application identifier. | Every fragment has a `fragment-id`, forwarded as `X-Web-Fragment-Id`. | A gateway cannot distinguish two bound `v-frame` applications that share the same shell URL without host-specific routing. |
| Top-level document navigation | Outside `v-frame`; the host decides how a frame route maps to a shell route. | The gateway distinguishes iframe, soft-navigation, asset, and top-level document requests and can pierce a server-rendered fragment into the shell. | A `v-frame` deployment must implement its own hard-navigation fallback and route mapping. |
| HTML delivery | Buffers the application document, then neutralizes and parses it before connecting application nodes. | Streams client-rendered HTML into the shadow tree through `writable-dom`. | `v-frame` deliberately pays a first-render latency cost for controlled parsing; Web Fragments can reveal a streaming response sooner. |
| Execution-context resources | Executes classic and module scripts and forwards import maps into the iframe. Resource-hint links and `speculationrules` are not forwarded. | Also forwards `preload`, `prefetch`, and `modulepreload` links and executes `speculationrules` in the iframe. | A `v-frame` application's resource hints can be ineffective or associated with the wrong document context. |
| Document load | Marks the document complete after initial scripts and bootstrap-created external scripts settle. It does not wait for initial images. | Waits for initial images to load or error before setting complete and dispatching `load`. | `v-frame` can fire `load` earlier than the same application would in a normal document. |
| Host patching | Patches the child realm and document facade, and restores its bound host-history hooks when disposed. | Also patches host `Node` and `Element` insertion methods globally and installs host-history patches once. | `v-frame` avoids permanent host DOM prototype changes at the cost of implementing more behavior in its own facade. |
| Server-rendered startup | The host materializes Declarative Shadow DOM and marks the frame `adopt`. Activation serializes and reparses that preview into a staged live tree without refetching application HTML. | The gateway can pierce a fragment into the shell response, then the client portals the live fragment host and prefers an atomic DOM move when available. | `v-frame` keeps SSR composition host-owned, but focus, selection, form state, and scroll changed before activation are not preserved by the reparse. |
| Viewport APIs | `inner*`, `outer*`, `visualViewport`, and `matchMedia()` follow the host page. Scrolling remains local to the frame. | Viewport measurements and media matching follow the host page. | Application layout code sees the page viewport without making `scrollTo()` move the shell. |
| Browser coverage | Chromium and Firefox are tested; WebKit is best-effort. | Its browser suite includes Chromium, Firefox, and WebKit, with feature-specific skips and caveats. | WebKit compatibility should be earned with tests rather than inferred from the shared architecture. |

### What to borrow from Web Fragments

These are directions, not compatibility promises. Each needs a focused change
and browser tests before it becomes part of the `v-frame` contract.

| Priority | Inspiration | Direction for `v-frame` |
| --- | --- | --- |
| Next | Execution-context resource hints | Forward `preload`, `prefetch`, and `modulepreload` links to the iframe and support `speculationrules`, while retaining inert logical nodes in the visible tree. Cover load/error forwarding, CSP, and teardown. |
| Next | More native load timing | Keep `readyState` at `interactive` until initial images settle, then dispatch `load`. Define behavior for images inserted during bootstrap before extending the barrier to other resource types. |
| Next | Optional fragment identity | Add an optional application identifier that the entry request can forward to a gateway. This should solve overlapping bound routes without making a registry mandatory for simple embeds. |
| Later | State-preserving SSR activation | Test focus, text selection, changed form controls, and element scroll across activation. Prefer lifecycle-preserving DOM moves where browser support permits them; otherwise transfer only state with defined semantics. |
| Maintenance | Teardown and browser evidence | Add a Chromium `WeakRef`/forced-GC regression for destroyed realms and run the behavioral suite in WebKit before claiming support. Existing cancellation and timer teardown tests remain the baseline. |
| Optional package | Production gateway composition | A companion layer could add route registration, proxying, SSR fallback, redirect handling, and selected response-header forwarding. Those concerns do not need to enlarge the core element. |

Observer constructors, `navigator` members, and other cross-realm objects should
be evaluated with small compatibility tests. Web Fragments delegates several
of them to the host realm; `v-frame` should only do the same where native child
objects produce an observable application bug.

### What not to copy

- Do not globally intercept host `Node` or `Element` insertion methods. Such
  patches affect unrelated shell code and make multiple runtimes, frameworks,
  and browser extensions share hidden mutable behavior.
- Do not require a fragment registry or full proxy gateway for every frame.
  The current same-origin marker contract is sufficient when the host already
  owns routing; richer composition belongs in an optional integration layer.
- Do not adopt a streaming DOM writer until it can preserve `v-frame`'s
  neutralization, Trusted Types boundary, stylesheet rewriting, and parsing
  fidelity. Streaming is valuable, but changing the parser is a security and
  correctness decision rather than a transport optimization.
- Do not copy the stylesheet-cloning workaround used while portaling an SSR
  host. `v-frame` currently swaps a staged tree instead of moving that host,
  and the workaround has known `@import`, cross-origin CSSOM, and cascade-order
  limitations.
- Do not replace child-realm observers, constructors, or `navigator` wholesale
  with host objects. Preserve isolation unless a tested web-platform mismatch
  requires a narrower bridge.

Web Fragments' unbound mode is not equivalent to a normal standalone browser
document either. In the compared revision, soft history is independent, but a
hard navigation or reload clears the fragment after its iframe realm unloads.
The bound mode is the relevant comparison when an application expects its
navigation to control the whole page.

### Navigation pitfalls

An SPA router in a bound frame updates shell history directly:

```js
history.pushState({ orderId: 42 }, "", "/orders/42");
```

After this call, the address bar, `frame.currentURL`, and child history all
reflect `/orders/42`; no document is fetched. With `src`, the same call remains
inside the frame's independent history. `push`, `replace`, and `traverse`
navigation events are observational and cannot be canceled.

Hard-navigation code promotes its destination to the host document:

```js
location.assign("/orders/42");
```

It starts a real navigation in the hidden iframe. The gateway returns a marker
instead of executing the application there, and `v-frame` then navigates the
host. Canceling `v-frame-navigate` reconstructs the previous child realm.

Ordinary same-context HTTP(S) links also navigate the host after an allowed
`v-frame-navigate` event:

```html
<a href="/orders/42">Open order</a>
```

Same-document fragment links stay inside the frame's soft history and scroll
the reconstructed document. `_top`, `_parent`, named-target, and non-HTTP(S)
links only report their requested navigation. `_blank` links can open a native
window after the host allows the navigation event.

Same-context GET forms navigate the host after replacing the action query with
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

### URL and origin consequences

The application observes its same-origin public gateway URL through both
`location` and `document.URL`. Relative DOM attributes and network calls use
that URL as their base. If the application is deployed on another origin, the
gateway must proxy the document, assets, and APIs for which the application
expects same-origin resolution. Storage, cookies, and service workers belong
to the public host origin, not the upstream deployment origin.

In short, omit `src` for an application that owns the page URL and browser
history; provide `src` for an independently routed embedded application.

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
`matchMedia()` support. Test against the browsers and CSP/CORS deployment that
will host your page. Compatibility is limited to behavior covered by the
Chromium and Firefox acceptance suite; this package does not claim general
React, Vue, or other framework compatibility.

## v1 scope and exclusions

`v-frame` deliberately does not provide a full browser-document environment.
In particular, v1 excludes:

- initial declarative elements defined only in the child custom-element registry;
- `document.open()` and `document.write()`, including parser-interleaving
  semantics;
- direct mutation of the `Document` child list and preservation of source
  doctype public or system identifiers;
- preservation of `location.replace()` semantics after a hard navigation;
- non-GET form navigation;
- native nested-iframe fidelity;
- fullscreen and pointer lock;
- upstream-origin service workers;
- native iframe viewport semantics.

Links, forms, `window.open`, and `history` operations are intercepted to report
`v-frame-navigate`. Same-document history changes update `currentURL` without
fetching and also update shell history in bound mode, while allowed
same-context HTTP(S) links,
`window.open(..., "_self")`, GET forms, and direct Location navigation promote
to the host.
A `_blank` link or GET form may open a native window only after its navigation
event is allowed. In unbound mode, `history.go()` and `history.go(0)` remain
no-ops;
a direct `location.reload()` promotes to the host.
Middle-button and Ctrl/Meta/Shift link activations use the same gated `_blank`
behavior. Link and submit defaults run after event propagation, so
`event.preventDefault()` cancels them; returning `false` also cancels them from
an inline handler or DOM event-handler property, but not from an
`addEventListener()` callback. Stopping propagation alone does not. GET forms
use submitter overrides when present, replace the action query with successful
controls, and serialize file controls by filename.
`innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`, `visualViewport`, and
`matchMedia()` follow the host page. `scrollX`, `scrollY`, `scrollTo()`, and
`scrollBy()` remain tied to the frame's own scrolling surface. Shadow CSS media
queries, viewport units, and fixed positioning use browser-viewport semantics.
Use a native
`<iframe>` or another isolation mechanism for pages that require these
guarantees.

Some transports expose no browser API for applying the component credential
mode exactly. Entry and stylesheet fetches, patched `fetch` and `Request`, and
asynchronous XHR suppress same-origin cookies with `credentials="omit"`.
The iframe marker request and direct Location navigation also use ambient
same-origin credentials. Synchronous XHR and XHR username/password arguments
are not supported in omit mode. Browser-native external scripts, EventSource,
classic workers, WebSocket, and `sendBeacon` can still use ambient same-origin
credentials; module workers receive the configured credential option. Prefer
patched `fetch` when exact credential control is required.

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
