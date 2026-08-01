# Benchmark — per-node marking (`markVirtualNode`)

Findings note for task 4.4 of [the cleanup plan](./cleanup-plan.md), which asks whether
finding C3 — the facade installing own accessors on every node — is a real cost or a
theoretical one.

**It is real.** Marking dominates both activation and steady-state insertion. Guest DOM
work costs roughly **25x** what the same markup costs as plain host DOM, and each marked
object retains roughly **350 bytes** of JS heap that plain host DOM does not allocate at
all.

No optimization was applied. This note exists so the decision in 4.4 is made against a
number.

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

Chromium 149.0.7827.55, AMD Ryzen 7 7800X3D, 2026-08-01.

### Activation — fetch, parse and insert the whole guest

| elements | v-frame | host DOM | overhead |
| --- | --- | --- | --- |
| 1,000 | 84.1 ms | 3.5 ms | 24.0x |
| 5,000 | 109.7 ms | 6.8 ms | 16.1x |
| 20,000 | 544.9 ms | 18.8 ms | 29.0x |
| 50,000 | 1331.0 ms | 54.1 ms | 24.6x |

Marginal cost, taken as the 1k→50k slope so the fixed cost of booting the realm cancels
out: **25.45 µs per element** for v-frame against **1.03 µs** for host DOM — about
**8.5 µs per marked object**.

### Insertion — append 1,000 elements into the settled tree

| guest size | v-frame | host DOM | overhead |
| --- | --- | --- | --- |
| 1,000 | 71.7 ms | 2.2 ms | 32.6x |
| 5,000 | 61.8 ms | 1.6 ms | 38.6x |
| 20,000 | 65.3 ms | 2.5 ms | 26.1x |
| 50,000 | 66.4 ms | 2.2 ms | 30.2x |

Flat in the size of the existing tree, which is the one piece of good news: marking is
per inserted subtree, not per document. But ~65 ms to add 1,000 rows is roughly 33 µs per
inserted element, and it agrees with the activation slope — the same work, measured twice.

### Retained JS heap

| elements | marked objects | v-frame | host DOM | bytes/object |
| --- | --- | --- | --- | --- |
| 1,000 | 2,998 | 4,033 KB | 267 KB | 1,377 |
| 5,000 | 14,998 | 7,950 KB | 486 KB | 543 |
| 20,000 | 59,998 | 22,987 KB | 224 KB | 392 |
| 50,000 | 149,998 | 51,830 KB | 337 KB | 354 |

The host DOM column is flat and small because Blink keeps untouched nodes in its C++ heap
and never materializes a JS wrapper for them; the multiple against it is therefore not a
meaningful ratio and is deliberately not reported. The v-frame column is the honest
number: a 50k-element guest costs about **50 MB of JS heap**. The first row is dominated
by the ~4 MB fixed cost of the realm; the 1k→50k slope is **333 bytes per marked object**.

## What the cost is made of

For every node and every attribute node, `markVirtualNode`
(`src/facade/nodes.ts`) does three things:

1. `Object.defineProperties` with three own accessors — `ownerDocument`, `baseURI`,
   `getRootNode` — each capturing a closure over the node. Three own properties on an
   object whose shape the engine had previously inlined is a hidden-class transition per
   node, which is the likeliest source of the time.
2. Records the *previous* descriptor of each of those three keys in
   `nodeFacadeDescriptors`, a `Map<Node, Map<PropertyKey, PropertyDescriptor | undefined>>`.
   That is one outer entry plus a three-entry inner `Map` per node.
3. Materializes a JS wrapper for a node the guest may never touch from script, which is
   the difference the heap column measures against plain host DOM.

Two secondary observations that fell out of the measurement and are **not** in scope here:

- `nodeFacadeDescriptors` is a strong `Map`, deliberately: `dispose()` walks it to restore
  every descriptor it overwrote. The consequence is that a marked node is retained for the
  lifetime of the frame even after the guest removes it and drops every other reference.
  A long-lived guest that churns rows grows monotonically.
- Marking re-walks a subtree on every insertion. `virtualNodes` short-circuits the
  expensive per-node work, but the recursive descent over `childNodes` and `attributes`
  still runs in full each time a subtree is re-parented.

## What this does not answer

- Only chromium. Firefox has no equivalent CDP heap reading, and its own-property cost
  model differs.
- Activation includes fetch, parse, CSS rewriting, realm boot and guest script execution.
  The slope isolates the per-element part; the absolute numbers do not.
- It does not show that the prototype-level-patch-plus-`WeakSet` alternative sketched in
  task 4.4 would be faster. It shows only that there is something worth trying to beat.
