# Benchmark — per-node marking (`markVirtualNode`)

This benchmark asks whether the facade installing own accessors on every node is a real
cost or a theoretical one, and whether the prototype-level alternative beats it.

**It was real, and the alternative wins.** Marking used to dominate both activation and
steady-state insertion, and each marked object retained roughly 350 bytes of JS heap that
plain host DOM does not allocate at all. Moving `ownerDocument` and `baseURI` off the
nodes and onto the realm's `Node.prototype`, gated on the virtual-node set that
`getRootNode` was already gated on, cut the marginal activation cost by about 30% and the
retained heap by about 86%, with the whole suite green.

A second round, [below](#round-two--re-parenting), answers the item that one left open:
marking re-walked a subtree every time it was re-parented. It no longer does, and moving a
settled subtree got about 3.8x cheaper — but insertion, which the first round guessed was
bound by the same re-walking, turned out not to be.

## How to reproduce

```
pnpm bench
```

`bench/mark-virtual-node.ts` serves a generated guest document of _N_ elements and
measures it two ways, in chromium and in firefox (`ENGINES` in the script; WebKit, the
third engine the test suite runs on, is not benchmarked):

- **v-frame** — mount a `v-frame`, time from assigning `src` to `v-frame-load`.
- **host DOM** — `fetch` the same URL, `DOMParser.parseFromString`, `adoptNode` the body
  into the host tree. Network and parse are therefore inside both timings.

Then, in the settled tree, it appends 1,000 elements one at a time from a script that is
byte-identical in the two realms (served once, loaded by both), which is what drives
`finishInsertion` and with it `markVirtualNode`. Then it re-parents: 1,000 times it appends
one of the guest's `<section>` groups — about a hundred nodes each, already in the tree and
already marked — back onto the same parent, which is the shape of a list reordering its
rows. Heap is `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage` over CDP, reported
as the delta across the whole configuration. Every configuration is the median of three
runs on a fresh page.

A fifth measurement churns rather than grows: it creates 2,000 rows in a settled guest,
removes them and drops every reference, and reports the heap that survives. That one reads
twice, because the registries hold weak references and the first collection only clears
them — the second collects what their finalizers released.

The timings are taken in chromium and firefox; the two heap measurements are
chromium-only, because CDP is the only way to ask a browser for a collected heap size that
Playwright can drive, and `performance.measureUserAgentSpecificMemory` — the
standard alternative — is chromium-only as well. On firefox the run prints the three
timing tables, says the heap is not measurable, and skips the churn, which has no
timing half. The engines run one after the other rather than together: these are
wall-clock main-thread numbers, and two browsers competing for the machine would
measure the machine.

"Marked objects" counts what marking actually walks: every element, every attribute node
and every text node. The generated guest averages three of those per element.

## Numbers

Chromium 149.0.7827.55, AMD Ryzen 7 7800X3D, 2026-08-01. Before and after were measured
alternately in one session on an otherwise idle machine, three `pnpm bench` runs each,
reported as the median across runs of the median-of-three each run already takes.
Run-to-run spread on the timings is about ±10%, so read the slope rather than any single
cell.

### Activation — fetch, parse and insert the whole guest

| elements | before   | after    | host DOM | overhead after |
| -------- | -------- | -------- | -------- | -------------- |
| 1,000    | 43.0 ms  | 37.0 ms  | 2.3 ms   | 16.1x          |
| 5,000    | 110.7 ms | 102.3 ms | 5.5 ms   | 18.6x          |
| 20,000   | 396.4 ms | 359.1 ms | 14.7 ms  | 24.4x          |
| 50,000   | 993.9 ms | 702.0 ms | 36.0 ms  | 19.5x          |

Marginal cost, taken as the 1k→50k slope so the fixed cost of booting the realm cancels
out: **19.28 µs per element before, 13.57 µs after** — about 4.5 µs per marked object,
down from 6.4. Host DOM is 0.65–0.9 µs per element throughout.

### Insertion — append 1,000 elements into the settled tree

| guest size | before  | after   | host DOM |
| ---------- | ------- | ------- | -------- |
| 1,000      | 48.3 ms | 39.7 ms | 1.5 ms   |
| 5,000      | 49.4 ms | 41.6 ms | 1.6 ms   |
| 20,000     | 48.7 ms | 39.3 ms | 1.6 ms   |
| 50,000     | 44.8 ms | 38.4 ms | 1.5 ms   |

Still flat in the size of the existing tree — marking is per inserted subtree, not per
document — and about 18% cheaper. ~39 ms to add 1,000 rows is 39 µs per inserted element
against 1.5 µs for host DOM, so insertion remains the worse of the two paths: it pays the
full `finishInsertion` walk, not just marking.

### Retained JS heap

Three states, because the leak fix and the optimization move this number in opposite
directions. The heap readings barely vary between runs; the middle column is the mean of
the two runs taken in that state, the outer two are medians of three.

| elements | marked objects | original  | leak fix only | prototype-gated |
| -------- | -------------- | --------- | ------------- | --------------- |
| 1,000    | 2,998          | 4,033 KB  | 4,520 KB      | 1,761 KB        |
| 5,000    | 14,998         | 7,951 KB  | 9,267 KB      | 2,149 KB        |
| 20,000   | 59,998         | 22,988 KB | 26,409 KB     | 4,014 KB        |
| 50,000   | 149,998        | 51,879 KB | 61,394 KB     | 7,471 KB        |

Host DOM stays flat at 180–490 KB in every state, because Blink keeps untouched nodes in
its C++ heap and never materializes a JS wrapper for them; the multiple against it is
therefore not a meaningful ratio and is deliberately not reported.

The 1k→50k slope is **333 bytes per marked object originally, 396 after the leak fix, 39
after the prototype patches**. The leak fix costs memory on purpose: it replaced a strong
`Map` entry per node with a `WeakRef` plus a `FinalizationRegistry` cell, which is bigger
but collectable. The prototype patches then removed the reason to record anything per node
at all, so both disappear together. What is left — about 7.5 MB for a 50k-element guest —
is mostly the JS wrappers that marking materializes by walking the tree, which is
irreducible for this design: the facade cannot decide a node is virtual without touching
it.

## What the cost was made of, and what changed

For every node and every attribute node, `markVirtualNode` (`src/facade/nodes.ts`) used to
`Object.defineProperties` three own accessors — `ownerDocument`, `baseURI`, `getRootNode`
— each capturing a closure over the node, and record the previous descriptor of each in a
strong `Map<Node, Map<PropertyKey, PropertyDescriptor>>`. Three own properties on an
object whose shape the engine had previously inlined is a hidden-class transition per
node.

Now:

- `getRootNode` was already patched on the realm's `Node.prototype` and gated on
  `virtualNodes`, so its own value was redundant. `ownerDocument` and `baseURI` joined it.
  Marking a node is now a `WeakSet.add` plus the attribute, URL and event-handler work it
  always did.
- Nothing is recorded per node, so `dispose()` has almost nothing to restore — it unwinds
  the prototype patches instead, which `context.restorePatches` already did.

### Why a prototype patch reaches the guest's nodes at all

The design's central trick is that guest nodes are created in the realm and then adopted
into the host shadow tree. Adoption changes the node document; it does not rebuild the JS
wrapper, so the wrapper keeps the realm's prototypes and a patch on the realm's
`Node.prototype` still answers for it. Probed directly (`row instanceof Node` evaluated in
the guest, after adoption), this holds in chromium and firefox, the two engines probed,
for elements, text nodes, attribute nodes, `template.content` children, nodes parsed by
`innerHTML` after adoption, and nodes created by `document.createElement`.

The one exception found: **Gecko binds a `ShadowRoot` to its node document's global**, so
a shadow root a guest attaches after adoption is a host-realm object and the realm's
`Node.prototype` is not on its chain. Chromium keeps it in the realm. `markVirtualNode`
therefore keeps the per-node accessors as a fallback for any node that is not
`instanceof window.Node`, which is the same shape `installForeignElementFacade` already
used for foreign elements. `tests/dom-event-fidelity.spec.ts` asserts
`nestedShadow.ownerDocument === virtualDocument` and runs in every desktop project
(chromium, firefox and webkit).

Two things that are per-node by nature and stayed per-node: the doctype's and the shell's
`parentNode`/sibling overrides, which answer with different values for each of the two
nodes and so cannot be expressed as one prototype accessor.

## What still retains guest nodes

Nothing per element. Five registries used to, and they now all hold their elements
weakly:

- `nodeFacadeDescriptors` (`src/facade/nodes.ts`) — the descriptors `dispose()` hands
  back.
- `options.authoredStyleAttributes` and `options.authoredURLAttributes`
  (`src/markup.ts`) — the authored values the facade answers with instead of the
  rebased physical ones. Both are enumerated on base-URL changes, the first to
  update inline CSS rules and the second to rebase URL attributes, which is why neither was a
  plain `WeakMap` before.
- `elementHandlerTargets` and `virtualListenerTargets` (`src/facade/events.ts`) — the
  targets `dispose()` takes native listeners back off. Also enumerated, and only for
  that.

The shape they share is in `src/enumerable-weak.ts`: a `WeakMap` for the values, plus
an insertion-ordered set of `WeakRef`s that a `FinalizationRegistry` prunes as the
elements are collected. Enumeration walks the survivors, which is exactly what all
four uses want — a rule for an element nobody can reach matches nothing, and a
listener on an element nobody can reach does not need removing.

### Churn — 2,000 rows created, removed and dropped

A settled 1,000-element guest, then 4 cycles of 500 rows appended and removed, each row
carrying a style attribute, a URL attribute, a handler property and a listener, with
every reference dropped before the reading. Collected heap, median of three, from the
`retention` table `pnpm bench` prints after the three above.

|                       | strong registries | weak registries | host DOM |
| --------------------- | ----------------- | --------------- | -------- |
| retained heap         | 3,012 KB          | 1,331 KB        | 73 KB    |
| bytes per churned row | 1,542             | 681             | 37       |

The number that actually answers the question is what a _second_ churn costs, because a
registry that holds its elements charges for every one of them and a high-water mark
charges once. Repeating the same 2,000-row churn against one mounted guest, as deltas
from before the first round:

| rounds          | strong registries | weak registries |
| --------------- | ----------------- | --------------- |
| 1 (2,000 rows)  | 3,011 KB          | 1,329 KB        |
| 2 (4,000 rows)  | 5,432 KB          | 1,388 KB        |
| 3 (6,000 rows)  | —                 | 1,494 KB        |
| 4 (8,000 rows)  | —                 | 1,531 KB        |
| 5 (10,000 rows) | —                 | 1,653 KB        |

Strong: +2,421 KB for the second round, and it would have kept paying that. Weak: +59 KB,
then +106, +37, +122 — about 40 bytes per row against 1,240, and flat rather than
compounding. (Both figures use the 1,024-byte KB that `pnpm bench`'s own `bytes/row`
column reports, so they are comparable with the table above.) The strong columns stop at two rounds because the run does not finish: the
rows it will not release make the next round quadratic (below).

What the first round's 1,329 KB is made of was not identified. It is not the rows — every
one of them is provably collected, which is what `tests/node-retention.spec.ts` asserts in
all three desktop projects with `page.requestGC()`, and it reported all 2,000 alive against
the strong registries. It is not the generated inline stylesheet either: forcing it to be rebuilt
afterwards returns 10 KB of the 1,329. The shape of the numbers — paid once, roughly in
proportion to the _peak_ number of live rows and to how many registries each row entered
(2,000 plain rows cost 525 KB, the same rows with a style attribute 930 KB) — fits the
backing stores of the weak tables themselves growing to the high-water mark and not
shrinking, but that was not confirmed.

At the time of these measurements, every style-attribute write rebuilt the whole
inline stylesheet from the elements the facade is still holding, so creating n inline-styled
elements costs O(n²). Closing the registries shrinks the n that survives a collection but
does not change the cost, and the same quadratic is why the churn in
`tests/node-retention.spec.ts` styles only every tenth row. The runtime now updates
one CSSOM rule per element instead. A full rebase is needed only when the document
base URL changes, and rules for collected elements are retired by a finalizer.

## Round two — re-parenting

The note above closed with marking still re-walking a subtree every time it moved, called
that the largest remaining item, and guessed it was also why insertion stayed ~25x host
DOM. The first half was right and the second was wrong, and the `re-parent` row exists
because neither could be told from the tables above: the benchmark grew trees, and never
moved one.

### What the walk was for, and what it is now

Everything marking does is a statement about the node itself. Joining the virtual-node set
the realm's identity accessors read, remembering the authored style, `rel` and URL
attributes, defusing scripts and inline handlers, installing the foreign-element facade —
none of it depends on where the node hangs. The one input that is not per-node is the
document base URL, and a base change already rebases the whole tree through
`rebaseURLs()`, so a move does not need it either.

So `markVirtualNode` now returns immediately for a node that is **already in the
virtual-node set and still inside the virtual tree**, and walks in full otherwise.

The gate is connectedness rather than an "already walked" flag because the walk is not only
marking, it is also _repair_. Plenty of DOM writes put an unmarked node inside an already
marked one without going through anything the facade patches — the `textContent` setter
creates its text node natively, `insertAdjacentText` and `setHTMLUnsafe` are not
intercepted at all — and until now the next walk over an ancestor is what found them. For a
connected subtree that repair is redundant: the realm's `MutationObserver` watches the
shell with `subtree: true`, and hands every added node straight back to marking, so the
node is marked whether or not an ancestor is ever re-parented. Nothing watches a _detached_
subtree, which is why detached ones are still walked in full — and why the walk still runs
on the path that matters most, building a subtree offline before inserting it.

### What it changed about _when_ repair happens

The gate is not free, and the cost is a timing change rather than a correctness one. For a
connected subtree it converts synchronous repair into deferred repair. A node one of those
unintercepted writes put inside a connected marked element — the `textContent` setter's
text node, `insertAdjacentText`, `setHTMLUnsafe` — used to be marked by the next walk over
an ancestor, synchronously, inside whatever re-parented that ancestor. That walk now
returns early, so the node is marked when the realm's `MutationObserver` callback runs, at
the next microtask checkpoint. Guest code that writes through one of those APIs, moves an
ancestor and reads the new node's identity in the same synchronous turn now gets native
answers where it used to get virtual ones. The re-parent case in
`tests/dom-fidelity.spec.ts` reads after the observer for exactly this reason, and
[`limitations.md`](./limitations.md#node-identity-after-an-unintercepted-write) states it
as a limitation with the affected APIs. A detached subtree is unaffected: it is still
walked in full on insertion, synchronously.

`tests/dom-fidelity.spec.ts` holds both halves: one case moves a marked subtree and asserts
identity, root and rebasing survive plus that an `insertAdjacentText` into it is still
marked, and one builds a detached subtree through two paths that mark nothing and asserts
the insertion walk finds them _synchronously_, before any observer could run. Replacing the
gate with a bare `virtualNodes.has` check fails the second one and the existing template
case.

### Numbers

Same machine and browser as above, 2026-08-01, one `pnpm bench` run before and one after,
back to back on an idle machine. Read the re-parent row; the other two are here to show
what did not move.

|            |          | 1,000    | 5,000    | 20,000   | 50,000   |
| ---------- | -------- | -------- | -------- | -------- | -------- |
| re-parent  | before   | 253.7 ms | 273.0 ms | 277.5 ms | 297.4 ms |
|            | after    | 58.8 ms  | 60.6 ms  | 66.4 ms  | 78.2 ms  |
|            | host DOM | 4.5 ms   | 4.6 ms   | 5.2 ms   | 6.2 ms   |
| insertion  | before   | 41.0 ms  | 37.6 ms  | 35.7 ms  | 37.5 ms  |
|            | after    | 35.3 ms  | 35.8 ms  | 34.4 ms  | 36.5 ms  |
| activation | before   | 36.0 ms  | 86.4 ms  | 270.5 ms | 622.4 ms |
|            | after    | 29.9 ms  | 79.1 ms  | 249.6 ms | 580.4 ms |

**Re-parenting 1,000 settled subtrees runs about 3–4x cheaper, dropping from roughly
50–80x plain host DOM to roughly 12–20x.** That is the whole of the claim. The ratio
reproduces across machines and runs; the absolute milliseconds do not, so they are not
quoted here — take them from `pnpm bench` on the machine you care about.

**Activation does not change**, and cannot: activation walks a tree that is detached when
marking reaches it, so the gate never fires. The 5–8% in the table is run-to-run spread,
and a second pair taken the same day put the two within 1.5% of each other.

**Insertion does not reliably change either.** The pair above is 3–14% cheaper, a pair taken
with the measurements in the other order was 1–8% dearer, and the spread on this row is
about ±10%. What the gate removes from an insertion is the mutation observer's second walk
over the subtree `prepareInsertion` had just walked — three nodes per row in this
benchmark, against ~35 µs a row spent elsewhere. So the earlier note's guess was wrong:
insertion is not bound by re-walking.

### What insertion is bound by

A CPU profile of the insertion loop (`Profiler.start` over CDP, unminified bundle,
1,000-element guest) attributed about 40% of it to one thing — `querySelectorAllWithShell`
in `src/facade/collections.ts`, reached six times per inserted row from `collectElements`,
`subtreeHasBaseElement`, `virtualStylesFrom`, `dynamicLinksFrom` and
`installCSSOMStyleSheets`. Each call parsed its selector with `css-tree` and regenerated it
so that `html` and `body` translate to the shell elements, and the selectors involved were
the constants `"*"`, `"base"`, `"style"` and `"link"`. Marking itself was about 18% of the
same profile.

## Round three — insertion, marking, CSSOM, and bundle size

Round 3 eliminated the selector-parsing bottleneck identified above and removed
per-element overhead across marking, CSSOM, and inline style updates:

- **Pre-facade native DOM capture + single-pass insertion (`SubtreeScan`):**
  `nativeDOM` captures unpatched `Element.prototype.querySelectorAll` before the
  facade installs, `markVirtualSubtree` collects `<base>`, `<style>`,
  `<link rel="stylesheet">`, and `<script>` elements in one `firstChild`/`nextSibling`
  pass (plus a single indexed `attributes` loop per element), and
  `observeRealmMutations` skips nodes already handled synchronously by the facade.
- **Selector fast-path and bounded cache:** `translateSelector` / `targetSelector`
  bail out with a fast regex when a selector cannot mention `html`, `head`, `body`,
  `:root`, `:host`, `:target`, or CSS escapes, and memoize rewritten selectors in a
  bounded 512-entry cache.
- **Prototype-level reflected URL properties:** `href`, `src`, `srcset`, `action`,
  `formAction`, `poster`, `cite`, and `data` moved from per-instance
  `Object.defineProperty` onto the realm's HTML element prototypes gated on
  `virtualNodes` (keeping the foreign-element fallback).
- **Lazy CSSOM & inline-style fast-path:** `<style>.sheet` / `<link>.sheet`
  CSSOM wrappers are installed lazily on first `.sheet` or `document.styleSheets`
  access instead of eagerly at boot, non-URL `el.style` writes bypass CSS
  declaration parsing, and finalizer rule deletion is microtask-batched (`O(n)`).
- **Zero-dependency CSS rewriter:** Replaced `css-tree` in `src/css.ts` with a
  purpose-built CSS Syntax Level 3 tokenizer and rewriter, cutting `dist/index.js`
  from `78.7 KB` gzip to `67.7 KB` gzip (`-11.1 KB` gzip).

### Numbers

Chromium 153.0.8010.12, AMD Ryzen 7 7800X3D, 2026-11-26, measured before and
after Round 3 on the same machine (`pnpm bench`, Chromium section):

|            |          | 1,000   | 5,000    | 20,000   | 50,000   |
| ---------- | -------- | ------- | -------- | -------- | -------- |
| insertion  | before   | 29.7 ms | 23.1 ms  | 24.4 ms  | 24.0 ms  |
|            | after    | 17.5 ms | 14.2 ms  | 16.8 ms  | 15.8 ms  |
|            | host DOM | 2.3 ms  | 2.3 ms   | 1.6 ms   | 1.6 ms   |
| re-parent  | before   | 48.4 ms | 49.4 ms  | 52.6 ms  | 73.5 ms  |
|            | after    | 22.3 ms | 21.7 ms  | 31.5 ms  | 45.3 ms  |
|            | host DOM | 7.1 ms  | 6.6 ms   | 6.0 ms   | 7.4 ms   |
| activation | before   | 51.8 ms | 99.8 ms  | 278.1 ms | 637.3 ms |
|            | after    | 54.5 ms | 125.7 ms | 303.6 ms | 559.2 ms |
|            | host DOM | 3.7 ms  | 5.2 ms   | 15.7 ms  | 39.5 ms  |

- **Insertion** dropped from `23–30 ms` (`12–20x` host DOM) to `14–18 ms`
  (`6–10x` host DOM) — nearly **2x faster** per 1,000 appended rows.
- **Re-parenting** dropped from `48–74 ms` (`10x` host DOM) to `22–45 ms`
  (`3–6x` host DOM) — **2–3x faster** on settled subtrees.
- **Marginal activation cost** dropped from `11.95 µs/element` (`17.5x`) to
  `10.30 µs/element` (`14.1x`).

## Round four — initial markup, marking, insertion, and cold boot

Round 4 profiled the remaining activation, insertion, re-parenting, and cold-boot
hot spots over CDP in Chromium 153 and removed the next layer of per-element and
per-mutation work without compromising durable virtual identity or cross-browser
fidelity:

- **Single-pass markup preparation (`src/markup.ts`):** Length-preserving ASCII
  lowercasing (`asciiLower`), fast-path chunked style neutralization, and targeted
  CSS queries (`[style]`, `[data-v-frame-inert-...]`, URL attribute selectors,
  `link[rel~="stylesheet" i][href]`, `script`, `base[href]`) replaced repeated
  full-tree `querySelectorAll("*")` walks and multi-pass string slicing.
- **Faster initial marking and element creation (`src/facade/marking.ts`):**
  During the initial pass over documents without inline `on*` candidates, `Attr`
  nodes are durably marked in a tight zero-string-read loop while leaf `Text`
  nodes join `virtualNodes` inline without recursing. `adoptCreatedElement` and
  `adoptAndMark` take direct fast paths for freshly created elements and
  text/comment nodes, and `isHTMLElementNamed` checks `localName` before
  `namespaceURI`.
- **Leaner steady-state mutations (`src/facade/attributes.ts`,
  `src/facade/insertion.ts`, `src/facade/node-patches.ts`,
  `src/realm/mutation-observer.ts`):** `managedAttributeFor` fast-rejects ordinary
  unmanaged attributes (`class`, `id`, `data-*`, `aria-*`), `prepareInsertion`
  reuses a pooled `SubtreeScan` scratch buffer, single-node `append`/`prepend`
  skips array allocation, settled re-parents use one targeted post-move candidate
  query instead of full subtree scans, `textContent` marks its plain text node
  directly, and the realm `MutationObserver` coalesces `<base>` checks per batch
  using counted `facadeConnectedCounts`.
- **Overlapped cold boot (`src/v-frame-element.ts`, `src/facade/events.ts`):**
  Entry HTML decoding (`readHTMLDocument`) now overlaps with `connectRealmIframe`
  in `Promise.all`, pristine guest realm `Event` constructor names are cached
  across mounts on the same host window, and discovered handler event types are
  reused between `installHandlerProperties` and `installRelays`.

### Numbers

Chromium 153.0.8010.12, AMD Ryzen 7 7800X3D, 2026-11-26, measured against Round 3
on the same idle machine (`pnpm bench`, Chromium section):

|            |          | 1,000   | 5,000    | 20,000   | 50,000   |
| ---------- | -------- | ------- | -------- | -------- | -------- |
| activation | Round 3  | 54.5 ms | 125.7 ms | 303.6 ms | 559.2 ms |
|            | Round 4  | 38.8 ms | 62.1 ms  | 144.3 ms | 311.3 ms |
|            | host DOM | 2.0 ms  | 4.6 ms   | 12.8 ms  | 31.0 ms  |
| insertion  | Round 3  | 17.5 ms | 14.2 ms  | 16.8 ms  | 15.8 ms  |
|            | Round 4  | 10.2 ms | 11.9 ms  | 9.2 ms   | 9.2 ms   |
|            | host DOM | 1.5 ms  | 1.3 ms   | 1.3 ms   | 1.3 ms   |
| re-parent  | Round 3  | 22.3 ms | 21.7 ms  | 31.5 ms  | 45.3 ms  |
|            | Round 4  | 13.9 ms | 17.0 ms  | 22.0 ms  | 31.4 ms  |
|            | host DOM | 4.7 ms  | 4.6 ms   | 5.4 ms   | 6.6 ms   |

- **Activation** dropped from `126 / 304 / 559 ms` at 5k/20k/50k to
  `62 / 144 / 311 ms`, cutting marginal cost nearly in half from
  `10.30 µs/element` (`14.1x`) to **`5.56 µs/element`** (`9.4x` host DOM) — a
  ~2.4x marginal speedup over `0.3.0`'s `13.57 µs/element`.
- **Insertion** dropped from `14.2–17.5 ms` to **`9.2–11.9 ms`** (`6.8–9.2x` host
  DOM) per 1,000 appended rows — well under a single 60 Hz frame and ~3.5–4x
  faster than `0.3.0`.
- **Re-parenting** dropped from `21.7–45.3 ms` to **`13.9–31.4 ms`** (`3.0–4.8x`
  host DOM) across 1,000 moves of a hundred-node subtree.
- **Retained JS heap** at 50,000 elements is `8.3–8.9 MB` (`57–61 B/object`), and
  2,000-row churn retention is `1,242 KB` (`636 B/row`), while `dist/index.js`
  stays under the `70 KB` gzip budget (`69.6 KB` gzip).

## Round five — tracked special elements, ownership-only initial walk, and opt-in `moveBefore` prewarming

Round 5 targeted the three remaining ceilings above plain host DOM — settled
re-parenting queries, initial marking per-node work, and realm iframe bootstrap
latency — while keeping durable `WeakSet` ownership intact across Chromium,
Firefox, and WebKit:

- **Tier 1 — Bounded special-element index & pure self-move fast path
  (`src/realm/mutation-observer.ts`, `src/facade/insertion.ts`,
  `src/realm/index.ts`):** The single realm `MutationObserver` starts before
  initial connection and maintains a bounded (`<= 32`, overflow-falling-back)
  set of connected `<base>`, `<style>`, `<link>`, `<script>`, and
  `[data-v-frame-target]` elements, seeded directly from `markup.scripts` and
  `fragmentTargets.current` when markup flags rule out initial styles, links,
  targets, or bases. On a settled single-node re-parent inside the light tree
  with no `<base>` and no `<style>` target, `flushIndex` discards the pure
  self-move records inline (skipping `querySelector`, observer microtasks, and
  `facadeConnectedCounts` bookkeeping); any non-pure records update the index
  passively and re-arm the observer's existing microtask delivery via a private
  observed text node so stylesheet edits preserve their async schedule and
  microtask ordering. Disconnected appends without
  a CSP nonce also skip `SubtreeScan` collection (with synchronous fallback if
  a custom element connects the parent reentrantly).
- **Tier 2 — Synchronous `replaceState` & opt-in `VFrameElement.prewarm()`
  (`src/realm/connect.ts`, `src/v-frame-element.ts`):** After `document.close()`
  in the hidden execution realm, engines that dispatch native
  `readystatechange("complete")` synchronously (Chromium) run
  `history.replaceState` immediately without a `setTimeout(0)` task hop, while
  engines that defer it (Firefox) keep the single-task yield. Hosts can also
  opt in to `VFrameElement.prewarm()` to pre-load one pristine hidden
  `about:srcdoc` iframe per host document and atomically claim it into the next
  `<v-frame>` via `ShadowRoot.prototype.moveBefore` (with identity verification,
  reload/reparent invalidation, `pagehide` teardown, and GC-safe disposal).
- **Tier 3 — Ownership-only initial marking walk (`src/facade/marking.ts`,
  `src/markup.ts`, `src/facade/attributes.ts`):** Split initial marking into
  branchless `markInitialOwnershipFast` (with `hasAttributes()` guards avoiding
  `NamedNodeMap` allocation on attribute-less elements and direct native
  `element.attributes` reads before patching) plus targeted post-walk passes for
  `<template>`, nested `<v-frame>` shadow roots, authored styles/URLs, `<link>`,
  `<script>`, and SVG URLs, and unified reflected URL descriptor collection into
  a single pass.

### Numbers

Idle Chromium 153.0.8010.12 and Firefox 155.0 on AMD Ryzen 7 7800X3D,
2026-11-26 (`pnpm bench`):

|            |          | 1,000   | 5,000   | 20,000   | 50,000   |
| ---------- | -------- | ------- | ------- | -------- | -------- |
| activation | Chromium | 39.7 ms | 60.8 ms | 142.6 ms | 294.4 ms |
|            | Host Cr  | 2.5 ms  | 4.3 ms  | 12.7 ms  | 32.1 ms  |
|            | Firefox  | 32 ms   | 54 ms   | 148 ms   | 338 ms   |
|            | Host FF  | 2 ms    | 6 ms    | 17 ms    | 40 ms    |
| insertion  | Chromium | 10.8 ms | 9.4 ms  | 9.8 ms   | 9.4 ms   |
|            | Host Cr  | 1.5 ms  | 1.6 ms  | 1.5 ms   | 1.4 ms   |
|            | Firefox  | 25 ms   | 26 ms   | 26 ms    | 26 ms    |
|            | Host FF  | 2 ms    | 1 ms    | 2 ms     | 2 ms     |
| re-parent  | Chromium | 14.1 ms | 16.6 ms | 21.5 ms  | 29.5 ms  |
|            | Host Cr  | 4.8 ms  | 4.9 ms  | 5.5 ms   | 6.9 ms   |
|            | Firefox  | 14 ms   | 15 ms   | 24 ms    | 37 ms    |
|            | Host FF  | 5 ms    | 6 ms    | 6 ms     | 6 ms     |

- **Marginal activation cost** dropped to **`5.20 µs/element`** (`8.6x` host DOM)
  in Chromium (50k elements under 300 ms at **`294.4 ms`**) and
  **`6.24 µs/element`** (`8.1x` host DOM) in Firefox (**`338 ms`** at 50k, down
  from `846 ms` in earlier runs).
- **Insertion** stayed flat at **`9.4–10.8 ms`** (`5.9–7.2x`) in Chromium and
  dropped to **`25–26 ms`** in Firefox (down from `66–79 ms`).
- **Re-parenting** dropped to **`14.1–29.5 ms`** (`2.9–4.3x` host DOM) in
  Chromium and **`14–37 ms`** (`2.5–6.2x`) in Firefox (down from `66–96 ms`).
- **Opt-in `VFrameElement.prewarm()`** (median of 15 warm mounts): raw iframe
  bootstrap fell from `3.35 ms` to `0.18 ms` (`18.6x`), cutting end-to-end warm
  mount latency from `6.3 → 5.3 ms` (empty, `-16%`) and `10.0 → 8.2 ms` (1k
  elements, `-18%`) in Chromium 153, and `9 → 7 ms` (empty, `-22%`) and
  `15 → 14 ms` (1k elements, `-7%`) in Firefox 155.
- **Retained JS heap** at 50,000 elements is `8,436 KB` (`58 B/object`),
  2,000-row churn retention is `1,267 KB` (`649 B/row`), and `dist/index.js` is
  `71.7 KB` gzipped.

## Round 6 — real-world DOM paths, Firefox foreign descriptors, and geometry-anchored activation (`0.6.0`)

Rounds 1–5 brought activation, insertion, and settled re-parenting down sharply,
leaving two very different stories in profiles of `0.5.0`:

1. **Large-tree activation includes rendering.** On the 50,000-element guest,
   `v-frame`'s `v-frame-load` waits for the guest's external script fetch while
   the browser computes style and layout for the inserted 50k tree; the host DOM
   baseline stops right after `host.append(...)`, before layout runs. Measuring
   both sides through a forced geometry read (`getBoundingClientRect().height`)
   shows the true end-to-end activation overhead is **`1.9x`** in Chromium and
   **`1.8x`** in Firefox.
2. **Real-world steady-state DOM operations still carried avoidable overhead:**
   shell-translated queries (`querySelector("body .row")`), `.sheet` reads on
   large stylesheets, `innerHTML` get/set, repeated detached-subtree
   re-attachment, `getAttribute`, cold Event/handler installation, and Gecko's
   per-node foreign descriptor maps.

### What changed

- **Native selector union & CSSOM/CSS fast paths (`src/facade/collections.ts`,
  `src/realm/dynamic-styles.ts`, `src/css.ts`):** Combine `${selectors}, ${translated}`
  into one native query/match/closest call whenever `canCombineSelector` confirms
  comma-safety (avoiding duplicate engine walks and returning a real `NodeList`),
  skip `Array.from` on empty nested `CSSStyleRule.cssRules` during `.sheet`
  reads, and cache import-free stylesheet rewrites in a bounded LRU cache keyed
  by base URL.
- **Markup & attribute fusion (`src/facade/markup.ts`, `src/facade/attributes.ts`,
  `src/facade/insertion.ts`, `src/facade/node-patches.ts`):** Share one lazy
  inert HTML document across `parseFragment` and `style.ts` probes, parse and
  insert `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`setHTMLUnsafe` fragments
  in one marking pass, skip `authoredCopy` cloning when a serialized subtree has
  no virtual attribute overrides, fast-reject non-managed attribute names before
  URL checks, and fast-path built-in `createElement`, plain marked leaf
  elements, and primitive empty-node `textContent` writes.
- **Cold setup, teardown, SSR & Gecko foreign descriptors (`src/facade/events.ts`,
  `src/facade/context.ts`, `src/facade/document.ts`, `src/facade/marking.ts`,
  `src/markup.ts`, `src/realm/index.ts`, `src/realm/window-patches.ts`,
  `src/realm/adoption-state.ts`, `src/enumerable-weak.ts`, `src/network.ts`):**
  Cache Event member and handler plans per host window, share one
  `boundaryRelay`, lazily insert the top-layer popover stylesheet in its
  original cascade slot, narrow initial URL scans and reuse initial
  `<style>`/`<link>`/`<base>` lists (clearing them right after bootstrap so
  removed nodes remain GC-able), memoize ancestor clip rects during SSR
  lazy-image visibility checks, drain weak collections in one pass on disposal,
  and store Gecko/WebKit foreign nodes without per-node descriptor Maps/closures
  via `compactForeignNodes`.
- **Observer indexing & clean detached-subtree watching
  (`src/realm/mutation-observer.ts`, `src/facade/marking.ts`,
  `src/facade/tree-patches.ts`):** Track connected `<base>` count in O(1) with
  synchronous pre-read flushing, retire clean facade additions and transient
  remove+reconnect pairs inline, recover from special-index overflow after
  removals, skip `onDisconnectedNodes` scans on special-free removals, and arm a
  capped GC-safe `MutationObserver` after a clean full walk of a detached
  multi-node branch so subsequent unchanged re-attachments skip walking in O(1)
  while any mutation falls back to the full walk.

### Numbers

Idle Chromium 153.0.8010.12 and Firefox 155.0 on AMD Ryzen 7 7800X3D,
2026-11-27 (`pnpm bench`):

|                   |          | 1,000   | 5,000   | 20,000   | 50,000   |
| ----------------- | -------- | ------- | ------- | -------- | -------- |
| activation (load) | Chromium | 37.0 ms | 59.4 ms | 129.3 ms | 280.4 ms |
|                   | Host Cr  | 1.8 ms  | 4.2 ms  | 12.4 ms  | 30.0 ms  |
|                   | Firefox  | 31.0 ms | 51.0 ms | 127.0 ms | 299.0 ms |
|                   | Host FF  | 2.0 ms  | 5.0 ms  | 16.0 ms  | 38.0 ms  |
| activation (geom) | Chromium | 37.0 ms | 59.4 ms | 129.4 ms | 280.4 ms |
|                   | Host Cr  | 4.6 ms  | 17.4 ms | 60.0 ms  | 149.0 ms |
|                   | Firefox  | 31.0 ms | 51.0 ms | 127.0 ms | 299.0 ms |
|                   | Host FF  | 5.0 ms  | 18.0 ms | 67.0 ms  | 168.0 ms |
| insertion (1k)    | Chromium | 7.9 ms  | 8.6 ms  | 7.7 ms   | 8.4 ms   |
|                   | Host Cr  | 1.4 ms  | 1.4 ms  | 1.2 ms   | 1.4 ms   |
|                   | Firefox  | 19.0 ms | 19.0 ms | 18.0 ms  | 18.0 ms  |
|                   | Host FF  | 2.0 ms  | 2.0 ms  | 2.0 ms   | 2.0 ms   |
| re-parent (1k)    | Chromium | 12.4 ms | 13.5 ms | 17.2 ms  | 28.6 ms  |
|                   | Host Cr  | 4.7 ms  | 6.0 ms  | 8.2 ms   | 16.0 ms  |
|                   | Firefox  | 11.0 ms | 12.0 ms | 16.0 ms  | 25.0 ms  |
|                   | Host FF  | 4.0 ms  | 6.0 ms  | 10.0 ms  | 18.0 ms  |

Real-world DOM operations on the 5,000-element guest (`0.5.0` → `0.6.0`):

| Operation                              | Chromium `0.5.0` → `0.6.0` (host) | Firefox `0.5.0` → `0.6.0` (host) |
| -------------------------------------- | --------------------------------- | -------------------------------- |
| `innerHTML =` (500×)                   | `39.0 → 10.8 ms` (`2.6 ms`)       | `55 → 23.0 ms` (`2.0 ms`)        |
| `innerHTML` get (500×)                 | `5.9 → 1.5 ms` (`0.1 ms`)         | `18 → 1.0 ms` (`<1 ms`)          |
| `querySelector("body .row")` (2k×)     | `23.8 → 1.3 ms` (`0.1 ms`)        | `127 → 2.0 ms` (`<1 ms`)         |
| `querySelectorAll("body .row")` (100×) | `76 → 24.5 ms` (`1.7 ms`)         | `66 → 25.0 ms` (`15.0 ms`)       |
| `.sheet` 500-rule read (200×)          | `37.1 → 0.5 ms` (`0.1 ms`)        | `21 → 1.0 ms` (`<1 ms`)          |
| `events` click dispatch (10k×)         | `36.1 → 37.9 ms` (`10.3 ms`)      | `62 → 60.0 ms` (`17.0 ms`)       |
| `detached 100-node re-attach` (200×)   | `7.9 → 6.4 ms` (`0.8 ms`)         | `27 → 5.0 ms` (`<1 ms`)          |
| `getAttribute` (50k×)                  | `12.0 → 6.6 ms` (`1.5 ms`)        | `10 → 7.0 ms` (`1.0 ms`)         |
| `setAttribute` (50k×)                  | `19.5 → 19.1 ms` (`3.2 ms`)       | `33 → 27.0 ms` (`5.0 ms`)        |

- **Marginal activation cost** dropped under 5 µs/element in Chromium to
  **`4.97 µs/element`** (`8.6x` raw load; **`1.9x`** through first geometry read
  at 50k elements: `280.4 ms` vs `149.0 ms`) and dropped to
  **`5.47 µs/element`** in Firefox (`7.4x` raw load; **`1.8x`** through geometry
  at 50k elements: `299.0 ms` vs `168.0 ms`).
- **Insertion** dropped to **`7.7–8.6 ms`** in Chromium (`5.6–6.4x`) and
  **`18–19 ms`** in Firefox (`9.0–9.5x`, `-28%`).
- **Re-parenting** dropped to **`12.4–28.6 ms`** (`1.8–2.6x`) in Chromium and
  **`11–25 ms`** (`1.4–2.8x`, `-32%` at 50k) in Firefox.
- **Bundle size** is `76.1 KB` gzipped (`95%` of the `80 KB` budget); retained
  JS heap at 50k elements is `10,052 KB` (`69 B/object`, varying ~8.5–10 MB
  across GC sweeps) and 2,000-row churn retention is `1,379 KB` (`706 B/row`).

## Round 7 — opt-in Tier C performance modes (`0.7.0`)

Default `0.6.0` behavior keeps full eager `Attr` marking, full eager `Event`
subclass forwarding, synchronous SSR adoption, serial blocking script fetches,
and uncontained layout. Round 7 adds five opt-in `<v-frame>` modes that trade
narrow, explicit compatibility assumptions for substantial cold-boot, memory,
and large-tree layout wins while leaving default behavior untouched:

- **`lazy-attributes`** (`frame.lazyAttributes`): skips eager `NamedNodeMap` and
  `Attr` materialization during initial marking, subtree walks, and
  `setAttribute` writes; marks `Attr` nodes on demand when guest APIs
  (`getAttributeNode`, `getAttributeNodeNS`, `attributes`,
  `removeAttributeNode`, or observed live `NamedNodeMap`s) access them.
- **`lazy-events`** (`frame.lazyEvents`): eagerly forwards `Event.prototype`
  plus 24 core DOM/UI Event interfaces and lazily forwards exotic native
  subclasses on first delivery.
- **`content-visibility="auto"`** (or a custom CSS selector via
  `frame.contentVisibility`): injects a zero-specificity `:where(...)` rule with
  `content-visibility: auto; contain-intrinsic-block-size: auto 300px` into the
  internal stylesheet (excluding metadata, `<dialog>`, `[popover]`, and single
  app-root wrappers in `"auto"` mode), updatable live without reload.
- **`adopt="visible" | "idle" | "interaction"`** + `frame.activate()`: keeps
  Declarative Shadow DOM previews painted with zero iframe creation or JS boot
  until visibility, browser idle, user interaction, or imperative activation.
- **`preload-scripts`** (boolean or space-separated URLs): concurrently preloads
  blocking classic external scripts while keeping strict document execution
  order, and optionally emits host `<link rel="preload" as="script">` hints in
  parallel with entry HTML fetch.

### Numbers

Idle Chromium 153.0.8010.12 and Firefox 155.0 on AMD Ryzen 7 7800X3D,
2026-11-27 (`pnpm bench`; heap is post-mount, pre-enumeration collected JS heap
measured before `benchCountObjects()` or `benchInsert()`):

| Mode (`v-frame` vs host DOM)                       | Chromium load | Chromium geom | Chromium 1k ins | Chromium heap (pre-enum) | Firefox load | Firefox geom | Firefox 1k ins |
| -------------------------------------------------- | ------------- | ------------- | --------------- | ------------------------ | ------------ | ------------ | -------------- |
| `1k default`                                       | 36.0 ms       | 36.0 ms       | 8.3 ms          | 3,840 KB                 | 33.0 ms\*    | 33.0 ms\*    | 21.0 ms\*      |
| `1k lazy-events`                                   | 27.8 ms       | 27.8 ms       | 7.9 ms          | 1,628 KB (-58%)          | —            | —            | —              |
| `1k lazy-attributes + lazy-events`                 | 27.5 ms       | 27.5 ms       | 6.9 ms          | 1,571 KB (-59%)          | 25.0 ms      | 25.0 ms      | 16.0 ms        |
| `50k default`                                      | 273.6 ms      | 273.7 ms      | 8.7 ms          | 8,119 KB                 | 292–338 ms   | 292–338 ms   | 19–25 ms       |
| `50k lazy-attributes + lazy-events`                | 225.0 ms      | 225.0 ms      | 7.1 ms          | 3,708 KB (-54%)          | 307.0 ms     | 307.0 ms     | 15.0 ms        |
| `50k lazy-attributes + lazy-events + cv="auto"`    | **96.4 ms**   | **96.5 ms**   | **6.9 ms**      | **3,719 KB (-54%)**      | **166.0 ms** | **173.0 ms** | **16.0 ms**    |
| `50k host DOM` (baseline, no `content-visibility`) | 29.7 ms       | 141.7 ms      | 1.5 ms          | 114 KB                   | 44.0 ms      | 189.0 ms     | 3.0 ms         |

_\*Default Firefox 1k baseline from the clean main table above (`33.0 ms` / `21.0 ms`); the secondary 1k Tier C probe immediately after the 50k default runs hit a transient Gecko GC pause before settling to `25.0 ms` / `16.0 ms` on `lazy-attributes + lazy-events`._

- **Cold boot & heap (`lazy-events` + `lazy-attributes`):** Skipping eager
  patching of 100+ exotic Event subclass prototypes saves **8.2 ms (`-23%`)**
  and **2.2 MB (`-58%`)** of JS heap on a 1k cold mount in Chromium. Skipping
  eager `Attr` materialization cuts 50k pre-enumeration JS heap by **4.4 MB
  (`-54%`)**, trims 50k Chromium activation by **48.6 ms (`-18%`)**, and trims
  1k insertion by **17–21%** in Chromium and **21–40%** in Firefox.
- **Large-tree rendering (`content-visibility="auto"`):** On the 50,000-element
  guest, offscreen layout containment drops activation through first geometry
  read to **`96.5 ms`** in Chromium (`-65%` vs default `v-frame`, `0.68x` of
  uncontained host DOM geometry at `141.7 ms`) and **`173.0 ms`** in Firefox
  (`0.92x` of uncontained host DOM geometry at `189.0 ms`).
- **Bundle size** is `78.6 KB` gzipped (`98%` of the `80 KB` budget), with
  default `0.7.0` numbers unchanged (`4.99 µs/element` Chromium, `5.29 µs/element`
  Firefox).

## What this does not answer

- The heap readings are chromium only. Firefox has no equivalent CDP heap reading, and
  its own-property cost model differs; on firefox the retention is covered by
  `tests/node-retention.spec.ts`, which runs in the chromium, firefox and webkit projects
  through `page.requestGC()`, not by this benchmark. What firefox _retains_ for a large
  guest is therefore still unknown. Its timings are not: they are in
  [`limitations.md`](./limitations.md#what-firefox-costs), and the before/after tables
  on this page predate the firefox runs, so they are chromium throughout. WebKit is
  neither timed nor measured for heap here.
- Activation includes fetch, parse, CSS rewriting, realm boot and guest script execution.
  The slope isolates the per-element part; the absolute numbers do not.
- Detached subtrees are walked in full on their first re-attachment or whenever any
  mutation occurs before or during detachment; unchanged multi-node branches that are
  repeatedly detached and re-attached (such as toggled panels or cached sections) skip
  re-walking via a capped, GC-safe clean-subtree observer. Standard guest writes
  (`textContent`, `insertAdjacentText`, `setHTMLUnsafe`, `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`) mark newly created nodes synchronously; only direct writes via
  unpatched host-realm prototypes defer to the mutation observer microtask.
