/**
 * Measures finding C3 of docs/cleanup-plan.md: what the facade's per-node own-property
 * installation (`markVirtualNode`) costs on the hot DOM path.
 *
 * Every configuration is measured twice — once through a mounted v-frame, once as the
 * same markup parsed and inserted straight into the host document — so the numbers are
 * an overhead multiple rather than an unanchored millisecond count. Run it with
 * `pnpm bench`; it drives both headless engines, and reports heap on the one that can
 * give a collected reading.
 */
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import {
  chromium,
  firefox,
  type Browser,
  type BrowserType,
  type CDPSession,
  type Page,
} from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  type Route,
  startHTTPFixture,
} from "../tests/support/http-fixture.js";
import { installBundle } from "../tests/support/mount-frame.js";

/**
 * Both engines the test suite runs on, so a timing claim is never made from one of
 * them. They are measured one after the other rather than in parallel — the numbers
 * are wall-clock main-thread work and two browsers competing for the machine would
 * measure the machine.
 */
const ENGINES: BrowserType[] = [chromium, firefox];

/** Element counts of the guest document, chosen to expose a per-node slope. */
const GUEST_SIZES = [1_000, 5_000, 20_000, 50_000];
/** Elements appended one by one into an already-mounted guest. */
const INSERTION_COUNT = 1_000;
/** Re-parents of an already-settled subtree, measured in the same guest. */
const MOVE_COUNT = 1_000;
/** The guest the churn measurement runs against; its size is not what is measured. */
const CHURN_GUEST_SIZE = 1_000;
/**
 * Rows created, removed and dropped per cycle, and cycles. Kept modest because
 * every style-attribute write rebuilds the whole inline stylesheet, so the churn
 * costs time quadratically in the rows the facade is still holding.
 */
const CHURN_ROWS = 500;
const CHURN_CYCLES = 4;
/** Each configuration is sampled this many times and reported as a median. */
const REPEATS = 3;

interface BenchWindow extends Window {
  benchInsert(count: number): number;
  benchMove(count: number): number;
  benchChurn(rows: number, cycles: number): void;
  benchCountObjects(): number;
}

interface BenchFrame extends HTMLElement {
  src: string;
  readonly contentWindow: BenchWindow | null;
}

/** The churn measurement mounts in one evaluate and churns in another. */
interface BenchHost extends Window {
  benchGuest?: BenchWindow | null;
}

interface Sample {
  /** Milliseconds from assigning `src` to `v-frame-load`, network and parse included. */
  activation: number;
  /** Milliseconds to append `INSERTION_COUNT` elements into the settled tree. */
  insertion: number;
  /** Milliseconds to re-parent an already-settled subtree `MOVE_COUNT` times. */
  move: number;
  /**
   * Bytes of JS heap the whole configuration retains after a forced collection, or
   * null on an engine that cannot be asked for one.
   */
  heap: number | null;
  /** Elements, attribute nodes and text nodes in the settled tree — what marking walks. */
  objects: number;
}

interface Measurement {
  size: number;
  frame: Sample;
  host: Sample;
}

/**
 * Both realms load this, so the insertion path being timed is byte-identical whether
 * `document` is the facade or the host document. Appending to a connected parent is
 * what drives `finishInsertion`, and with it `markVirtualNode`, once per row.
 */
