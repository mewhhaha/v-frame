# Limitations

`v-frame` emulates a document. Emulation is never total, and the places where it
stops are deliberate: the runtime throws rather than silently doing something
other than what the guest asked for.

Everything on this page was read out of the current source and is covered by the
test suite. Each entry says what throws, why it has to, and what to do instead.

| API                                                                                                          | Result                              |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| [`document.write` / `writeln` / `open` / `close`](#documentwrite-writeln-open-and-close)                     | `NotSupportedError`                 |
| [Direct child mutation of `document`](#direct-child-mutation-of-document)                                    | `NotSupportedError`                 |
| [`Selection.modify()`](#selectionmodify)                                                                     | `NotSupportedError`                 |
| [CSSOM `@import` rules](#cssom-import-rules)                                                                 | `NotSupportedError`                 |
| [Cross-origin linked stylesheets without CORS](#cross-origin-stylesheets-require-cors)                       | `v-frame-error`, stylesheet dropped |
| [`POST` forms to `_blank`, cross-origin, or `navigation="host"`](#post-forms-outside-same-origin-guest-mode) | `v-frame-error`, navigation dropped |
| [`target` other than `_self` and `_blank`](#form-and-link-targets-other-than-_self-and-_blank)               | Navigation dropped                  |
| [Non-HTTP link and form schemes](#non-http-link-and-form-schemes)                                            | Navigation dropped                  |

During server-rendered adoption the browser starts a fresh undo history when
the live input, textarea, or rich-text editor takes over. The visitor can
continue editing the transferred draft and undo subsequent edits. An editor
that needs undo across activation can keep its own action history.
See [Server-rendered adoption](./ssr.md).

Beyond the list, three whole-runtime constraints apply: the browser must support
the Navigation API, Declarative Shadow DOM, and custom elements; every guest URL
must be same-origin `http:` or `https:`; and the guest is trusted code, not
sandboxed code. See [the README](../README.md#requirements).

One more constraint is a ceiling rather than a refusal: the runtime touches
every node the guest owns, so a large enough guest is slow enough to be the
wrong tool. See [Guest size and activation
cost](#guest-size-and-activation-cost) for the measured numbers.

## `document.write`, `writeln`, `open` and `close`

**Throws** a `NotSupportedError` `DOMException` from the guest realm, for all
four methods.

**Why.** The document the guest sees is the realm's own `Document` object with
every tree-shaped property answered from the shell elements — `documentElement`
is `v-html`, `body` is `v-body` — while the nodes themselves are rendered in the
host page's shadow root. `document.write()` is defined in terms of the HTML
parser's insertion point in a real parsed document. There is no such insertion
point here, and `document.open()` would have to discard a tree the host owns.
Implementing them approximately would corrupt the tree in ways that surface much
later than the call.

**Instead.** Use the ordinary node APIs, which are fully supported:
`element.insertAdjacentHTML()`, `element.innerHTML`, `document.createElement()`
plus `append()`. Scripts inserted this way are executed by the runtime with the
same ordering rules a real document applies.

Third-party snippets that still call `document.write` (older ad and analytics
tags) cannot run inside a guest.

## Cross-origin stylesheets require CORS

**Does not throw in the guest.** A cross-origin `<link rel="stylesheet">` or
`@import` whose server does not send `Access-Control-Allow-Origin` fails to
load, emits a non-fatal `v-frame-error` (`phase: "stylesheet"`), and fires an
`error` event on the `<link>`.

**Why.** `v-frame` must read stylesheet source text to rewrite selectors and
rebase relative URLs, so it loads linked sheets through `fetch()` rather than
letting the browser fetch an opaque stylesheet directly. Cross-origin links
without `crossorigin` default to `credentials: "omit"` (compatible with
`Access-Control-Allow-Origin: *` CDNs without leaking cookies);
`crossorigin="anonymous"` uses `"same-origin"`, and
`crossorigin="use-credentials"` uses `"include"`.

**Instead.** Serve cross-origin stylesheets with CORS headers, or proxy them
through the host origin.

## Direct child mutation of `document`

**Throws** a `NotSupportedError` `DOMException` from `document.appendChild`,
`insertBefore`, `replaceChild`, `removeChild`, `append`, `prepend`, and
`replaceChildren`.

**Why.** The virtual document's child list is synthesized — a doctype plus the
shell element — and is not the realm document's real child list. Accepting a
mutation would either edit the invisible realm document or desynchronize the
synthesized list from the tree the host renders.

**Instead.** Mutate the elements, which is what real code does anyway:
`document.documentElement`, `document.head`, and `document.body` are all live
and fully mutable.

```ts
document.documentElement.setAttribute("lang", "en");
document.head.append(meta);
document.body.append(root);
```

## Node identity after a host-realm write

**Does not throw.** Standard guest DOM mutation APIs — including `textContent`,
`insertAdjacentText`, `setHTMLUnsafe`, `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `insertAdjacentElement`, and all child/parent mutation
methods — mark newly created nodes **synchronously**.

Only nodes inserted directly through an unpatched **host-realm** prototype
(bypassing the guest realm's facade) settle a microtask later when the realm's
`MutationObserver` callback runs. A _detached_ subtree is still walked in full
when it is inserted, so building a tree offline and then inserting it marks
everything in it synchronously.

## Serialized markup and attribute order

`innerHTML`, `outerHTML`, `getHTML()` and `XMLSerializer` return the markup the
guest authored, not the tree v-frame keeps: inline `style`, `on*` handlers, a
script's `src` and `type`, a link's `rel` and relative URLs are restored from
what marking recorded. Native serialization writes attributes in the order they
were set, but v-frame only records the _values_ of those it manages, so they come
after the unmanaged attributes, in the order handlers, `style`, then `rel`. Two
serializations of the same element agree, and the markup parses back to the same
element, but `<p style="…" id="a">` serializes as `<p id="a" style="…">`.

Serializing a guest shadow root is not covered: its children are not marked, so
they are physical as the browser holds them. Text inside `<noscript>` serializes
escaped rather than raw, because the copy that is serialized lives in a document
without scripting.

## `Selection.modify()`

**Throws** a `NotSupportedError` `DOMException` from the guest realm.

**Why.** `modify()` moves the selection by rendered text: characters, words,
lines. That needs the browser's own selection and its layout, and the browser's
selection only ever holds endpoints in the host page's tree. The guest's
`Selection` is a facade over virtual endpoints, so there is nothing for the
browser to move, and silently leaving the caret where it was would make the
guest believe it had moved.

**Instead.** Compute the new endpoint from the DOM and call `collapse()`,
`extend()` or `setBaseAndExtent()`, all of which are supported.

## CSSOM `@import` rules

**Throws** a `NotSupportedError` `DOMException` from `CSSStyleSheet.insertRule()`
and the legacy `addRule()` when the inserted text is an `@import` rule.

**Why.** Guest CSS is rewritten before the browser ever parses it, and `@import`
is resolved by _fetching and inlining_ the imported sheet so the imported rules
get the same selector rewriting and URL rebasing. That fetch is asynchronous;
`insertRule()` is synchronous and must return an index. There is no way to
honour both, so the rule is refused instead of being inserted unrewritten.

**Instead.** `@import` in the source text of a `<style>` element or a linked
stylesheet is fully supported and is inlined for you — this limitation is only
about inserting an `@import` rule through the CSSOM at runtime. If a sheet must
be added dynamically, append another `<style>` or `<link rel="stylesheet">`
element rather than importing from an existing sheet.

## `POST` forms outside same-origin guest mode

Same-origin `method="post"` forms in `navigation="guest"` mode (with
`application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`)
are submitted via `fetch()`, follow Post-Redirect-Get redirects, and render the
resulting HTML document into the frame. `method="dialog"` forms keep their
native dialog-closing behavior, including through `form.submit()`.

**What stays unsupported:** `POST` submissions targeting `_blank`, cross-origin
actions, or frames in `navigation="host"` mode (where top-level host navigation
uses `location.assign()`). Those drop the submission and emit a non-fatal
`v-frame-error` (`phase: "navigation"`, `NotSupportedError`) unless canceled via
`v-frame-navigate`. Also, reloading a direct `200 text/html` `POST` response
performs a `GET` reload rather than showing a browser resubmission prompt; use
Post-Redirect-Get (303/302) for idempotent reloads.

## `window.open` popups have no opener

**Does not throw.** `window.open(url, "_blank")` opens a real new browsing
context for `http:`, `https:`, and explicit `about:blank` URLs, always with
`noopener` added to the features, so the popup's `window.opener` is `null` and
the guest receives `null` back instead of a `Window`. Arguments are coerced like
the native signature (`null` is the string `"null"`, `""` is `about:blank`), and
an unparsable URL throws a `SyntaxError`. Other non-HTTP schemes report through
`v-frame-navigate` and return `null` without opening natively unless the host
handles the event explicitly.

**Why.** The guest's `window` is the hidden realm window. A popup holding it as
`opener` could reach the realm's real, unvirtualized globals.

**Instead.** Open popups from the host: listen for `v-frame-navigate` with
`kind === "window"`, cancel it, and call `window.open` yourself.

## Form and link targets other than `_self` and `_blank`

**Does not throw.** `_self` (or no target) navigates the frame. `_blank` opens a
real new browsing context through `window.open(url, "_blank", "noopener")`, and
for a non-`GET` form reports the `NotSupportedError` above. Every other target —
`_parent`, `_top`, and any named target — reports the destination through the
cancelable `v-frame-navigate` event and is then dropped.

**Why.** `_parent` and `_top` name browsing contexts, and a `v-frame` guest is
not in one: the frame is a subtree of the host page, so honouring `_top` would
mean navigating the host away, which is the shell's decision and not the guest's.
Named targets require a window name registry that does not exist for a guest.

**Instead.** A host that wants those targets to mean something can implement
them itself from the `v-frame-navigate` event, which carries `from`, `to`,
`kind`, and `state`:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  // Treat what the guest asked for as a request, and route the shell.
  router.navigate(event.detail.to);
});
```

Use `navigation="host"` when the shell should own guest routing outright. See
[Navigation](./navigation.md).

## Non-HTTP link and form schemes

**Does not throw.** A link or form action whose scheme is not `http:` or
`https:` — `mailto:`, `tel:`, `blob:`, a custom protocol handler — reports the
destination through `v-frame-navigate` and is then dropped. The imperative
`frame.navigate()` rejects instead, with a `TypeError`:

```text
TypeError: v-frame route "mailto:someone@example.com" must use http: or https:, received mailto:
```

`frame.navigate()` rejects with a `TypeError` for a cross-origin route as well;
guest URLs must share the host origin.

**Why.** Everything the runtime does with a URL — resolving it against the guest
base, fetching the document, rebasing assets — assumes a fetchable same-origin
HTTP URL. External schemes are not fetchable and their handling belongs to the
host page, which is where the user's window actually is.

**Instead.** Handle them from `v-frame-navigate` in the host:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  const destination = new URL(event.detail.to);
  if (destination.protocol === "mailto:") {
    location.href = destination.href;
  }
});
```

## Dynamic or bare-specifier inline module imports

Initial `defer` and module scripts execute in document order, as in a real
document. External scripts and top-level static URL imports (`./`, `../`, `/`,
`http:`, `https:`) inside inline `<script type="module">` blocks are preloaded
when the initial pass starts, so their fetches overlap while execution stays
chained. Bare import-map specifiers and dynamic `import()` calls inside an
inline module are still discovered only when that script runs.

## WebKit can cancel a module shared by two frames

When two same-origin frames import the same JavaScript module concurrently,
removing the frame that started the request can make the other frame's import
reject. This also occurs with native iframes. During a swap, keep the outgoing
frame connected until the incoming application signals that its startup imports
have completed. A framework can start these imports after `v-frame-load`.
Preloading a shared chunk from the host can protect that request while other
dependencies are still vulnerable to cancellation.

## `history.go(0)` never reloads

`history.go()`, `go(0)`, and any delta that coerces to zero (`NaN`, a non-numeric
string, `0.9`) do nothing in both navigation modes. A real document reloads;
a guest cannot, because in host mode that would reload the shell page. Use
`location.reload()` (which `v-frame` forwards) or `frame.reload()`.

## Guest size and activation cost

**Does not throw.** Nothing refuses a large guest. A guest costs in proportion to
how many nodes it has, at a rate that is inherent to emulating a document, and
past some size that rate is itself the reason not to use `v-frame`.

**Why.** Before a guest node renders it has to be marked: added to the
virtual-node set that the realm's prototype accessors are gated on, plus the
attribute, URL and event-handler work marking has always done. The facade cannot
decide a node is virtual without touching it, so activation walks the whole guest
tree and every later insertion walks the subtree it inserts. Plain host DOM does
none of that, and Blink never materializes a JS wrapper for a node nobody has
touched. Moving a subtree that is already in the tree is the one case that
escapes: it was marked when it arrived, and none of the answers marking installs
depend on where it hangs.

**Activation** — fetch, parse and insert the whole guest, both columns including
the fetch and the parse. "Plain host DOM" is the same markup fetched,
`DOMParser`-parsed and adopted into the host tree.

| guest elements | `v-frame` | plain host DOM | overhead |
| -------------- | --------- | -------------- | -------- |
| 1,000          | 36.0 ms   | 1.8 ms         | 20.0x    |
| 5,000          | 59.4 ms   | 4.2 ms         | 14.1x    |
| 20,000         | 129.3 ms  | 12.4 ms        | 10.4x    |
| 50,000         | 273.6 ms  | 29.7 ms        | 9.2x     |

Chromium 153.0.8010.12, headless, on an AMD Ryzen 7 7800X3D, 2026-11-27. Each
cell is the median of three runs and run-to-run spread is about ±10%, so read the
slope rather than a cell; the overhead column is the noisiest of the four, because
its denominator is a few milliseconds. The stable figure is the marginal cost:
**4.77 µs per element for `v-frame`, 0.57 µs for host DOM** (`~8.4x` raw load;
**`1.9x`** through first geometry read at 50k elements, or **`0.64x`** / `95 ms`
with opt-in `lazy-attributes`, `lazy-events`, and `content-visibility="auto"`).
Reproduce with `pnpm bench`; the method, and the measurements across all ten
rounds of optimization, are in
[`node-marking-benchmark.md`](./node-marking-benchmark.md).

**Insertion into a settled guest** costs about 7.4–8.4 ms per 1,000 appended
elements default (~5.8 ms with `lazy-attributes` + `lazy-events`) — roughly
7–8 µs each against 1.3–1.5 µs for host DOM (5–6x) — and is flat in the size of
the tree already there, because marking is per inserted subtree rather than per
document.

**Re-parenting a settled subtree** — what a list does when it reorders rows —
runs at roughly 1.8–2.6x the cost of plain host DOM for 1,000 moves of a
hundred-node subtree (down from roughly 50–80x originally). Marking does not run
again for a subtree that is already marked and still connected, and the single
realm mutation observer tracks connected special elements in a bounded index so
pure single-node self-moves skip subtree scans and observer churn. The absolute
milliseconds move with machine load — run `pnpm bench` for a figure on your own
hardware; the ratio is what holds across runs.

**Retained JS heap** is about 8 MB default (`~3.7 MB` with `lazy-attributes` +
`lazy-events`) for a 50,000-element guest against 114–490 KB for the same markup
in the host document, which never gets JS wrappers for its nodes at all. This
one is chromium-only; see [below](#what-firefox-costs).

Ten rounds of optimization produced the numbers above, culminating in pooled
`innerHTML` parser contexts, zero-allocation bubbling event boundaries,
monomorphic attribute patches, synchronous detached-watch eviction, native
selector unions, zero-dependency CSS rewriting, and opt-in `lazy-attributes`,
`lazy-events`, `content-visibility="auto"`, deferred `adopt`, and
`VFrameElement.prewarm()`. See
[`node-marking-benchmark.md`](./node-marking-benchmark.md) for the full round-by-round breakdown.

What is left is the walk itself, and it is not going away: visiting every node
once is irreducible for this design. No version of this runtime has activated a
large guest cheaply and none is planned.

**What that means.** A guest whose rendered DOM is a few thousand elements pays
tens of milliseconds once, which is below the noise of the network fetch in front
of it. At 20,000 elements activation is ~0.13 seconds, and at 50,000 it is ~0.27
seconds from `src` to `v-frame-load` default (~95 ms through first geometry with
`lazy-attributes`, `lazy-events`, and `content-visibility="auto"`), most of it
synchronous work on the main thread — long enough that the choice of runtime is
a major cost of the page. The [SSR path](./ssr.md) moves that cost rather than
removing it: the server markup paints immediately, so the delay is before the
guest is live rather than before anything is visible, but the realm still
re-parses and marks the same tree.

**Instead.** Render pages rather than datasets — virtualize or paginate long
lists, which keeps the tree at the size the viewport implies instead of the size
the data implies. For a guest that genuinely has to materialize tens of thousands
of nodes at once, an `<iframe>` pays the browser's own parser and no facade at
all, and is the cheaper tool; the overlay and layout advantages in [the
README](../README.md#trade-offs--when-to-use-v-frame) are what you would be giving up.

### What firefox costs

The tables above are chromium. Firefox pays the same shape of cost and slightly
more of it on insertion: the same guests, the same harness, the same machine,
`pnpm bench` measuring chromium and firefox in one run (WebKit is not
benchmarked).

| guest elements | `v-frame` chromium | `v-frame` firefox | host DOM chromium | host DOM firefox |
| -------------- | ------------------ | ----------------- | ----------------- | ---------------- |
| 1,000          | 36.0 ms            | 31.0 ms           | 1.8 ms            | 2.0 ms           |
| 5,000          | 59.4 ms            | 51.0 ms           | 4.2 ms            | 5.0 ms           |
| 20,000         | 129.3 ms           | 127.0 ms          | 12.4 ms           | 16.0 ms          |
| 50,000         | 273.6 ms           | 299.0 ms          | 29.7 ms           | 38.0 ms          |

Firefox 155.0 and chromium 153.0.8010.12, headless, on an AMD Ryzen 7 7800X3D,
2026-11-27. All four columns come from one `pnpm bench` run, so they are
comparable to each other. Marginal activation cost is **~5.5 µs/element** on
firefox (`~7.5x` host DOM; `1.8x` through first geometry, or `0.85x` / `139 ms`
with opt-in `lazy-attributes`, `lazy-events`, and `content-visibility="auto"`)
vs **4.77 µs/element** on chromium.

Insertion is the wider gap: **18 ms per 1,000 appended elements on firefox
default (`12 ms` with `lazy-attributes` + `lazy-events`) against chromium's
7.4–8.4 ms (`5.8 ms` lazy)** (down from 66–79 ms originally) — still flat in the
size of the tree already there. Re-parenting tracks chromium closely at
**11–25 ms** (`1.4–2.8x` host DOM, down from 66–96 ms originally), because the
settled-move fast path skips the same work in both engines.

Every firefox reading above is a whole millisecond, and that is the clock rather
than a coincidence: 20 consecutive `performance.now()` calls in a Playwright
firefox page all return integers, where chromium returns tenths of a microsecond.
The coarsening is invisible in the 50,000-element cells and dominant in the
host-DOM ones, where the true value is a couple of milliseconds.

**Retained heap is not measured on firefox at all.** The reading needs a
collected heap size, which Playwright can only get through CDP's
`Runtime.getHeapUsage`; `performance.measureUserAgentSpecificMemory` is
chromium-only as well. What firefox retains for a large guest is therefore
unknown, and the 7.5 MB above should not be read as a cross-engine number. That
guest nodes are _released_ rather than retained is covered in the chromium, firefox
and webkit projects by
[`tests/node-retention.spec.ts`](../tests/node-retention.spec.ts), which counts
survivors rather than bytes.

## What is _not_ a limitation

These come up often enough to be worth stating explicitly, because earlier
versions of this runtime did restrict some of them:

- **`XMLHttpRequest` username and password.** `open(method, url, async, user,
password)` forwards all five arguments to the native implementation. Synchronous
  XHR works too.
- **`credentials`.** The `credentials` attribute applies to the entry document
  and stylesheet requests `v-frame` itself issues, and supplies a default for
  guest requests that do not pick one. It never blocks the guest, which is
  same-origin and can pass any credentials mode it likes. It is not a security
  boundary. See [the API reference](./api.md#configuration).
- **`@import` in stylesheet source.** Supported and inlined; only the CSSOM path
  above is refused.
- **`<link rel="stylesheet">`.** Supported, including `media`, `disabled`, and
  `href` changes at runtime.
- **`document.adoptedStyleSheets` and guest shadow roots.** Both work.
  `window.CSSStyleSheet` is bridged to host-document stylesheets defaulting to
  the guest's base URL, so `shadowRoot.adoptedStyleSheets` works directly in
  guest components (Lit, Shoelace, FAST), and sheets adopted onto
  `document.adoptedStyleSheets` are mirrored into the render shadow root with
  shell selector rewriting (`html`/`body`/`:root`), `:host` neutering, and URL
  rebasing (including live updates from `replaceSync`, `replace`, `insertRule`,
  `deleteRule`, `addRule`, `disabled`, and observable array mutations).
- **Same-origin `POST` forms (`navigation="guest"`).** `application/x-www-form-urlencoded`,
  `multipart/form-data`, and `text/plain` submissions run via same-origin
  `fetch()`, follow PRG redirects, and materialize the HTML response into the
  frame.
- **Synchronous marking on `textContent`, `insertAdjacentText`, and `setHTMLUnsafe`.**
  Nodes created by these APIs join the virtual tree synchronously rather than
  waiting for the mutation observer microtask.
- **Page visibility.** `document.hidden`, `document.visibilityState`, and
  `visibilitychange` mirror the host document.
- **Dialogs, popovers, and the top layer.** Supported, including coordinate
  translation back into frame-local space; this is the main thing `v-frame` buys
  over an `<iframe>`. See [`tests/overlays.spec.ts`](../tests/overlays.spec.ts).
- **The Navigation API, History, and `location`.** Fully virtualized. See
  [Navigation](./navigation.md).
