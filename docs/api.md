# API reference

Everything `v-frame` exposes to a host page. For the routing story behind the
navigation members, see [Navigation](./navigation.md); for the server-side
materializer, see [SSR](./ssr.md).

## Entries

| Import                       | Contents                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `@mewhhaha/v-frame/register` | Defines `<v-frame>` in a browser custom element registry; safe no-op during SSR.    |
| `@mewhhaha/v-frame`          | `VFrameElement`, `defineVFrame()`, `VFrameStatus`, and the event and option types.  |
| `@mewhhaha/v-frame/server`   | The SSR materializer core, its `HTMLRewriter` adapter, and the stylesheet rewriter. |

```ts
import "@mewhhaha/v-frame/register";
```

```ts
import { defineVFrame, VFrameElement, VFrameStatus } from "@mewhhaha/v-frame";

// Defining explicitly is the same registration, without the import side effect.
defineVFrame();
```

`VFrameElement` carries typed event overloads. Pass it to the DOM query when the
host needs the concrete element API:

```ts
const frame = document.querySelector<VFrameElement>("v-frame");
frame?.addEventListener("v-frame-load", (event) => console.log(event.detail.url));
```

## Guest geometry and outside interactions

Guest rectangles and hit-test coordinates are frame-local. Window viewport sizes
and media queries follow the host page; there is no separate layout viewport.
`document.scrollingElement` is the virtual HTML element and mirrors frame
scrolling. The virtual body keeps its own native scroll and client metrics.

Document listeners receive outside pointer, click, and focus interactions as
synthetic events targeted at the virtual body. This lets guest dismiss layers
close when the user interacts with the host or another frame without exposing
foreign nodes as guest targets. Canceling or stopping these notifications does
not cancel or stop the host's original event. Notifications do not cross the
physical shadow boundary. Guest-origin events retain their ordinary logical
path and remain confined to their frame.

## Configuration

Attributes, each with a matching property. Changing `src`, `credentials`,
`navigation`, or `trusted-types-policy` on a connected element restarts the
guest with a fresh network load, but only when the _effective_ value changes:
`credentials="same-origin"` becoming `credentials="bogus"` means the same thing
and does not reload. Changing `nonce` applies to the next load instead of
forcing one.

| Attribute              | Property             | Default         | Purpose                                                                                                                     |
| ---------------------- | -------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src`                  | `src`                | `""`            | Same-origin `http:`/`https:` guest document URL. An empty or missing value keeps the frame idle.                            |
| `adopt`                | `adopt`              | `false`         | Activates the initial Declarative Shadow DOM instead of fetching `src`. Not observed — read once, see below.                |
| `navigation`           | `navigation`         | `"guest"`       | `"host"` when the shell owns the guest's route.                                                                             |
| `credentials`          | `credentials`        | `"same-origin"` | `"omit"`, `"same-origin"`, or `"include"`. See below.                                                                       |
| `nonce`                | `nonce`              | `""`            | CSP nonce applied to executed scripts and generated styles.                                                                 |
| `trusted-types-policy` | `trustedTypesPolicy` | none            | Name of a Trusted Types policy the host CSP allows (no sanitization), or a full policy definition set through the property. |

Attributes and properties treat invalid values differently, on purpose. An
attribute follows the HTML convention that an unrecognised value falls back to
the default: `credentials="bogus"` reads back as `"same-origin"` and
`navigation="bogus"` as `"guest"`. The property setters validate instead:
assigning `credentials` or `navigation` a value outside the ones listed throws a
`TypeError`, as does assigning an empty `trustedTypesPolicy` string or a policy
object that lacks a name or one of its three methods.

### When `adopt` is read

`adopt` is a reflecting property, but no attribute observer watches it. It is
read once, when the element connects, and only the first connection of an
element that arrived with a Declarative Shadow DOM tree can adopt it. After that
the adoption has been spent: setting or removing `adopt` later changes the
attribute and nothing else, and reconnecting the element fetches `src` like any
other frame. See [SSR](./ssr.md).

### Moving the element

Removing the element and inserting it again, whether with `append`,
`insertBefore`, or `replaceChildren`, disconnects it: the guest is torn down, the
frame returns to `status === "idle"`, and the insertion fetches and runs the guest
from scratch. A state-preserving move through `Element.prototype.moveBefore`
keeps the guest alive instead. The element implements `connectedMoveCallback()`
and does nothing in it, so the guest's realm, scripts, history, and
`status === "ready"` survive the move. Browsers without `moveBefore` only have the
restarting form.

### What `credentials` means

`credentials` covers the requests **`v-frame` itself makes** — the entry
document and the stylesheets it resolves — and supplies the default mode for
guest requests that do not choose one.

It is **not a security boundary** and does not constrain the guest's own network
calls. The guest shares the host origin, so it can pass any `credentials` to
`fetch()`, set `withCredentials` on an `XMLHttpRequest`, or read
`document.cookie` whenever it likes. Setting `credentials="omit"` on a frame
whose guest you do not trust buys you nothing; do not use it as one.

The one place the setting reaches into guest requests is
`credentials="include"`, which defaults `XMLHttpRequest.withCredentials` to
`true` for requests that never assign it themselves.

## Element properties

Readonly:

| Property        | Value                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| `status`        | `"idle"`, `"loading"`, `"ready"`, or `"error"`.                                               |
| `currentURL`    | Current guest URL, or `null` without an active guest.                                         |
| `contentWindow` | Guest `Window`, or `null` before creation and after teardown.                                 |
| `canGoBack`     | Whether the guest session has an earlier entry. In host mode, the shell's. `false` when idle. |
| `canGoForward`  | Whether the guest session has a later entry. In host mode, the shell's. `false` when idle.    |

`VFrameStatus` is exported as both a value and a type, so a host can compare
against `VFrameStatus.Ready` rather than a string literal.

`HTMLElementTagNameMap` is not augmented, because a published package cannot
declare global types. See [Typing the element](#typing-the-element).

Teardown restores the document and node facades, including on retained documents.
Retained history methods stay inert; an old window does not keep the replaced
guest active. Drop references to old nodes and realms when they are no longer
needed so the browser can collect them.

Each status is also a custom-element state:

```css
v-frame:state(loading) {
  cursor: progress;
}