const insertScript = `
window.benchInsert = (count) => {
  const root = document.querySelector("#bench-root");
  if (root === null) throw new Error("bench root is missing");
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = "bench-row";
    row.setAttribute("data-index", String(index));
    const label = document.createElement("span");
    label.textContent = "inserted " + index;
    row.append(label);
    root.append(row);
  }
  return performance.now() - start;
};

// Re-parents subtrees that are already settled in the tree, which is what a list
// or a virtualized view does when it reorders rows. Only the groups are moved, so
// every move carries a subtree of about a hundred nodes rather than a lone node.
window.benchMove = (count) => {
  const root = document.querySelector("#bench-root");
  if (root === null) throw new Error("bench root is missing");
  const groups = Array.from(root.children).filter(
    (child) => child.localName === "section",
  );
  if (groups.length === 0) throw new Error("the bench guest has no groups to move");
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    root.append(groups[index % groups.length]);
  }
  return performance.now() - start;
};

// Creates rows, removes them and drops every reference to them, repeatedly. Each
// row carries a style attribute, a URL attribute, a handler property and a
// listener, which is what the facade's per-element registries admit an element
// for. Nothing here is reachable when the loop ends, so a collected heap that
// still grew is retention.
window.benchChurn = (rows, cycles) => {
  const root = document.querySelector("#bench-root");
  if (root === null) throw new Error("bench root is missing");
  const handler = () => undefined;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    let created = [];
    for (let index = 0; index < rows; index += 1) {
      const row = document.createElement("a");
      row.className = "bench-row";
      row.setAttribute("href", "/row-" + index);
      row.setAttribute("style", "color: rgb(1, 2, 3)");
      row.onclick = handler;
      row.addEventListener("pointerdown", handler);
      row.append(document.createTextNode("churned " + index));
      root.append(row);
      created.push(row);
    }
    for (const row of created) {
      row.remove();
    }
    created = [];
  }
};

// Counts what marking walks — every element, attribute node and text node.
window.benchCountObjects = () => {
  let total = 0;
  for (const element of document.querySelectorAll("#bench-root, #bench-root *")) {
    total += 1 + element.attributes.length;
    for (const child of element.childNodes) {
      if (child.nodeType === 3) total += 1;
    }
  }
  return total;
};
`;

/**
 * Emits exactly `elementCount` elements shaped like an ordinary app tree: grouped
 * sections of rows, each row carrying the URL-free attributes the facade still has to
 * walk. `#bench-root` is the insertion target both realms look up by id.
 */
function guestMarkup(elementCount: number): string {
  const chunks: string[] = [];
  let remaining = elementCount - 1;
  let group = 0;

  while (remaining >= 3) {
    chunks.push(`<section class="group" data-group="${group}">`);
    remaining -= 1;
    const rows = Math.min(50, Math.floor(remaining / 2));
    for (let row = 0; row < rows; row += 1) {
      chunks.push(
        `<div class="row" data-index="${row}" title="row ${row}">`,
        `<span>row ${group}.${row}</span></div>`,
      );
    }
    remaining -= rows * 2;
    chunks.push("</section>");
    group += 1;
  }
  while (remaining > 0) {
    chunks.push(`<span data-filler="${remaining}"></span>`);
    remaining -= 1;
  }

  return `<div id="bench-root">${chunks.join("")}</div>`;
}

function guestDocument(elementCount: number): string {
  return htmlDocument(
    `${guestMarkup(elementCount)}<script src="/bench-insert.js"></script>`,
    "<title>bench guest</title><style>.row{display:block}</style>",
  );
}

function guestPath(size: number): string {
  return `/guest-${size}`;
}

function benchRoutes(): Record<string, Route> {
  const routes: Record<string, Route> = {
    "/": htmlDocument('<div id="host"></div>'),
    "/baseline": htmlDocument(
      '<div id="host"></div><script src="/bench-insert.js"></script>',
    ),
    "/bench-insert.js": { type: "text/javascript", body: insertScript },
    "/dist/index.js": bundleRoute,
  };
  for (const size of GUEST_SIZES) {
    routes[guestPath(size)] = guestDocument(size);
  }
  return routes;
}

/**
 * Heap is measured over CDP, which only chromium speaks; the standard alternative,
 * `performance.measureUserAgentSpecificMemory`, is chromium-only as well. On any other
 * engine the timings are still taken and the heap is reported as unmeasured rather
 * than guessed at.
 */
function measuresHeap(engine: BrowserType): boolean {
  return engine.name() === "chromium";
}

function openHeapSession(page: Page, engine: BrowserType): Promise<CDPSession> | null {
  return measuresHeap(engine) ? page.context().newCDPSession(page) : null;
}

