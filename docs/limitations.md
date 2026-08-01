# Limitations

`v-frame` emulates a document. Emulation is never total, and the places where it
stops are deliberate: the runtime throws rather than silently doing something
other than what the guest asked for.

Everything on this page was read out of the current source and is covered by the
test suite. Each entry says what throws, why it has to, and what to do instead.

| API | Result |
| --- | --- |
| [`document.write` / `writeln` / `open` / `close`](#documentwrite-writeln-open-and-close) | `NotSupportedError` |
| [`document.adoptedStyleSheets`](#documentadoptedstylesheets-and-constructed-stylesheets) | `NotSupportedError` |
| [Direct child mutation of `document`](#direct-child-mutation-of-document) | `NotSupportedError` |
| [CSSOM `@import` rules](#cssom-import-rules) | `NotSupportedError` |
| [Non-`GET` form submission](#non-get-form-submission) | `v-frame-error`, navigation dropped |
| [`target` other than `_self` and `_blank`](#form-and-link-targets-other-than-_self-and-_blank) | Navigation dropped |
| [Non-HTTP link and form schemes](#non-http-link-and-form-schemes) | Navigation dropped |

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

## `document.adoptedStyleSheets` and constructed stylesheets

**Throws** a `NotSupportedError` `DOMException` on both read and write.

This is the limitation most likely to bite, because constructed stylesheets are
how a large amount of modern component code ships CSS — `new CSSStyleSheet()`
plus `replaceSync()` is the default output of several component compilers and
the standard pattern in hand-written web components.

**Why.** `adoptedStyleSheets` is a property of a *document or shadow root*, and
the guest has neither of the ones it appears to have. Sheets adopted onto the
realm's `Document` would style the hidden execution realm, which renders
nothing. Forwarding them to the host shadow root that actually renders the guest
is not equivalent either: that shadow root is owned by `v-frame`, which uses its
own `adoptedStyleSheets` slot for the internal top-layer and staging rules
(`src/realm/window-patches.ts`), and — more importantly — a forwarded sheet
would bypass the rewriting every other guest stylesheet goes through, so its
`html`, `body`, and `:root` selectors would never match `v-html` and `v-body`,
and its relative `url()` references would resolve against the host document
instead of the guest's URL.

Constructed stylesheets do not work on shadow roots the *guest itself* creates
either, and that failure comes from the browser rather than from `v-frame`:

```text
NotAllowedError: Failed to set the 'adoptedStyleSheets' property on 'ShadowRoot':
Sharing constructed stylesheets in multiple documents is not allowed
```

A guest node is created in the execution realm but rendered in the host
document, so a `CSSStyleSheet` built from the guest's own `CSSStyleSheet`
constructor belongs to a different document than the shadow root it is being
adopted into.

**Instead.** Ship guest CSS as `<style>` elements, or as `<link
rel="stylesheet">`. Both go through the runtime's stylesheet pipeline, which
rewrites shell selectors and rebases URLs, and both are live: mutating
`style.textContent`, `link.href`, `link.media`, or `link.disabled` re-runs the
pipeline, and `sheet.insertRule()` / `rule.selectorText` / `style.cssText`
through the CSSOM are rewritten in place.

```ts
const style = document.createElement("style");
style.textContent = ":host-ish { color: rebeccapurple; }";
document.head.append(style);
```

For a component library, this usually means selecting its `<style>`-tag CSS
delivery mode rather than its constructed-stylesheet mode.

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

## CSSOM `@import` rules

**Throws** a `NotSupportedError` `DOMException` from `CSSStyleSheet.insertRule()`
and the legacy `addRule()` when the inserted text is an `@import` rule.

**Why.** Guest CSS is rewritten before the browser ever parses it, and `@import`
is resolved by *fetching and inlining* the imported sheet so the imported rules
get the same selector rewriting and URL rebasing. That fetch is asynchronous;
`insertRule()` is synchronous and must return an index. There is no way to
honour both, so the rule is refused instead of being inserted unrewritten.

**Instead.** `@import` in the source text of a `<style>` element or a linked
stylesheet is fully supported and is inlined for you — this limitation is only
about inserting an `@import` rule through the CSSOM at runtime. If a sheet must
be added dynamically, append another `<style>` or `<link rel="stylesheet">`
element rather than importing from an existing sheet.

## Non-`GET` form submission

**Does not throw in the guest.** The submission is dropped and the host receives
a non-fatal `v-frame-error` whose `phase` is `"navigation"` and whose `error` is
a `NotSupportedError` `DOMException`. The guest stays on its current document
with `status` still `"ready"`. `v-frame-navigate` fires first, so a host that
cancels the navigation suppresses the error too.

**Why.** A guest navigation is a `v-frame` document load, and a document load is
a `fetch()` of the target URL whose result is materialized into the shadow tree.
Reproducing a `POST` navigation faithfully would mean reproducing the whole
navigate algorithm — the request body, resubmission on reload and traversal, the
`beforeunload` interaction, and the browser's own resubmission prompt — on top
of an API that has none of that state.

**Instead.** Submit with `fetch()` from the guest's own script and update the
DOM, which is what a client-rendered application does regardless of `v-frame`.
`GET` forms navigate normally, including through `<base target>`.

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
| --- | --- | --- | --- |
| 1,000 | 37 ms | 2.3 ms | 16x |
| 5,000 | 102 ms | 5.5 ms | 19x |
| 20,000 | 359 ms | 14.7 ms | 24x |
| 50,000 | 702 ms | 36 ms | 20x |

Chromium 149.0.7827.55, headless, on an AMD Ryzen 7 7800X3D, 2026-08-01. Each
cell is the median of three runs and run-to-run spread is about ±10%, so read the
slope rather than a cell; the overhead column is the noisiest of the four, because
its denominator is a few milliseconds. The stable figure is the marginal cost:
**13.6 µs per element for `v-frame`, 0.65–0.9 µs for host DOM**. Reproduce with
`pnpm bench`; the method, and the same measurement before and after the
optimization below, are in
[`node-marking-benchmark.md`](./node-marking-benchmark.md).

**Insertion into a settled guest** costs about 39 ms per 1,000 appended elements
— 39 µs each against 1.5 µs for host DOM — and is flat in the size of the tree
already there, because marking is per inserted subtree rather than per document.
Two 60 Hz frames per thousand rows is the budget to plan against.

**Re-parenting a settled subtree** — what a list does when it reorders rows —
costs about 59–78 ms per 1,000 moves of a hundred-node subtree, against 4.5–6.2 ms
for host DOM. Marking does not run again for a subtree that is already marked and
still connected, so this no longer scales with how big the moved subtree is; it
used to cost 254–297 ms.

**Retained JS heap** is about 7.5 MB for a 50,000-element guest — 39 bytes per
marked object on the 1,000→50,000 slope — against 180–490 KB for the same markup
in the host document, which never gets JS wrappers for its nodes at all. This one
is chromium-only; see [below](#what-firefox-costs).

Two rounds of work produced the numbers above. Answering `ownerDocument` and
`baseURI` from the realm's `Node.prototype` instead of from own accessors on every
node cut the marginal activation cost by about 30% (19.3 µs per element to 13.6)
and the retained heap by about 86% (52 MB to 7.5 at 50,000 elements). Skipping the
walk for a subtree that is already marked and still connected then made
re-parenting about 3.8x cheaper, without moving activation or insertion.

What is left is the walk itself, and it is not going away: visiting every node
once is irreducible for this design. No version of this runtime has activated a
large guest cheaply and none is planned.

**What that means.** A guest whose rendered DOM is a few thousand elements pays
tens of milliseconds once, which is below the noise of the network fetch in front
of it. At 20,000 elements activation is a third of a second, and at 50,000 it is
about 0.7 seconds from `src` to `v-frame-load`, most of it synchronous work on
the main thread — long enough that the choice of runtime is the dominant cost of
the page. The [SSR path](./ssr.md) moves that cost rather than removing it: the
server markup paints immediately, so the delay is before the guest is live rather
than before anything is visible, but the realm still re-parses and marks the same
tree.

**Instead.** Render pages rather than datasets — virtualize or paginate long
lists, which keeps the tree at the size the viewport implies instead of the size
the data implies. For a guest that genuinely has to materialize tens of thousands
of nodes at once, an `<iframe>` pays the browser's own parser and no facade at
all, and is the cheaper tool; the overlay and layout advantages in [the
README](../README.md#what-you-are-trading) are what you would be giving up.

### What firefox costs

The tables above are chromium. Firefox pays the same shape of cost and more of
it: the same guests, the same harness, the same machine, `pnpm bench` measuring
both engines in one run.

| guest elements | `v-frame` chromium | `v-frame` firefox | host DOM chromium | host DOM firefox |
| --- | --- | --- | --- | --- |
| 1,000 | 37 ms | 35 ms | 2.3 ms | 2 ms |
| 5,000 | 83 ms | 92 ms | 4.7 ms | 7 ms |
| 20,000 | 276 ms | 340 ms | 17 ms | 23 ms |
| 50,000 | 694 ms | 846 ms | 33 ms | 52 ms |

Firefox 151.0 and chromium 149.0.7827.55, headless, on an AMD Ryzen 7 7800X3D,
2026-08-01. All four columns come from one `pnpm bench` run, so they are
comparable to each other; they are a *different* run from the chromium table
above, which is why its cells differ by up to 20% — that is the run-to-run
spread, and it is why the ratio rather than any cell is the figure to read.

The two runs taken that day put the marginal activation cost at **16.6 µs per
element for firefox against 13.4 for chromium**, then 13.4 against 11.4. The
absolute numbers moved together with the machine; the ratio did not, at 1.24x and
1.17x. Activation on firefox is roughly a fifth dearer.

Insertion is the wider gap: about **66–79 ms per 1,000 appended elements against
chromium's 32–44** across the two runs — very close to double — and still flat in
the size of the tree already there. Re-parenting is the narrower one, 66–96 ms
against 57–91 ms, because the work the gate skips is skipped in both engines.

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
guest nodes are *released* rather than retained is covered on both engines by
[`tests/node-retention.spec.ts`](../tests/node-retention.spec.ts), which counts
survivors rather than bytes.

## What is *not* a limitation

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
- **Guest-created shadow roots.** `attachShadow()` works and the shadow tree is
  tracked by the facade; only *constructed* stylesheets on it are unavailable.
- **Dialogs, popovers, and the top layer.** Supported, including coordinate
  translation back into frame-local space; this is the main thing `v-frame` buys
  over an `<iframe>`. See [`tests/overlays.spec.ts`](../tests/overlays.spec.ts).
- **The Navigation API, History, and `location`.** Fully virtualized. See
  [Navigation](./navigation.md).
