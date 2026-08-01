# Benchmark — per-node marking (`markVirtualNode`)

Findings note for task 4.4 of [the cleanup plan](./cleanup-plan.md), which asks whether
finding C3 — the facade installing own accessors on every node — is a real cost or a
theoretical one, and then whether the prototype-level alternative beats it.

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

`bench/mark-virtual-node.ts` serves a generated guest document of *N* elements and
measures it two ways, in each of the two headless engines the test suite runs on:

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

The timings are taken on both engines; the two heap measurements are chromium-only,
because CDP is the only way to ask a browser for a collected heap size that
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

| elements | before | after | host DOM | overhead after |
| --- | --- | --- | --- | --- |
| 1,000 | 43.0 ms | 37.0 ms | 2.3 ms | 16.1x |
| 5,000 | 110.7 ms | 102.3 ms | 5.5 ms | 18.6x |
| 20,000 | 396.4 ms | 359.1 ms | 14.7 ms | 24.4x |
| 50,000 | 993.9 ms | 702.0 ms | 36.0 ms | 19.5x |

Marginal cost, taken as the 1k→50k slope so the fixed cost of booting the realm cancels
out: **19.28 µs per element before, 13.57 µs after** — about 4.5 µs per marked object,
down from 6.4. Host DOM is 0.65–0.9 µs per element throughout.

### Insertion — append 1,000 elements into the settled tree

| guest size | before | after | host DOM |
| --- | --- | --- | --- |
| 1,000 | 48.3 ms | 39.7 ms | 1.5 ms |
| 5,000 | 49.4 ms | 41.6 ms | 1.6 ms |
| 20,000 | 48.7 ms | 39.3 ms | 1.6 ms |
| 50,000 | 44.8 ms | 38.4 ms | 1.5 ms |

Still flat in the size of the existing tree — marking is per inserted subtree, not per
document — and about 18% cheaper. ~39 ms to add 1,000 rows is 39 µs per inserted element
against 1.5 µs for host DOM, so insertion remains the worse of the two paths: it pays the
full `finishInsertion` walk, not just marking.

### Retained JS heap

Three states, because the leak fix and the optimization move this number in opposite
directions. The heap readings barely vary between runs; the middle column is the mean of
the two runs taken in that state, the outer two are medians of three.

| elements | marked objects | original | leak fix only | prototype-gated |
| --- | --- | --- | --- | --- |
| 1,000 | 2,998 | 4,033 KB | 4,520 KB | 1,761 KB |
| 5,000 | 14,998 | 7,951 KB | 9,267 KB | 2,149 KB |
| 20,000 | 59,998 | 22,988 KB | 26,409 KB | 4,014 KB |
| 50,000 | 149,998 | 51,879 KB | 61,394 KB | 7,471 KB |

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
the guest, after adoption), this holds in both engines for elements, text nodes, attribute
nodes, `template.content` children, nodes parsed by `innerHTML` after adoption, and nodes
created by `document.createElement`.

The one exception found: **Gecko binds a `ShadowRoot` to its node document's global**, so
a shadow root a guest attaches after adoption is a host-realm object and the realm's
`Node.prototype` is not on its chain. Chromium keeps it in the realm. `markVirtualNode`
therefore keeps the per-node accessors as a fallback for any node that is not
`instanceof window.Node`, which is the same shape `installForeignElementFacade` already
used for foreign elements. `tests/dom-event-fidelity.spec.ts` asserts
`nestedShadow.ownerDocument === virtualDocument` and covers this on both engines.

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
  rebased physical ones. Both are enumerated, the first to rebuild the inline
  stylesheet and the second to rebase on a base-URL change, which is why neither was a
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

| | strong registries | weak registries | host DOM |
| --- | --- | --- | --- |
| retained heap | 3,012 KB | 1,331 KB | 73 KB |
| bytes per churned row | 1,542 | 681 | 37 |

The number that actually answers the question is what a *second* churn costs, because a
registry that holds its elements charges for every one of them and a high-water mark
charges once. Repeating the same 2,000-row churn against one mounted guest, as deltas
from before the first round:

| rounds | strong registries | weak registries |
| --- | --- | --- |
| 1 (2,000 rows) | 3,011 KB | 1,329 KB |
| 2 (4,000 rows) | 5,432 KB | 1,388 KB |
| 3 (6,000 rows) | — | 1,494 KB |
| 4 (8,000 rows) | — | 1,531 KB |
| 5 (10,000 rows) | — | 1,653 KB |

Strong: +2,421 KB for the second round, and it would have kept paying that. Weak: +59 KB,
then +106, +37, +122 — about 40 bytes per row against 1,211, and flat rather than
compounding. The strong columns stop at two rounds because the run does not finish: the
rows it will not release make the next round quadratic (below).