v-frame:state(error) {
  outline: 2px solid firebrick;
}
```

## Element methods

| Method                             | Effect                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `navigate(url, { replace })`       | Same-document navigation to another same-origin route.    |
| `back()`, `forward()`, `go(delta)` | Traverses the guest session, resolving once it has moved. |
| `reload()`                         | Reloads the current guest document over the network.      |

All five return a `Promise<void>`. The navigation methods are described in
[Navigation](./navigation.md), including exactly which errors they reject with.
None of the four navigation methods can run before `v-frame-load`, because the
first guest is not live until then. `reload()` can: on a connected frame with a
`src` it starts a fresh load whether or not a guest is live yet.

`reload()` settles with the load it starts. It resolves when that load succeeds,
and rejects with the same error the frame reports through `v-frame-error` when it
fails: a `TypeError` for a `src` that is not an `http:` or `https:` URL, a
`TypeError` for a cross-origin one, a `TypeError` naming the status for a
response that is not `ok`, and the fetch's own error when the request fails at
the network layer. Reloading a frame whose route 404s therefore rejects.

A load that a later one supersedes, or that the element's removal abandons,
before it commits rejects with an `AbortError`. A load that did commit resolves
even if a `v-frame-navigated` or `v-frame-load` listener then starts another one.

Two cases have nothing to reload and reject with an `InvalidStateError` without
starting a load: a disconnected element, and one with no `src`. Both return the
element to `status === "idle"`.

```ts
try {
  await frame.reload();
} catch (error) {
  // The failure the frame reports through `v-frame-error` as well.
}
```

The current content stays visible until its replacement is ready. A reload that
fails with a live guest to fall back on restores it and emits a nonfatal
`v-frame-error`; one that fails without a guest to restore — a frame already in
`status === "error"`, or one reloading before its first guest went live — emits
a fatal `v-frame-error` and leaves the element in `status === "error"`.
`tests/element-lifecycle.spec.ts` pins how `reload()` itself settles; the fatal and
nonfatal error paths are covered by `tests/frame-lifecycle.spec.ts`.

## Events

All events bubble through the host DOM and are composed, so a host can listen on
an ancestor rather than on each frame.

| Event               | Cancelable | Detail                                              |
| ------------------- | ---------- | --------------------------------------------------- |
| `v-frame-loadstart` | no         | `{ url }` for the selected entry URL.               |
| `v-frame-load`      | no         | `{ url }` when the guest is ready.                  |
| `v-frame-error`     | no         | `{ phase, url, error, fatal }`.                     |
| `v-frame-navigate`  | yes        | `{ from, to, kind, state }` before the guest moves. |
| `v-frame-navigated` | no         | `{ from, to, kind }` after the guest URL changed.   |

`kind` is one of `"link"`, `"form"`, `"window"`, `"push"`, `"replace"`,
`"traverse"`, or `"fragment"`.

`v-frame-navigate` is cancelable for the default link, form, fragment, and
window actions, and for every navigation the host starts — the one exception is
traversal in host mode, which the shell performs and cannot take back.

Both of the events that finish a load fire after the load has fully committed:
the new guest is revealed and `status` is already `"ready"`. `v-frame-navigated`
comes first (when the load moved the guest URL, for example a document
navigation or traversal) and `v-frame-load` second. A listener on either may
start another navigation or assign `src`; the new load simply supersedes the
guest that just went live. `v-frame-navigated` always fires for a load that
committed, but if its listener supersedes that load (assigns `src`, calls
`reload()`, or removes the element) the load's own `v-frame-load` is not
dispatched: it never became the settled guest.

`v-frame-navigated` is the past-tense counterpart: the guest URL is already the
new one when it fires, so `currentURL`, `canGoBack`, and `canGoForward` can be
read directly from the listener. It covers guest-initiated `pushState` and
`replaceState`, fragment navigation, traversal, and document navigation. It
reports a move through the session rather than a change of the URL string, so a
push of the route the guest is already on fires with `from === to`.

A navigation the guest asks for, such as a link click or `location.assign`, is
reported as allowed once `v-frame-navigate` was not canceled, and its load begins
on the next microtask. If another navigation, or a host `src` change, is
requested before then, the latest request wins and the earlier one is dropped as
superseded.

Error `phase` is one of `entry`, `bootstrap`, `stylesheet`, `script`, `runtime`,
`navigation`, or `network`. A fatal error ends the current load and moves the
element to `status === "error"`. Nonfatal script, stylesheet, runtime, network,
or replacement-load errors are reported without discarding a working guest —
[Limitations](./limitations.md) lists the cases that deliberately arrive this
way.

## CSP and Trusted Types

Guest execution inherits the host page's Content Security Policy. The fetched
guest document's own CSP and framing headers are not applied as a separate
policy — the guest is not in a separate browsing context, so there is nothing
for them to apply to.

Set `nonce` when the host requires one:

```html
<v-frame nonce="server-generated-nonce" src="/applications/orders/"></v-frame>
```

When the host enforces Trusted Types, allow a policy name in its CSP and put
that name on the frame:

```html
<v-frame trusted-types-policy="orders-frame" src="/applications/orders/"></v-frame>
```

```text
trusted-types orders-frame; require-trusted-types-for 'script'
```

The string form only _names_ a policy the CSP already allows. The policy it
installs returns every value unchanged and performs **no sanitization**, so it
gives the guest permission to create that policy and nothing else. It suits a
guest that is already trusted to execute. A host that needs validation or
transformation can assign a full policy definition through the property instead:

```ts
frame.trustedTypesPolicy = {
  name: "orders-frame",
  createHTML: (source) => sanitize(source),
  createScript: (source) => source,
  createScriptURL: (source) => source,
};
```

## Typing the element

`@mewhhaha/v-frame` does not augment `HTMLElementTagNameMap`: JSR rejects
published packages that declare global types. `document.querySelector("v-frame")`
therefore returns a plain `Element` until you narrow it:

```ts
import { VFrameElement } from "@mewhhaha/v-frame";

const frame = document.querySelector("v-frame");
if (!(frame instanceof VFrameElement)) {
  throw new Error("host is missing its orders v-frame");
}
frame.addEventListener("v-frame-load", (event) => event.detail.url);
```

To get the typed result from `querySelector`, `createElement`, and friends, add
the one-line augmentation to your own project:

```ts
declare global {
  interface HTMLElementTagNameMap {
    "v-frame": import("@mewhhaha/v-frame").VFrameElement;
  }
}
```

## Server entry

`@mewhhaha/v-frame/server` is documented in [SSR](./ssr.md), which holds the
complete export table. `materializeVFrameDocument(response, documentURL, options?)`
resolves to a `Response`: it buffers a `200 text/html` guest document, then
streams the rewritten markup with backpressure and cancellation (any other
response is returned unchanged). It drives the runtime's global `HTMLRewriter`,
or `options.HTMLRewriter` where there is none, and `options` also takes the
stylesheet options `fetchText(url, { signal })`, `onImportFailure` and
`onFontFace`. The guest may use any encoding the platform decodes (BOM, header
charset, then `<meta>`); the output is UTF-8. Stylesheets are fetched
concurrently, and cancelling the response aborts them through `signal`.
