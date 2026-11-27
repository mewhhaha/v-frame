# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.0 - 2026-11-27

### Added

- Five opt-in Tier C performance modes on `<v-frame>` (100% backwards-compatible;
  default `0.6.0` behavior is unchanged when omitted):
  - **Deferred SSR activation (`adopt="visible" | "idle" | "interaction"`,
    `frame.adoptMode`, `frame.activate()`):** Keeps Declarative Shadow DOM
    previews painted with zero iframe creation, zero JS boot, and zero entry
    fetches until intersecting the viewport (`IntersectionObserver`), browser
    idle (`requestIdleCallback` with `setTimeout` fallback), first user
    interaction on the preview (preserving typed form drafts and blocking
    accidental host link/form navigation while activating), or an imperative
    `frame.activate()` call. Boolean `frame.adopt` and eager `<v-frame adopt>`
    remain unchanged.
  - **Lazy `Attr` node identity (`lazy-attributes` / `frame.lazyAttributes`):**
    Skips eager `NamedNodeMap`/`Attr` materialization during initial marking,
    subtree walks, and `setAttribute`/`setAttributeNS` writes. Guest `Attr`
    APIs (`getAttributeNode`, `getAttributeNodeNS`, `attributes`,
    `removeAttributeNode`, and live `NamedNodeMap`s once observed) mark on
    demand, and `Attr.prototype` (`ownerDocument`, `baseURI`, `getRootNode`)
    checks `ownerElement` with WebIDL brand validation.
  - **Lazy exotic `Event` subclass patching (`lazy-events` / `frame.lazyEvents`):**
    Eagerly forwards `Event.prototype` plus 24 core DOM/UI Event interfaces and
    lazily forwards exotic native guest/host `Event` subclasses on first
    delivery (restoring lazily patched prototypes cleanly on disposal).
  - **Blocking script preloading (`preload-scripts` / `frame.preloadScripts`):**
    Boolean `preload-scripts` concurrently preloads discovered blocking classic
    external scripts via `<link rel="preload" as="script">` while preserving
    strict document execution order; space-separated URLs or a string array
    (`preload-scripts="/a.js /b.js"`) also emit host `<link rel="preload">`
    hints immediately in parallel with entry HTML fetch and realm boot,
    cleaning them up on load or abort.
  - **Offscreen rendering optimization (`content-visibility="auto"` or CSS
    selector / `frame.contentVisibility`):** Injects a zero-specificity
    `:where(...){content-visibility:auto;contain-intrinsic-block-size:auto 300px}`
    rule into the frame's internal stylesheet (skipping metadata, top-layer
    `<dialog>`/`[popover]`, and single app-root wrappers in `"auto"` mode),
    validated via `rewriteCSSOMSelectorText` + `matches()` + single-rule
    `insertRule` and updatable live without reloading the guest.
- Exported `VFrameAdoptMode` and `VFramePreloadScripts` types from
  `@mewhhaha/v-frame`.

### Changed

- Expanded `pnpm bench` (`bench/mark-virtual-node.ts`) with a Tier C opt-in
  comparison table reporting post-mount, pre-enumeration collected JS heap
  alongside activation, through-geometry, insertion, and hot-path timings:
  - **Chromium 153 (AMD Ryzen 7 7800X3D):** `lazy-events` reduced 1k cold mount
    from `36.0 → 27.8 ms` (`-23%`) and pre-enumeration JS heap from
    `3,840 → 1,628 KB` (`-58%`). At 50k elements, `lazy-attributes` +
    `lazy-events` cut activation from `273.6 → 225.0 ms` (`-18%`), 1k insertion
    from `8.7 → 7.1 ms` (`-18%`), and pre-enumeration JS heap from
    `8,119 → 3,708 KB` (`-54%`). Adding `content-visibility="auto"` reduced 50k
    activation through geometry to **`96.5 ms`** (`-65%`, faster than 50k plain
    host DOM geometry at `141.7 ms`).
  - **Firefox 155:** At 50k elements, `lazy-attributes` + `lazy-events` reduced
    1k insertion to **`15.0 ms`**, and adding `content-visibility="auto"`
    reduced 50k activation through geometry to **`173.0 ms`** (faster than 50k
    plain host DOM geometry at `189.0 ms`).
  - Bundle size: `78.6 KB` gzipped (`98%` of the `80 KB` budget).

## 0.6.0 - 2026-11-27

### Changed