What the first round's 1,329 KB is made of was not identified. It is not the rows — every
one of them is provably collected, which is what `tests/node-retention.spec.ts` asserts on
both engines with `page.requestGC()`, and it reported all 2,000 alive against the strong
registries. It is not the generated inline stylesheet either: forcing it to be rebuilt
afterwards returns 10 KB of the 1,329. The shape of the numbers — paid once, roughly in
proportion to the *peak* number of live rows and to how many registries each row entered
(2,000 plain rows cost 525 KB, the same rows with a style attribute 930 KB) — fits the
backing stores of the weak tables themselves growing to the high-water mark and not
shrinking, but that was not confirmed.

The churn is deliberately modest because every style-attribute write rebuilds the whole
inline stylesheet from the elements the facade is still holding, so creating n inline-styled
elements costs O(n²). Closing the registries shrinks the n that survives a collection but
does not change the cost, and the same quadratic is why the churn in
`tests/node-retention.spec.ts` styles only every tenth row. That is a separate problem and
is untouched here.

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
marking, it is also *repair*. Plenty of DOM writes put an unmarked node inside an already
marked one without going through anything the facade patches — the `textContent` setter
creates its text node natively, `insertAdjacentText` and `setHTMLUnsafe` are not
intercepted at all — and until now the next walk over an ancestor is what found them. For a
connected subtree that repair is redundant: the realm's `MutationObserver` watches the
shell with `subtree: true`, and hands every added node straight back to marking, so the
node is marked whether or not an ancestor is ever re-parented. Nothing watches a *detached*
subtree, which is why detached ones are still walked in full — and why the walk still runs
on the path that matters most, building a subtree offline before inserting it.

### What it changed about *when* repair happens

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
the insertion walk finds them *synchronously*, before any observer could run. Replacing the
gate with a bare `virtualNodes.has` check fails the second one and the existing template
case.

### Numbers

Same machine and browser as above, 2026-08-01, one `pnpm bench` run before and one after,
back to back on an idle machine. Read the re-parent row; the other two are here to show
what did not move.

| | | 1,000 | 5,000 | 20,000 | 50,000 |
| --- | --- | --- | --- | --- | --- |
| re-parent | before | 253.7 ms | 273.0 ms | 277.5 ms | 297.4 ms |
| | after | 58.8 ms | 60.6 ms | 66.4 ms | 78.2 ms |
| | host DOM | 4.5 ms | 4.6 ms | 5.2 ms | 6.2 ms |
| insertion | before | 41.0 ms | 37.6 ms | 35.7 ms | 37.5 ms |
| | after | 35.3 ms | 35.8 ms | 34.4 ms | 36.5 ms |
| activation | before | 36.0 ms | 86.4 ms | 270.5 ms | 622.4 ms |
| | after | 29.9 ms | 79.1 ms | 249.6 ms | 580.4 ms |

**Re-parenting 1,000 settled subtrees drops from 254–297 ms to 59–78 ms — about 3.8x —
and from 48–59x plain host DOM to 12–13x.** That is the whole of the claim.

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
1,000-element guest) attributes about 40% of it to one thing — `querySelectorAllWithShell`
in `src/facade/collections.ts`, reached six times per inserted row from `collectElements`,
`subtreeHasBaseElement`, `virtualStylesFrom`, `dynamicLinksFrom` and
`installCSSOMStyleSheets`. Each call parses its selector with `css-tree` and regenerates it
so that `html` and `body` translate to the shell elements, and the selectors involved are
the constants `"*"`, `"base"`, `"style"` and `"link"`. Marking itself is about 18% of the
same profile. Caching the translation of a selector string would be the next thing to try,
and it is a separate change from this one.

## What this does not answer

- The heap readings are chromium only. Firefox has no equivalent CDP heap reading, and
  its own-property cost model differs; on firefox the retention is covered by
  `tests/node-retention.spec.ts`, which runs on both engines through
  `page.requestGC()`, not by this benchmark. What firefox *retains* for a large guest
  is therefore still unknown. Its timings are not: they are in
  [`limitations.md`](./limitations.md#what-firefox-costs), and the before/after tables
  on this page predate the second engine, so they are chromium throughout.
- Activation includes fetch, parse, CSS rewriting, realm boot and guest script execution.
  The slope isolates the per-element part; the absolute numbers do not.
- Detached subtrees are still walked in full every time they are inserted, and a guest that
  detaches a container, edits it and re-attaches it pays the old price. Closing that needs
  the facade to intercept every write that can put an unmarked node inside a marked one,
  rather than repairing them afterwards; `insertAdjacentText` and `setHTMLUnsafe` are the
  two known gaps.