/** A collected heap reading; without the forced GC the deltas are pure noise. */
async function heapUsage(cdp: CDPSession | null): Promise<number | null> {
  if (cdp === null) return null;
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return usage.usedSize;
}

/**
 * What the churn measurement reads. Two passes, because the registries hold weak
 * references: the first collection clears them, the second collects what their
 * finalizers released.
 */
async function settledHeapUsage(cdp: CDPSession): Promise<number> {
  await heapUsage(cdp);
  const usage = await heapUsage(cdp);
  if (usage === null) throw new Error("the churn measurement needs a heap reading");
  return usage;
}

function heapDelta(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}

function measureFrame(page: Page, guestURL: string): Promise<Omit<Sample, "heap">> {
  return page.evaluate(
    async (options) => {
      const frame = document.createElement("v-frame") as BenchFrame;
      const loaded = new Promise<void>((settled) => {
        frame.addEventListener("v-frame-load", () => settled(), { once: true });
      });
      const host = document.querySelector("#host");
      if (host === null) throw new Error("host container is missing");

      const start = performance.now();
      frame.src = options.guestURL;
      host.append(frame);
      await loaded;
      const activation = performance.now() - start;

      const guest = frame.contentWindow;
      if (guest === null) throw new Error("the settled frame has no realm window");
      const objects = guest.benchCountObjects();
      return {
        activation,
        objects,
        insertion: guest.benchInsert(options.count),
        move: guest.benchMove(options.moves),
      };
    },
    { guestURL, count: INSERTION_COUNT, moves: MOVE_COUNT },
  );
}

/**
 * The baseline fetches and parses the same document, then adopts its body into the host
 * tree — the closest plain-DOM analogue of what activation does, minus the facade.
 */
function measureHost(page: Page, guestURL: string): Promise<Omit<Sample, "heap">> {
  return page.evaluate(
    async (options) => {
      const host = document.querySelector("#host");
      if (host === null) throw new Error("host container is missing");

      const start = performance.now();
      const source = await (await fetch(options.guestURL)).text();
      const parsed = new DOMParser().parseFromString(source, "text/html");
      host.append(document.adoptNode(parsed.body));
      const activation = performance.now() - start;

      const bench = window as unknown as BenchWindow;
      return {
        activation,
        objects: bench.benchCountObjects(),
        insertion: bench.benchInsert(options.count),
        move: bench.benchMove(options.moves),
      };
    },
    { guestURL, count: INSERTION_COUNT, moves: MOVE_COUNT },
  );
}

async function sampleFrame(
  engine: BrowserType,
  browser: Browser,
  origin: string,
  size: number,
): Promise<Sample> {
  const page = await browser.newPage();
  const cdp = await openHeapSession(page, engine);
  try {
    await installBundle(page, origin);
    const before = await heapUsage(cdp);
    const timings = await measureFrame(page, `${origin}${guestPath(size)}`);
    return { ...timings, heap: heapDelta(await heapUsage(cdp), before) };
  } finally {
    await page.close();
  }
}

async function sampleHost(
  engine: BrowserType,
  browser: Browser,
  origin: string,
  size: number,
): Promise<Sample> {
  const page = await browser.newPage();
  const cdp = await openHeapSession(page, engine);
  try {
    await page.goto(`${origin}/baseline`);
    const before = await heapUsage(cdp);
    const timings = await measureHost(page, `${origin}${guestPath(size)}`);
    return { ...timings, heap: heapDelta(await heapUsage(cdp), before) };
  } finally {
    await page.close();
  }
}

/**
 * The churn measurement reads the heap between mounting and churning, and the heap
 * reading comes from node over CDP, so mounting cannot be part of the same evaluate.
 */
function mountBenchFrame(page: Page, guestURL: string): Promise<void> {
  return page.evaluate(async (url) => {
    const frame = document.createElement("v-frame") as BenchFrame;
    const loaded = new Promise<void>((settled) => {
      frame.addEventListener("v-frame-load", () => settled(), { once: true });
    });
    const host = document.querySelector("#host");
    if (host === null) throw new Error("host container is missing");

    frame.src = url;
    host.append(frame);
    await loaded;
    (window as BenchHost).benchGuest = frame.contentWindow;
  }, guestURL);
}