- Optimized real-world DOM queries, CSSOM reads, markup parsing/serialization,
  cold facade setup, Firefox foreign-node identity, mutation-observer indexing,
  and repeated detached-subtree re-attachment (Round 6):
  - **Selectors & CSSOM (`src/facade/collections.ts`, `src/realm/dynamic-styles.ts`,
    `src/css.ts`):** Combined shell-translated selectors into a single native
    `${selectors}, ${translated}` query when syntax-safe (`canCombineSelector`)
    so `querySelector`, `querySelectorAll`, `matches`, and `closest` return
    native results in one engine pass (also aligning `closest(":scope")` and
    returned `NodeList` brand checks with native DOM); guarded empty nested
    `CSSRuleList` walks on `.sheet` reads; and added a bounded LRU cache for
    import-free stylesheet and constructed-sheet rewrites keyed by base URL.
  - **Markup, attributes & insertions (`src/facade/markup.ts`,
    `src/facade/attributes.ts`, `src/facade/insertion.ts`,
    `src/facade/marking.ts`, `src/facade/node-patches.ts`):** Reused a shared
    lazy inert HTML document across markup parsing and style probes, fused
    `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`setHTMLUnsafe` fragment
    parsing with insertion into a single walk, skipped `authoredCopy` cloning
    when a serialized subtree has no virtual attribute overrides, fast-rejected
    ordinary attribute names before URL-capability lookups, fast-pathed freshly
    created built-in HTML elements, plain marked leaf elements, and primitive
    empty-node `textContent` writes, and added `Attr.prototype.baseURI` and
    `Attr.prototype.getRootNode` owner-element fallbacks.
  - **Cold boot, teardown, SSR & Firefox (`src/facade/events.ts`,
    `src/facade/context.ts`, `src/facade/document.ts`, `src/markup.ts`,
    `src/realm/index.ts`, `src/realm/window-patches.ts`,
    `src/realm/adoption-state.ts`, `src/enumerable-weak.ts`, `src/network.ts`):**
    Cached per-host-window Event member and handler plans, shared one
    `boundaryRelay`, lazily allocated the top-layer popover stylesheet in its
    original cascade slot, skipped redundant `adoptNativeShape` and
    `getOwnPropertyDescriptor` calls, narrowed initial URL-attribute scans and
    reused collected initial `<style>`/`<link>`/`<base>` elements (clearing
    bootstrap arrays after mount so removed nodes collect cleanly), memoized
    ancestor clip bounds in SSR lazy-image visibility checks, switched teardown
    to one-pass `EnumerableWeakSet`/`EnumerableWeakMap.drain()`, and replaced
    per-node foreign descriptor Maps/closures with a shared `compactForeignNodes`
    fast path for Gecko/WebKit foreign wrappers.
  - **Observer indexing & clean detached-subtree watching
    (`src/realm/mutation-observer.ts`, `src/facade/marking.ts`,
    `src/facade/tree-patches.ts`):** Added an O(1) `<base>` counter with
    synchronous pre-read flushing, inline retirement of clean facade additions
    and transient remove+reconnect pairs, automatic special-index overflow
    recovery, `onDisconnectedNodes` skipping on special-free removals, and a
    capped GC-safe clean-subtree `MutationObserver` armed after a clean full
    walk so unchanged multi-node branches skip re-walking in O(1) while any
    mutation falls back to the full walk.
  - **Expanded `pnpm bench` (`bench/mark-virtual-node.ts`):** Added
    through-geometry activation measurements (forcing layout on both `v-frame`
    and host DOM) plus a 9-operation real-world DOM micro-benchmark suite on the
    5,000-element guest.
  - In idle `pnpm bench` runs on an AMD Ryzen 7 7800X3D:
    - **Chromium 153:** marginal activation fell below 5 µs/element to
      **`4.97 µs/element`** (`280.4 ms` at 50k; **`1.9x`** host DOM through
      first geometry read), 1,000-row insertion fell to **`7.7–8.6 ms`**
      (`-20%`), 1,000 re-parents fell to **`12.4–28.6 ms`** (`1.8–2.6x` host),
      `querySelector("body .row")` sped up **18x** (`23.8 → 1.3 ms`),
      `.sheet` 500-rule reads sped up **74x** (`37.1 → 0.5 ms`), `innerHTML =`
      sped up **3.6x** (`39.0 → 10.8 ms`), `innerHTML` get sped up **3.9x**
      (`5.9 → 1.5 ms`), `querySelectorAll("body .row")` sped up **3.1x**
      (`76 → 24.5 ms`), and `getAttribute` sped up **1.8x** (`12.0 → 6.6 ms`).
    - **Firefox 155:** 50k activation dropped below 300 ms to **`299.0 ms`**
      (`5.47 µs/element`, **`1.8x`** host DOM through geometry), 1,000-row
      insertion fell to **`18–19 ms`** (`-28%`), 1,000 re-parents fell to
      **`11–25 ms`** (`1.4–2.8x` host, `-32%` at 50k),
      `querySelector("body .row")` sped up **63x** (`127 → 2.0 ms`),
      `innerHTML` get sped up **18x** (`18 → 1.0 ms`), `.sheet` reads sped up
      **21x** (`21 → 1.0 ms`), detached 100-node re-attach sped up **5.4x**
      (`27 → 5.0 ms`), `querySelectorAll("body .row")` sped up **2.6x**
      (`66 → 25.0 ms`, `1.7x` host), and `innerHTML =` sped up **2.4x**
      (`55 → 23.0 ms`).

## 0.5.0 - 2026-11-26

### Added

- Opt-in `VFrameElement.prewarm(targetDocument?)` static helper that prewarms a
  single pristine hidden `about:srcdoc` execution iframe per host document and
  atomically claims it into the next `<v-frame>` via
  `ShadowRoot.prototype.moveBefore` (with automatic fallback when unsupported,
  disposal cleanup returning a GC-safe disposer, `pagehide` teardown, and
  automatic invalidation if the spare is reloaded, reparented, or removed).

### Changed

- Optimized initial markup preparation, initial marking, steady-state DOM
  mutations, re-parenting, and cold realm boot (Rounds 4 and 5):
  - Replaced full-tree `querySelectorAll("*")` walks and multi-pass string
    slicing in `src/markup.ts` with single-pass ASCII lowercasing, chunked style
    neutralization, targeted queries, and a packed feature bitmask.
  - Added an ownership-only initial walk (`markInitialOwnershipFast` /
    `markInitialOwnershipWithEvents`) guarded by `hasAttributes()` with targeted
    post-walk special-element initialization, fast-pathed freshly created
    elements and unmanaged attributes, and pooled insertion `SubtreeScan`
    buffers.
  - Replaced settled re-parent subtree queries with a bounded passive
    special-element index and pure single-node self-move fast path on the
    single realm `MutationObserver` (re-arming the observer's native microtask
    delivery slot for non-pure records so stylesheet edits preserve their async
    ordering), and skipped subtree scan collection on disconnected appends when
    no nonce is configured.
  - Overlapped entry HTML decoding with realm iframe connection, cached pristine
    guest realm `Event` constructor names across mounts, and ran
    `history.replaceState` synchronously after `document.close()` on engines
    that dispatch `readystatechange("complete")` synchronously (yielding one
    task on engines like Firefox that defer it).
  - In idle `pnpm bench` runs on an AMD Ryzen 7 7800X3D, Chromium 153 marginal
    activation cost dropped from `10.30` to **`5.20 µs/element`** (`8.6x` host
    DOM; 50k elements in **`294.4 ms`**), 1,000-row insertion fell to
    **`9.4–10.8 ms`** (`5.9–7.2x`), and 1,000 settled subtree re-parents fell to
    **`14.1–29.5 ms`** (`2.9–4.3x`). Firefox 155 50k activation fell to
    **`338 ms`** (`6.24 µs/element`, `8.1x`), 1,000-row insertion fell to
    **`25–26 ms`**, and 1,000 re-parents fell to **`14–37 ms`** (`2.5–6.2x`).
    Opt-in `VFrameElement.prewarm()` cut warm empty/1k mount latency by
    `16–18%` in Chromium (`6.3 → 5.3 ms` / `10.0 → 8.2 ms`) and `7–22%` in
    Firefox (`9 → 7 ms` / `15 → 14 ms`).

### Fixed

- Recomputing the document base URL after mounting now picks up `<base>`
  elements added or removed natively by host custom-element
  `connectedCallback`s during initial connection.
- Custom Trusted Types `createHTML` policies that rewrite fetched HTML
  containing neutralized `<style>` elements now still restore and rewrite those
  styles.

## 0.4.0 - 2026-11-26

### Added

- Support for `document.adoptedStyleSheets` with observable array mutations,
  mirrored shadow-root stylesheets with shell selector rewriting and URL
  rebasing, and live CSSOM updates (`replaceSync`, `replace`, `insertRule`,
  `deleteRule`, `addRule`, `disabled`).
- Same-origin `POST` form submissions in `navigation="guest"` mode for
  `application/x-www-form-urlencoded`, `multipart/form-data`, and `text/plain`,
  following PRG redirects and rendering HTML responses into the frame.
- Static URL `import` preloading (`<link rel="modulepreload">`) for inline
  `<script type="module">` blocks.
- Synchronous virtual node marking for `textContent`, `insertAdjacentText`, and
  `Element.prototype.setHTMLUnsafe` / `ShadowRoot.prototype.setHTMLUnsafe`.

### Changed

- Replaced `css-tree` with a zero-dependency CSS Syntax Level 3 tokenizer and
  rewriter (`src/css.ts`), reducing the browser runtime bundle (`dist/index.js`)
  by ~11 KB gzip (`78.7 KB` → `67.7 KB`).
- Captured native DOM walkers before facade patching, added selector translation
  fast paths and caching, collapsed insertion bookkeeping into a single-pass
  subtree scan, moved reflected HTML URL properties onto realm prototypes, made
  CSSOM installation lazy on first `.sheet` / `document.styleSheets` access,
  added an inline-style non-URL fast path, and microtask-batched inline-style
  finalizer cleanup — cutting insertion latency ~2x and re-parenting latency
  2–3x in Chromium benchmarks.

## 0.3.0 - 2026-11-26

### Added

- `@mewhhaha/v-frame/testing` provides zero-dependency shadow-piercing Testing
  Library–style queries (`shadowScreen`, `withinShadow`, `withinFrame`,
  `queryShadow`, `queryAllShadow`, `activeShadowElement`, `waitFor`,
  `prettyShadowDOM`), `resetChannels()`, and `defineMockVFrame()` for
  cross-application and shell unit tests.
- `VFrameElement.whenReady()` returns a promise that resolves when the frame is
  ready or rejects on a fatal load error or disconnect.
- `@mewhhaha/v-frame/channel` adds `get()`, `clear()`, and `{ signal }` support
  on `subscribe()`.
- `composeFrames` accepts `timeoutMs`, `onSlotError`, and resource limits
  (`maxDocumentBytes`, `maxStylesheetBytes`, `maxStylesheets`, `maxImportDepth`,
  `maxConcurrency`), and deduplicates `@font-face` rules across sibling frames.
- `@mewhhaha/v-frame/server` exports `balanceTemplateTags` for custom adapters.
- `@mewhhaha/v-frame/channel` lets separately bundled guests and the host
  exchange typed messages on one page and replay a selected value at startup.

- `composeFrames(shell, { request, fetchGuest })` renders a host's frame declarations
  through its existing public route handler. Nested applications can compose their
  own guests, and an unavailable service leaves healthy siblings interactive.

### Changed

- `trusted-types-policy="name"` (the string form) now keeps browser Trusted
  Types enforcement active on guest `innerHTML`, `outerHTML`, and
  `insertAdjacentHTML` sinks while preserving genuine `TrustedHTML` values.
- `materializeVFrameDocument`'s default stylesheet fetcher now requires
  same-origin HTTP(S) URLs, uses manual redirects, and enforces default document
  and stylesheet resource budgets.
- `frame.shadowRoot` follows the visible guest document. Read it again after
  `v-frame-load` when inspecting content across navigation.

### Fixed

- Clicking a link inside a nested `<v-frame>` now navigates only the owning
  inner frame instead of being hijacked by an ancestor `<v-frame>`'s capture
  listener.
- Hardened SSR materialization against Declarative Shadow DOM `</template>`
  breakout, forged guest `data-v-frame-*` markers, inert `<template>` stylesheet
  fetches, unmaterialized `<style>` nonce propagation, and `HTMLRewriter` entity
  double-escaping.
- Rewrote CSS Nesting Level 1 nested rules, stripped non-font `@layer`
  statements from extracted `@font-face` CSS, and fixed HTML5 scanner edge cases
  (abrupt comments, foreign CDATA/self-closing tags, and `<script>` escaped
  states).
- Stopped stamping the host's CSP `nonce` onto `<style>` elements and `on*`
  handlers parsed from `innerHTML`, `outerHTML`, and `insertAdjacentHTML`.
- Bridged `window.CSSStyleSheet` so guest ShadowRoots can use
  `adoptedStyleSheets`, mirrored host `document.hidden`/`visibilityState` and
  `visibilitychange`, scoped popover viewport tracking to open popovers without
  clobbering guest `translate` with `!important`, forwarded `crossorigin` and
  `referrerpolicy` on client stylesheet fetches (defaulting cross-origin sheets
  to `credentials: "omit"`), validated host-mode native location schemes, and
  capped synchronous channel re-entrancy with guest-scoped subscriber error
  reporting.

- Subscribers see same-topic updates in publication order, including when a
  listener publishes the next update before returning. A retiring guest's
  cleanup callbacks can no longer change the page's retained selection.
- Fetched guest images resolve against the guest's base URL before the browser
  starts loading them, including during reloads.
- The Qwik example's account menu and article link work from server-rendered
  HTML. Removing either surface during startup leaves the composer's imports alone.
- GET forms accept controls named `method`, `action`, or `target`.
- SSR handoff keeps deleted mentions out of rich-text drafts, preserves fields
  alongside controls named `children`, and avoids copying drafts between
  repeated names. Numeric editing starts when the live input is ready.

- During adoption and reload, native form ownership, labels, datalists, radios,
  popover targets and named disclosures resolve within each guest, including
  during framework layout effects.
- SSR handoff preserves scroll on reordered panels and restores edits and focus
  only to the matching field in its original form and shadow tree.
- Pending activation preserves rich-text edits and their selection, recognizes
  uniquely named replacement forms, and notifies only the selected radio.
- Later keyboard or focus interaction in the shell cancels pending guest focus.
- Replacing a guest keeps input, scrolling, and modal interactions with the visible
  document until the new one takes over. Cleanup can remove or navigate the frame.
- Server previews defer guest navigation and inline handlers, and stylesheet
  rewriting honors integrity metadata. Hosts can require a complete HTML
  response for composition and cancel outstanding work.
- Client navigation now validates and decodes HTML consistently with SSR.
  Nested guest text selection and sending an XHR after teardown are covered in WebKit.
- JSR publication no longer fails on the ambient `css-tree` subpath declarations;
  a module-scoped adapter preserves their types and lightweight runtime imports.

## 0.2.0 - 2026-10-08

### Changed

- **Breaking:** `materializeVFrameDocument` resolves to a `Response` instead of
  returning one, transforms only `200 text/html` responses (anything else passes
  through untouched), strips validator, range and encoding headers from the
  rewritten body, and accepts `options.HTMLRewriter` for runtimes without a
  global one. The module is `src/server/html-rewriter.ts`; it buffers the guest
  document and streams the rewritten markup with backpressure and cancellation.
- **Breaking:** removed the `VFrameStatusValue` type alias (`VFrameStatus` is
  both the value and the type) and `VFrameLoadStartEventDetail` (use
  `VFrameLoadEventDetail`).
- `v-frame-navigated` and `v-frame-load` fire after the guest is revealed and
  `status` is `ready`, so listeners may start another navigation.
- Attribute changes that keep the effective configuration (an invalid
  `credentials` value, removing `navigation="guest"`) no longer reload the
  guest; `connectedMoveCallback` keeps the guest alive across `moveBefore()`.
- `Selection.modify()` throws `NotSupportedError` instead of doing nothing.
- Bootstrap fails loudly, as a `bootstrap` `v-frame-error`, when constructable
  stylesheets are missing or a viewport property cannot be virtualized.
- `build` no longer typechecks first; `pnpm check` runs exactly the CI pipeline.
- **Breaking:** `reload()` settles with the load it starts: it rejects with
  `AbortError` when superseded or removed, and with `InvalidStateError` when the
  frame is disconnected or has no `src`. `navigate()`, `back()`, `forward()` and
  `go()` reject with `InvalidStateError` while a replacement document is loading.
- **Breaking:** `StylesheetFetch` is `(url, { signal })` and
  `createStylesheetContext` takes an optional `AbortSignal`; the materializer
  passes its own, so cancelling the response aborts custom fetches too.
- The materializer decodes non-UTF-8 guests (BOM, header, `<meta>` prescan) and
  emits UTF-8, marks the styles it materialized (`data-v-frame-materialized`),
  fetches linked stylesheets and sibling `@import`s concurrently, and exports
  the linked-stylesheet wire constants for hosts with their own HTML parser.
- `window.open()` popups are always opened with `noopener`; host-mode
  `history.go()` with a zero or non-numeric delta no longer reloads the host page.
- Node `>=22.18` (`devEngines`) runs the dev scripts; `pnpm check:fast` and
  `pnpm test:e2e:chromium` give a quick local loop, and CI runs pushes to `main`
  and pull requests once each.

### Fixed

- Guest callbacks on listener events, including function-valued `detail`, keep
  their identity; guest event subclass methods see the virtual current target.
- Nested CSSOM `insertRule()` calls rewrite selectors and URLs, register inserted
  rules, and keep staged styles from affecting the outgoing guest.
- `XMLSerializer` accepts guest shadow roots and serializes the guest document,
  including its doctype, instead of the hidden execution document.
- A replacement started during SSR handoff cannot roll back to an aborted realm.
- Range insertions reject non-nodes with the guest's `TypeError`, and
  `cloneContents()` visits only the selected subtree and its boundary ancestors.
- `document.links`, `document.anchors` and `document.scripts` exclude SVG elements.
- Deferred-script preloads retain integrity, referrer policy and fetch priority.
- SVG anchor fragment links resolve against the guest URL while SVG resource
  fragments remain local to the rendered tree.
- Package smoke tests check the server wire constants and stylesheet abort signal
  against the installed build; the API method count is corrected.
- A load that superseded a staged load and then failed left `status` stuck at
  `loading`; load generations no longer rewind, and when a guest navigates
  twice in one task the later request wins.
- `Request` keeps the native prototype, so `clone()` and natively created
  requests pass `instanceof Request`.
- `querySelectorAll`, `childNodes`, `children` and `getClientRects()` return
  native-branded lists; `Event.prototype` methods accept listener event objects.
- WebIDL conversions: `innerHTML = null`, `style.setProperty(p, null)`,
  `toggleAttribute(n, null)`, `setAttribute(null, …)`, `createElement(null)`,
  `setAttributeNS` namespace errors, `insertAdjacentHTML` validation,
  non-callable listeners, and `pushState` with an unparsable URL (`SecurityError`).
- `document.on*`, `window.on*` and window-reflecting `<body>` handlers cover every
  event type, keep their listener position when reassigned, and composed guest
  events no longer escape the shadow root to host listeners.
- Live collections no longer accumulate per-argument caches and invalidators.
- `replaceChildren` validates before removing anything and reports one
  mutation record.
- Stylesheet URL rebasing covers string URLs in `image-set()` and `src()` and
  leaves `@namespace` alone.
- Server: a guest without explicit `<html>`/`<head>` still honours its `<base>`,
  and inline `<style>` and `<link>` materialization failures are handled alike.
- An `XMLHttpRequest` opened but never sent is no longer retained until teardown.
- `innerHTML`, `outerHTML`, `getHTML()` and `XMLSerializer` serialize the
  guest's authored markup instead of v-frame's physical attributes.
- `before`, `after`, `prepend`, `append` and `replaceWith` insert in native order,
  validate before touching the tree, and report one mutation record.
- `Range.cloneContents()`/`extractContents()` keep authored styles, handlers and
  script state.
- Listener events expose their real `constructor`, stable method identities, `view`
  only where it exists, and work with event subclass accessors.
- The `MutationObserver` facade no longer exposes internals to the guest.
- `body.onX` and `window.onX` are one handler, body `onerror` gets the five-argument
  form, and reassigning a window handler keeps its listener position.
- WebIDL: `Symbol` values throw in URL and attribute setters, `toggleAttribute`
  validates names, `document.title` collapses whitespace, and `WebSocket`,
  `EventSource`, `Worker` and `window.open()` throw `SyntaxError` for unparsable URLs.
- Deferred inline modules run in document order.
- A load superseded by a `v-frame-navigated` listener no longer emits
  `v-frame-load`, and a guest navigation's promise resolves once its document
  commits.
- Host-mode `pushState` resolves against the guest `<base>`.
- `<link imagesrcset>` and SVG `<a href>` are rebased.
- A server-rendered inline `<style>` that failed to materialize is rewritten at
  activation; alternate stylesheets stay unapplied; a client disconnect no longer
  reports every pending stylesheet as failed.
- Host bookkeeping never calls a guest-patched `querySelectorAll`, and CSSOM
  `insertRule` installs only the inserted rule.
- Navigation fidelity, event lifetimes, and SSR state preservation (`78b4398`).

## 0.1.1 - 2026-10-02

### Added

- Accessibility and interaction coverage for labels, keyboard navigation, focus,
  forms, native popovers and dialogs, outside dismissal, and teardown.
- Real Kobalte/Floating UI placement coverage for all twelve placements,
  collision handling, scrolling, resizing, borders, and CSS scaling.
- Desktop and mobile SSR paint-continuity tests for React Router, Qwik, Angular,
  and SolidStart, including delayed scripts, pixel comparisons, rendering without
  JavaScript, and nonblank navigation commits.

### Fixed

- Document-navigation promises now settle with the requested load; superseded
  navigations reject instead of silently reporting success.
- Trusted Types policy assignment, contextual fragment parsing, JavaScript MIME
  classification, and event-listener once, passive, and error behavior.
- Redirected stylesheet URL resolution and live linked-stylesheet properties.
- Scrolled popover positioning and outside-interaction notifications that let
  guest layers dismiss without exposing foreign nodes or canceling host events.
- Angular's critical SSR styles and host startup ordering preserve the server
  preview while JavaScript is delayed.

### Changed

- Inline style updates are incremental, live collection reads reuse native
  collections or cached snapshots, and completed network resources leave
  teardown tracking.
- The SSR host uses typed client configuration and a separately built client
  entry; current Angular and SolidStart toolchains build and deploy as Workers.

### Removed

- Obsolete SolidStart/Vinxi configuration and Angular's separate global
  stylesheet; critical global styles are inline for the SSR preview.

## 0.1.0

The initial pre-stable version was corrected from `1.0.0` to `0.1.0`.

### Added

- Imperative guest navigation on the element: `navigate(url, { replace })`,
  `back()`, `forward()`, `go(delta)`, and the `canGoBack` / `canGoForward`
  properties. They delegate to the same history session guest-initiated
  navigation uses, fire the cancelable `v-frame-navigate`, and drive the shell's
  history under `navigation="host"`. Traversal resolves once the guest has
  actually moved in both navigation modes — under `navigation="host"` the shell
  performs it asynchronously, and the frame waits for the shell to report it —
  so `currentURL`, `canGoBack`, and `canGoForward` are already the post-traversal
  values when the promise settles. Host-mode traversal is bounded by the entries
  the shell's `navigation` object reports, which is the list `canGoBack` and
  `canGoForward` already answer from. A traversal the host cancels rejects
  naming the entry it aimed at, not the one the guest is still on.
- `v-frame-navigated`, the past-tense counterpart of `v-frame-navigate`. It is
  not cancelable, carries `{ from, to, kind }`, and fires after the guest has
  moved through its session — including guest `pushState`, fragment navigation,
  traversal, and document navigation — so a host router can read `currentURL`,
  `canGoBack`, and `canGoForward` from the listener instead of polling. It
  reports the move rather than the URL string, so a push of the route the guest
  is already on fires with `from === to`, while a replace of that route does
  not fire at all.
- `@mewhhaha/v-frame/server`, the server-side materializer for the adopted (SSR) path. It
  exports a runtime-neutral core — shell tag renaming, the injected display
  rules, script neutralization, and stylesheet rewriting — that a host drives
  from its own streaming HTML parser, plus `materializeVFrameDocument`, a
  Cloudflare `HTMLRewriter` adapter over that core. `createStylesheetContext`
  and `rewriteStylesheet` are exported from the same entry so a Node host can
  write its own adapter without copying CSS logic.
- Continuous integration on every push and pull request: one fast job running
  `format:check`, `typecheck`, `build`, `size`, the unit tests and the root
  Playwright suite on chromium and firefox, and a second job — gated on the
  first — running `examples/ssr`'s routing suite, which is the only place the
  navigation API is exercised against four real frameworks.
- Typechecking for `tests/`, `bench/`, `examples/*/tests/` and the client
  example's React host through `tsconfig.test.json`. The host is the only example
  source no build typechecks — the `example-ssr` job's build does the framework
  applications as a side effect — and it resolves `@mewhhaha/v-frame` by package
  name, so the project maps that name to `src/` rather than to declarations
  `dist/` does not have until after `typecheck` has run.
- A gzip bundle-size budget (`pnpm size`) that fails the build above its
  threshold, currently 68,000 bytes. The measured size is not repeated here: the
  command prints it, and a figure copied into prose is stale by the next commit
  — this one was, three revisions running.
- Unit tests (`pnpm test:unit`, `node --test`) over the pure logic: `src/url.ts`,
  the `src/css.ts` rewriters, `absolutizeSrcset`, `VirtualHistorySession`, and
  the facade's prototype-patch registry. 183 tests that run in about a tenth of a
  second, without a browser.
- A Kobalte-backed case in `tests/overlays.spec.ts`. The lab's own surfaces are
  positioned from the rects the facade reports, which is the repository checking
  its own arithmetic; this case hands that job to Kobalte's popover, and through
  it to `@floating-ui/dom` — third-party code written without any knowledge of
  v-frame — with the anchor 14 px clear of a clipped frame's bottom edge. It
  asserts the content's position on the host's screen and that the only
  difference between the facade's coordinate space and that screen is the
  frame's own origin. The guest module (`tests/support/kobalte-overlay-lab.js`)
  is bundled by Rolldown when the spec starts, resolving Kobalte from the copy
  `examples/client` already pins, so the root suite keeps its single pinned
  version, needs no framework build step, and gains about 30 ms.
- A benchmark for per-node marking (`pnpm bench`) and its findings note,
  [`docs/node-marking-benchmark.md`](./docs/node-marking-benchmark.md), which
  now records the before and after of both optimizations it motivated. Its
  `re-parent` row moves a settled subtree rather than growing the tree, which is
  the only measurement that distinguishes marking a node from re-marking one. It
  times both engines the suite runs on, one after the other; the two heap
  measurements stay chromium-only, because a collected heap size needs CDP and
  `performance.measureUserAgentSpecificMemory` is chromium-only as well, so on
  firefox the run says the heap is not measurable and skips the churn.
- `docs/`: the README was split into
  [`limitations.md`](./docs/limitations.md), [`api.md`](./docs/api.md),
  [`navigation.md`](./docs/navigation.md), [`ssr.md`](./docs/ssr.md), and
  [`troubleshooting.md`](./docs/troubleshooting.md). `limitations.md` enumerates,
  for the first time, every API the runtime deliberately refuses — most
  significantly `document.adoptedStyleSheets` and constructed stylesheets.
- A stated guest-size ceiling. `limitations.md` now carries the measured
  activation cost at four tree sizes, what the same markup costs inserted
  straight into the host document, the retained heap, and the machine and browser
  the numbers were taken on. The README's tradeoff section says which size of
  guest the design suits and which is better served by an `<iframe>`, citing
  those numbers instead of describing them. This was previously discoverable only
  by building something large and being disappointed.
- Firefox numbers behind that ceiling, so it no longer rests on one engine.
  Activation is somewhat dearer than chromium's (1.03x to 1.24x across the runs
  taken — too noisy for a specific figure) and insertion close to double, while
  re-parenting is within the
  spread. Retained heap is still unmeasured on firefox and `limitations.md` now
  says so where the figure appears, instead of leaving a chromium number reading
  as a cross-engine one.

### Changed

- `credentials` is redefined. It applies to the entry document and stylesheet
  requests `v-frame` itself issues, and supplies a default for guest requests
  that do not choose one. It is explicitly not a security boundary: the guest is
  same-origin and can set any credentials mode it likes.
- `navigation="host"` no longer patches the host page's `history.pushState` or
  `history.replaceState`. It observes the host's `navigation` object instead,
  which the runtime already requires, so a shell router that wraps those methods
  itself keeps working.
- The published bundles are minified, and `css-tree` is imported through its
  `parser`, `generator`, and `walker` subpaths so the unused lexer tables are no
  longer shipped. Together they take about a third off the gzipped payload.
  `pnpm size`, which minifies and gzips `src/index.ts` in memory, prints what
  that payload is now, and it is the only place that number is kept; no bundle
  byte count is copied into this entry, because every copy of it so far has gone
  stale within a commit or two of being written down. The heap and timing
  figures below are a different matter — they come from `pnpm bench` against a
  named machine and browser, and are stated as measurements of that run.
- A guest node no longer carries the facade on itself. `ownerDocument` and
  `baseURI` are answered by accessors on the realm's `Node.prototype`, gated on
  the same virtual-node set `getRootNode` was already gated on, instead of three
  own accessors installed on every node and every attribute node. Measured by
  `pnpm bench` on a 50,000-element guest, activation drops from 994 ms to 702 ms
  and retained JS heap from 52 MB to 7.5 MB; the marginal cost per element falls
  from 19.3 µs to 13.6 µs. Nodes that do not inherit from the realm's prototypes
  — Gecko binds a `ShadowRoot` to its node document's global, so an adopted
  guest's shadow roots do not — keep the per-node accessors.
- Marking no longer re-walks a subtree that is re-parented. Everything
  `markVirtualNode` does is a statement about the node itself — the virtual-node
  set the realm's identity accessors read, the authored style, `rel` and URL
  attributes, the defused scripts and inline handlers — and none of it depends on
  where the node hangs; the one input that is not per-node, the document base
  URL, already rebases the whole tree when it changes. So a node that is already
  marked and still inside the virtual tree is left alone, and one that is
  detached is walked in full, because nothing observes a detached subtree while
  the realm's `MutationObserver` hands every node added to a connected one back
  to marking on its own. That observer is a microtask where the walk was
  synchronous, so a node an unintercepted write put inside a connected marked
  element — the `textContent` setter's text node, `insertAdjacentText`,
  `setHTMLUnsafe` — is now marked a microtask after the write rather than by the
  next re-parent of an ancestor. [`docs/limitations.md`](./docs/limitations.md)
  records that as a limitation, with the list of APIs it affects. Measured by
  `pnpm bench`, which now has a `re-parent` row, moving a settled hundred-node
  subtree 1,000 times runs about 3–4x cheaper — from roughly 50–80x plain host
  DOM to roughly 12–20x. Activation and insertion do not change; the earlier note's guess
  that insertion was bound by this was wrong, and
  [`docs/node-marking-benchmark.md`](./docs/node-marking-benchmark.md) now
  records what a profile says it is bound by instead.
- The facade no longer retains every node it ever marked. The descriptors it
  records so `dispose()` can put a node back the way it found it were held in a
  strong `Map` keyed by node, so a guest that churned rows grew for the lifetime
  of the frame; they are now a `WeakMap` behind a `FinalizationRegistry`-pruned
  list of weak references. Nodes the guest still holds are still restored, and
  `tests/node-retention.spec.ts` holds both halves — 2,000 churned rows survive a
  forced collection zero times, and a removed node the guest still references
  gets its native `ownerDocument` and `getRootNode` back when the frame goes
  away.
- Nor does any of the facade's other per-element registries. The authored style
  and URL attributes (`src/markup.ts`) and the handler and listener targets
  (`src/facade/events.ts`) were strong `Map`s and `Set`s because each is
  enumerated — the inline stylesheet is rebuilt from one, a base-URL change
  rebases through another, and `dispose()` walks the last two — so a guest that
  churned elements carrying a `style` attribute, a URL attribute or an `onclick`
  still grew for the lifetime of the frame after the descriptor leak was closed.
  All five now share one primitive with the descriptors
  (`src/enumerable-weak.ts`): a `WeakMap` for the values behind an
  insertion-ordered set of `WeakRef`s that a `FinalizationRegistry` prunes, so
  enumeration walks the survivors. Measured by `pnpm bench`, which gained a
  retention measurement for this, 2,000 rows created, removed and dropped in a
  settled guest retain 1,331 KB instead of 3,012 KB; churning the same 2,000
  again costs 59 KB more instead of 2,421 KB more, which is the point — the cost
  is now a high-water mark rather than a per-row charge.
- `tests/node-retention.spec.ts` runs on firefox as well as chromium, and churns
  rows carrying one of everything a registry admits an element for. Forcing a
  collection no longer needs a CDP session: `page.requestGC()` is
  `HeapProfiler.collectGarbage` on chromium and the juggler `Heap.collectGarbage`
  on firefox. Reading how many _bytes_ survive is still chromium-only, which is
  why `pnpm bench` keeps its CDP session.
- Oxfmt formats the repository and Oxlint checks it in CI. Rolldown builds the
  published bundles, the bundle-size measurement, and the Kobalte test fixture.
- JSR publishing metadata for `@mewhhaha/v-frame`, a dry-run publication check in
  CI, and an OIDC release workflow. The package no longer augments the global DOM
  maps, which JSR rejects; consumers type queries explicitly with `VFrameElement`,
  whose add and remove event-listener overloads remain typed.
- `examples/ssr` imports `@mewhhaha/v-frame/server` instead of reaching into `src/`, and
  routes host-driven navigation through the element's own API.
- `src/document-facade.ts` (4,515 lines) is now `src/facade/` — `context`,
  `nodes`, `events`, `attributes`, `style`, `collections`, `selection`,
  `document`, composed by `index.ts`. `src/realm.ts` (2,130 lines) is now
  `src/realm/` — `connect`, `dynamic-styles`, `navigation`, `window-patches`,
  composed by `index.ts`. Behaviour is unchanged; the moves were mechanical and
  the suite stayed green at every step.
- `BoundHistory` and `VirtualHistory` share one base controller instead of
  duplicating entry, state, and URL handling.
- One listener registry backs the facade's `ListenerBridge`, the realm's window
  event bridge, and the network facade's `EventTarget` patch, which had drifted
  apart.
- Every Playwright fixture server is one parameterized route table in
  `tests/support/`, and every spec mounts frames through one shared
  `mountFrame` helper.
- No Playwright test leaves an ordering it asserts to browser scheduling. The
  dynamic-script insertion-order test used a 50 ms fixture delay, which failed
  roughly one full-suite run in five on firefox; the first script's response is
  now parked until the second's body has reached the socket, so the order the
  test claims is the order it gets under any load. `parkRoute` and `gateRoute` in
  `tests/support/http-fixture.ts` generalize that pair, and the four remaining
  timer-raced orderings use them: the fragment insertion-order scripts in
  `tests/script-safety.spec.ts`, `/assets/async-order.js` behind the deferred
  script in `tests/advanced.spec.ts`, the post-ready script that must not have
  settled when the frame reports load, and the deferred classic that a module's
  flush — not a 50 ms timer — now releases. Response delays that are themselves
  the behaviour under test, such as the 75 ms and 125 ms bootstrap blockers,
  are unchanged.

### Removed

- The credentialless XHR transport (`src/credentialless-xhr.ts`, 1,031 lines): a
  from-scratch reimplementation of `XMLHttpRequest` over `fetch`, whose only
  purpose was to suppress same-origin cookies for a guest that could send them
  itself through any other API. `XMLHttpRequest` is now always the native one, so
  its `username` and `password` arguments and synchronous mode work under every
  `credentials` value.
- `examples/ssr/shared/routing.ts`, the BroadcastChannel-plus-session-id protocol
  the example used to tell a guest where to navigate. The imperative navigation
  API above replaces it, and deleting it was the acceptance test for whether that
  API is sufficient.
- `examples/client` is down to a single guest framework, and its overlay
  compatibility lab moved to `tests/overlays.spec.ts` — it was asserting library
  behaviour (top-layer coordinate translation, focus, portal containment) rather
  than demonstrating usage, so it now runs in CI on chromium and firefox.
- The generated Cloudflare `worker-configuration.d.ts` files are no longer
  tracked; each example application regenerates them with `wrangler types`.

### Fixed

- The `reload()` description in [`docs/api.md`](./docs/api.md) now says that a
  successful reload resolves. Three earlier revisions of that paragraph were each
  wrong in a different way — the first claimed `reload()` could not run before
  `v-frame-load`, the second that it never rejects, the third enumerated the
  cases in which it resolves and left out the ordinary successful one.
- Benchmark figures in [`docs/limitations.md`](./docs/limitations.md),
  [`docs/node-marking-benchmark.md`](./docs/node-marking-benchmark.md) and this
  file are quoted as ratios rather than milliseconds. The absolute timings did
  not reproduce between machines or under load, so they were repeatedly stated
  more precisely than the measurement supported.
- An attribute written to an element that is already in the virtual tree now
  produces a marked `Attr` node. Marking only ever walked an element's
  attributes while marking the element itself, so an attribute set afterwards
  answered `baseURI` with the host page's URL on both engines, and on Gecko
  answered `ownerDocument` with the host document — Gecko binds the `Attr` to
  the node document the element was adopted into, so the realm's `Attr.prototype`
  is not on its chain.
- `dispose()` no longer leaves the nodes it restored registered with the
  facade's `FinalizationRegistry`. The registration held one dead cell per
  marked node for as long as the host kept the disposed element around.
- Unwinding the facade's prototype patches twice no longer reinstalls them. The
  record was reversed in place rather than drained, so a second run replayed it
  oldest-first and left the first patch of any twice-patched key installed. The
  realm's `dispose()` guards against running twice, so this was latent rather
  than observed; `tests/unit/facade-patches.test.ts` now pins it directly.
- [`docs/api.md`](./docs/api.md) described `reload()` wrongly, twice over. It
  claimed the method cannot run before `v-frame-load` — it can; only `navigate`,
  `back`, `forward` and `go` need a live guest — and the correction to that
  claimed it never rejects, which is worse. `reload()` settles with the load it
  starts, so it rejects with a non-HTTP or cross-origin `src`, and with the
  entry fetch's error whenever the response is not `ok`: a frame whose route
  404s rejects. It resolves only when it starts no load, because the element is
  disconnected or has no `src`, or when a later load supersedes the one it
  started. `tests/contract.spec.ts` now pins all five outcomes on both engines.
