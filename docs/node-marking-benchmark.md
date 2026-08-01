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

## How to reproduce

```
pnpm bench
```

`bench/mark-virtual-node.ts` serves a generated guest document of *N* elements and
measures it two ways in headless chromium:

- **v-frame** — mount a `v-frame`, time from assigning `src` to `v-frame-load`.
- **host DOM** — `fetch` the same URL, `DOMParser.parseFromString`, `adoptNode` the body
  into the host tree. Network and parse are therefore inside both timings.

Then, in the settled tree, it appends 1,000 elements one at a time from a script that is
byte-identical in the two realms (served once, loaded by both), which is what drives
`finishInsertion` and with it `markVirtualNode`. Heap is `Runtime.getHeapUsage` after
`HeapProfiler.collectGarbage` over CDP, reported as the delta across the whole
configuration. Every configuration is the median of three runs on a fresh page.

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

`nodeFacadeDescriptors` no longer does: it is a `WeakMap` whose restore list holds
`WeakRef`s that a `FinalizationRegistry` prunes, and `tests/node-retention.spec.ts` churns
2,000 rows through a mounted guest and asserts none survive a forced collection. Three
strong per-element registries remain, all narrower than the old one because they only
admit elements with the relevant feature:

- `options.authoredStyleAttributes` and `options.authoredURLAttributes`
  (`src/markup.ts`) hold every element that carries a `style` attribute or a URL
  attribute. Both are enumerated — the inline stylesheet is rebuilt from the first and
  rebasing walks the second — so neither can simply become a `WeakMap`.
- `elementHandlerTargets` and `virtualListenerTargets` (`src/facade/events.ts`) hold
  elements while they have a handler property or a virtual listener, and drop them when
  the last one goes away. A guest that churns rows carrying `onclick` grows.

## What this does not answer

- Only chromium. Firefox has no equivalent CDP heap reading, and its own-property cost
  model differs; the correctness of the change on firefox is covered by the suite, not by
  this benchmark.
- Activation includes fetch, parse, CSS rewriting, realm boot and guest script execution.
  The slope isolates the per-element part; the absolute numbers do not.
- Marking still re-walks a subtree on every insertion. `virtualNodes` short-circuits the
  per-node work, but the recursive descent over `childNodes` and `attributes` still runs
  in full each time a subtree is re-parented, which is the largest remaining item and the
  likeliest explanation for insertion staying ~25x host DOM.