function adoptBenchGuest(page: Page, guestURL: string): Promise<void> {
  return page.evaluate(async (url) => {
    const host = document.querySelector("#host");
    if (host === null) throw new Error("host container is missing");
    const source = await (await fetch(url)).text();
    const parsed = new DOMParser().parseFromString(source, "text/html");
    host.append(document.adoptNode(parsed.body));
  }, guestURL);
}

const churnCounts = { rows: CHURN_ROWS, cycles: CHURN_CYCLES };

/**
 * Bytes of collected heap the churn leaves behind. Every row it creates is removed
 * and dropped before the reading is taken, so anything still retained is the
 * facade's own bookkeeping holding elements the guest no longer has.
 */
async function sampleFrameChurn(browser: Browser, origin: string): Promise<number> {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    await installBundle(page, origin);
    await mountBenchFrame(page, `${origin}${guestPath(CHURN_GUEST_SIZE)}`);
    const before = await settledHeapUsage(cdp);
    await page.evaluate((counts) => {
      const guest = (window as BenchHost).benchGuest;
      if (guest === undefined || guest === null) {
        throw new Error("the settled frame has no realm window");
      }
      guest.benchChurn(counts.rows, counts.cycles);
    }, churnCounts);
    return (await settledHeapUsage(cdp)) - before;
  } finally {
    await page.close();
  }
}

async function sampleHostChurn(browser: Browser, origin: string): Promise<number> {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(`${origin}/baseline`);
    await adoptBenchGuest(page, `${origin}${guestPath(CHURN_GUEST_SIZE)}`);
    const before = await settledHeapUsage(cdp);
    await page.evaluate((counts) => {
      (window as unknown as BenchWindow).benchChurn(counts.rows, counts.cycles);
    }, churnCounts);
    return (await settledHeapUsage(cdp)) - before;
  } finally {
    await page.close();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("no samples to summarize");
  return middle;
}

/** An engine that reports no heap reports none for every run, so one null is all null. */
function medianHeap(samples: Sample[]): number | null {
  const readings: number[] = [];
  for (const sample of samples) {
    if (sample.heap === null) return null;
    readings.push(sample.heap);
  }
  return median(readings);
}

function medianSample(samples: Sample[]): Sample {
  return {
    activation: median(samples.map((sample) => sample.activation)),
    insertion: median(samples.map((sample) => sample.insertion)),
    move: median(samples.map((sample) => sample.move)),
    heap: medianHeap(samples),
    objects: median(samples.map((sample) => sample.objects)),
  };
}

async function repeat(take: () => Promise<Sample>): Promise<Sample> {
  const samples: Sample[] = [];
  for (let run = 0; run < REPEATS; run += 1) {
    samples.push(await take());
  }
  return medianSample(samples);
}

async function repeatHeap(take: () => Promise<number>): Promise<number> {
  const samples: number[] = [];
  for (let run = 0; run < REPEATS; run += 1) {
    samples.push(await take());
  }
  return median(samples);
}

function ratio(frame: number, host: number): string {
  return host === 0 ? "n/a" : `${(frame / host).toFixed(1)}x`;
}

