/**
 * Measures finding C3 of docs/cleanup-plan.md: what the facade's per-node own-property
 * installation (`markVirtualNode`) costs on the hot DOM path.
 *
 * Every configuration is measured twice — once through a mounted v-frame, once as the
 * same markup parsed and inserted straight into the host document — so the numbers are
 * an overhead multiple rather than an unanchored millisecond count. Run it with
 * `pnpm bench`; it drives headless chromium because the heap readings come from CDP.
 */
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  type Route,
  startHTTPFixture,
} from "../tests/support/http-fixture.js";
import { installBundle } from "../tests/support/mount-frame.js";

/** Element counts of the guest document, chosen to expose a per-node slope. */
const GUEST_SIZES = [1_000, 5_000, 20_000, 50_000];
/** Elements appended one by one into an already-mounted guest. */
const INSERTION_COUNT = 1_000;
/** Each configuration is sampled this many times and reported as a median. */
const REPEATS = 3;

interface BenchWindow extends Window {
  benchInsert(count: number): number;
  benchCountObjects(): number;
}

interface BenchFrame extends HTMLElement {
  src: string;
  readonly contentWindow: BenchWindow | null;
}

interface Sample {
  /** Milliseconds from assigning `src` to `v-frame-load`, network and parse included. */
  activation: number;
  /** Milliseconds to append `INSERTION_COUNT` elements into the settled tree. */
  insertion: number;
  /** Bytes of JS heap the whole configuration retains, after a forced collection. */
  heap: number;
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

/** A collected heap reading; without the forced GC the deltas are pure noise. */
async function heapUsage(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return usage.usedSize;
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
      return { activation, objects, insertion: guest.benchInsert(options.count) };
    },
    { guestURL, count: INSERTION_COUNT },
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
      };
    },
    { guestURL, count: INSERTION_COUNT },
  );
}

async function sampleFrame(
  browser: Browser,
  origin: string,
  size: number,
): Promise<Sample> {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    await installBundle(page, origin);
    const before = await heapUsage(cdp);
    const timings = await measureFrame(page, `${origin}${guestPath(size)}`);
    return { ...timings, heap: (await heapUsage(cdp)) - before };
  } finally {
    await page.close();
  }
}

async function sampleHost(
  browser: Browser,
  origin: string,
  size: number,
): Promise<Sample> {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(`${origin}/baseline`);
    const before = await heapUsage(cdp);
    const timings = await measureHost(page, `${origin}${guestPath(size)}`);
    return { ...timings, heap: (await heapUsage(cdp)) - before };
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

function medianSample(samples: Sample[]): Sample {
  return {
    activation: median(samples.map((sample) => sample.activation)),
    insertion: median(samples.map((sample) => sample.insertion)),
    heap: median(samples.map((sample) => sample.heap)),
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

  console.log("\nretained JS heap after a forced collection");
  console.table(
    measurements.map((measurement) => ({
      elements: measurement.size,
      "marked objects": measurement.frame.objects,
      "v-frame": kilobytes(measurement.frame.heap),
      "host DOM": kilobytes(measurement.host.heap),
      "bytes/object": Math.round(measurement.frame.heap / measurement.frame.objects),
    })),
  );

  const frameSlope = perNodeMicroseconds(measurements, "frame");
  const hostSlope = perNodeMicroseconds(measurements, "host");
  console.log(
    `\nmarginal activation cost: v-frame ${frameSlope.toFixed(2)} µs/element, ` +
      `host DOM ${hostSlope.toFixed(2)} µs/element (${ratio(frameSlope, hostSlope)})`,
  );
}

async function main(): Promise<void> {
  if (!existsSync(resolve(process.cwd(), "dist/index.js"))) {
    throw new Error("dist/index.js is missing — run `pnpm build` first");
  }

  const fixture = await startHTTPFixture({ routes: benchRoutes() });
  const browser = await chromium.launch();
  try {
    console.log(`chromium ${browser.version()} on ${cpus()[0]?.model ?? "unknown CPU"}`);
    const measurements: Measurement[] = [];
    for (const size of GUEST_SIZES) {
      measurements.push({
        size,
        frame: await repeat(() => sampleFrame(browser, fixture.origin, size)),
        host: await repeat(() => sampleHost(browser, fixture.origin, size)),
      });
    }
    report(measurements);
  } finally {
    await browser.close();
    await fixture.close();
  }
}

await main();