function milliseconds(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function kilobytes(value: number): string {
  return `${Math.round(value / 1024)} KB`;
}

/**
 * The per-node cost is the slope between the smallest and largest guest, which cancels
 * out the fixed cost of booting the realm and leaves the marking work on its own.
 */
function perNodeMicroseconds(
  measurements: Measurement[],
  mode: "frame" | "host",
): number {
  const first = measurements[0];
  const last = measurements[measurements.length - 1];
  if (first === undefined || last === undefined || first === last) return Number.NaN;
  const cost = last[mode].activation - first[mode].activation;
  return (cost * 1_000) / (last.size - first.size);
}

/** Rows for the engine that gives collected readings; a note for the one that does not. */
function reportHeap(measurements: Measurement[]): void {
  const rows: Record<string, number | string>[] = [];
  for (const measurement of measurements) {
    const frameHeap = measurement.frame.heap;
    const hostHeap = measurement.host.heap;
    if (frameHeap === null || hostHeap === null) {
      console.log("\nretained JS heap: not measurable on this engine");
      return;
    }
    rows.push({
      elements: measurement.size,
      "marked objects": measurement.frame.objects,
      "v-frame": kilobytes(frameHeap),
      "host DOM": kilobytes(hostHeap),
      "bytes/object": Math.round(frameHeap / measurement.frame.objects),
    });
  }
  console.log("\nretained JS heap after a forced collection");
  console.table(rows);
}

function report(measurements: Measurement[]): void {
  console.log("\nactivation — fetch, parse and insert the whole guest");
  console.table(
    measurements.map((measurement) => ({
      elements: measurement.size,
      "v-frame": milliseconds(measurement.frame.activation),
      "host DOM": milliseconds(measurement.host.activation),
      overhead: ratio(measurement.frame.activation, measurement.host.activation),
    })),
  );

  console.log(`\ninsertion — append ${INSERTION_COUNT} elements into the settled tree`);
  console.table(
    measurements.map((measurement) => ({
      elements: measurement.size,
      "v-frame": milliseconds(measurement.frame.insertion),
      "host DOM": milliseconds(measurement.host.insertion),
      overhead: ratio(measurement.frame.insertion, measurement.host.insertion),
    })),
  );

  console.log(`\nre-parent — move a settled subtree ${MOVE_COUNT} times`);
  console.table(
    measurements.map((measurement) => ({
      elements: measurement.size,
      "v-frame": milliseconds(measurement.frame.move),
      "host DOM": milliseconds(measurement.host.move),
      overhead: ratio(measurement.frame.move, measurement.host.move),
    })),
  );

  reportHeap(measurements);

  const frameSlope = perNodeMicroseconds(measurements, "frame");
  const hostSlope = perNodeMicroseconds(measurements, "host");
  console.log(
    `\nmarginal activation cost: v-frame ${frameSlope.toFixed(2)} µs/element, ` +
      `host DOM ${hostSlope.toFixed(2)} µs/element (${ratio(frameSlope, hostSlope)})`,
  );
}

function reportChurn(frameHeap: number, hostHeap: number): void {
  const rows = CHURN_ROWS * CHURN_CYCLES;
  console.log(
    `\nretention — ${rows} rows created, removed and dropped in a ` +
      `${CHURN_GUEST_SIZE}-element guest, collected heap`,
  );
  console.table([
    {
      rows,
      "v-frame": kilobytes(frameHeap),
      "host DOM": kilobytes(hostHeap),
      "bytes/row": Math.round(frameHeap / rows),
    },
  ]);
}

async function measureEngine(engine: BrowserType, origin: string): Promise<void> {
  const browser = await engine.launch();
  try {
    console.log(
      `\n=== ${engine.name()} ${browser.version()} on ` +
        `${cpus()[0]?.model ?? "unknown CPU"} ===`,
    );
    const measurements: Measurement[] = [];
    for (const size of GUEST_SIZES) {
      measurements.push({
        size,
        frame: await repeat(() => sampleFrame(engine, browser, origin, size)),
        host: await repeat(() => sampleHost(engine, browser, origin, size)),
      });
    }
    report(measurements);
    // The churn measurement has no timing half — what it reports is retained heap —
    // so it is skipped entirely rather than reported empty.
    if (measuresHeap(engine)) {
      reportChurn(
        await repeatHeap(() => sampleFrameChurn(browser, origin)),
        await repeatHeap(() => sampleHostChurn(browser, origin)),
      );
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(resolve(process.cwd(), "dist/index.js"))) {
    throw new Error("dist/index.js is missing — run `pnpm build` first");
  }

  const fixture = await startHTTPFixture({ routes: benchRoutes() });
  try {
    for (const engine of ENGINES) {
      await measureEngine(engine, fixture.origin);
    }
  } finally {
    await fixture.close();
  }
}

await main();
