import { abortError } from "./connect.js";

const CONTROL_SELECTOR = "input,textarea,select";
// Decoding is best-effort: a slow image or font must not hold the reveal forever.
const ASSET_SETTLE_TIMEOUT_MS = 10_000;

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Path = Array<number | "shadow">;

interface Value {
  value: string;
  checked?: boolean;
  selected?: boolean[];
  files?: FileList | null;
}

interface ControlPair {
  source: Control;
  initial: Value;
}

function controls(root: Element): Control[] {
  const result: Control[] = [];
  const visit = (scope: Element | ShadowRoot) => {
    for (const element of scope.querySelectorAll("*")) {
      if (element.matches(CONTROL_SELECTOR)) result.push(element as Control);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return result;
}

function read(control: Control): Value {
  if (control.localName === "select") {
    return {
      value: control.value,
      selected: Array.from(
        (control as HTMLSelectElement).options,
        (option) => option.selected,
      ),
    };
  }
  if (control.localName === "input") {
    const input = control as HTMLInputElement;
    return { value: input.value, checked: input.checked, files: input.files };
  }
  return { value: control.value };
}

function equal(left: Value, right: Value): boolean {
  return (
    left.value === right.value &&
    left.checked === right.checked &&
    JSON.stringify(left.selected) === JSON.stringify(right.selected) &&
    (left.files?.length ?? 0) === (right.files?.length ?? 0)
  );
}

/** Owns only the pending preview; disposal releases its listeners and references. */
export class AdoptionState {
  #preview: HTMLElement | null;
  readonly #root: ShadowRoot;
  readonly #lifetime = new AbortController();
  readonly #edited = new Set<Control>();
  readonly #composing = new Set<EventTarget>();
  readonly #compositionWaiters = new Set<() => void>();
  #live: HTMLElement | null = null;
  #window: (Window & typeof globalThis) | null = null;
  #pairs: ControlPair[] = [];
  #targets = new WeakMap<Element, Element>();

  constructor(preview: HTMLElement, root: ShadowRoot) {
    this.#preview = preview;
    this.#root = root;
    const sourceControl = (event: Event): Control | undefined => {
      const path = event.composedPath();
      if (!this.#preview || !path.includes(this.#preview)) return;
      return path.find(
        (target) =>
          "nodeType" in target &&
          target.nodeType === 1 &&
          (target as Element).matches(CONTROL_SELECTOR),
      ) as Control | undefined;
    };
    for (const type of ["input", "change"]) {
      root.addEventListener(
        type,
        (event) => {
          const source = sourceControl(event);
          if (!source) return;
          this.#edited.add(source);
          if ("isComposing" in event && event.isComposing) this.#composing.add(source);
          this.sync();
        },
        { capture: true, signal: this.#lifetime.signal },
      );
    }
    root.addEventListener(
      "compositionstart",
      (event) => {
        const source = sourceControl(event);
        if (source) this.#composing.add(source);
      },
      { capture: true, signal: this.#lifetime.signal },
    );
    root.addEventListener(
      "compositionend",
      (event) => {
        const source = sourceControl(event);
        if (source) this.#composing.delete(source);
        if (!this.#composing.size) {
          for (const resolve of this.#compositionWaiters) resolve();
          this.#compositionWaiters.clear();
        }
      },
      { capture: true, signal: this.#lifetime.signal },
    );
  }

  #path(node: Node): Path | null {
    const path: Path = [];
    const view = this.#root.ownerDocument.defaultView!;
    const parent = Object.getOwnPropertyDescriptor(
      view.Node.prototype,
      "parentNode",
    )!.get!;
    while (node !== this.#preview) {
      const next = parent.call(node) as Node | null;
      if (next) {
        path.unshift(Array.from(next.childNodes).indexOf(node as ChildNode));
        node = next;
      } else if ("host" in node) {
        path.unshift("shadow");
        node = (node as ShadowRoot).host;
      } else return null;
    }
    return path;
  }

  #resolve(path: Path): Node | null {
    let node: Node | null = this.#live;
    for (const step of path) {
      node =
        step === "shadow"
          ? ((node as Element)?.shadowRoot ?? null)
          : (node?.childNodes[step] ?? null);
      if (!node) break;
    }
    return node;
  }

  #target(
    source: Element,
    pair = this.#pairs.find((pair) => pair.source === source),
  ): Element | null {
    if (!this.#live) return null;
    const original = this.#targets.get(source);
    if (original?.isConnected) return original;
    const candidates = pair
      ? controls(this.#live)
      : Array.from(this.#live.querySelectorAll("[id]"));
    const compatible = (candidate: Element) =>
      candidate.localName === source.localName &&
      candidate.namespaceURI === source.namespaceURI &&
      (!pair || (candidate as Control).type === pair.source.type);
    if (source.id) {
      const matches = candidates.filter(
        (candidate) => candidate.id === source.id && compatible(candidate),
      );
      if (matches.length) return matches.length === 1 ? matches[0]! : null;
    }
    if (pair) {
      if (!pair.source.name) return null;
      const matches = candidates.filter(
        (candidate) =>
          (candidate as Control).name === pair.source.name &&
          compatible(candidate) &&
          (pair.source.type !== "radio" ||
            (candidate as Control).value === pair.source.value),
      );
      return matches.length === 1 ? matches[0]! : null;
    }
    return null;
  }

  connect(live: HTMLElement, window: Window & typeof globalThis): void {
    if (!this.#preview) return;
    this.#live = live;
    this.#window = window;
    const visit = (source: Element | ShadowRoot, target: Element | ShadowRoot) => {
      const targets = target.children;
      Array.from(source.children).forEach((element, index) => {
        const next = targets[index];
        if (
          !next ||
          next.localName !== element.localName ||
          next.namespaceURI !== element.namespaceURI
        )
          return;
        this.#targets.set(element, next);
        if (element.matches(CONTROL_SELECTOR)) {
          this.#pairs.push({
            source: element as Control,
            initial: read(next as Control),
          });
        }
        visit(element, next);
        if (element.shadowRoot && next.shadowRoot)
          visit(element.shadowRoot, next.shadowRoot);
      });
    };
    this.#targets.set(this.#preview, live);
    visit(this.#preview, live);
    this.sync();
  }

  #write(target: Control, source: Control, value: Value, replay: boolean): void {
    const window = this.#window!;
    if (target.localName === "select") {
      const select = target as HTMLSelectElement;
      const options = new Set(select.options);
      select.selectedIndex = -1;
      for (const option of (source as HTMLSelectElement).selectedOptions) {
        let next = this.#targets.get(option) as HTMLOptionElement | undefined;
        if (!next || !options.has(next)) {
          const candidates = Array.from(options);
          let matches = candidates.filter(
            (candidate) => option.id && candidate.id === option.id,
          );
          if (!matches.length)
            matches = candidates.filter((candidate) => candidate.value === option.value);
          next = matches.length === 1 ? matches[0] : undefined;
        }
        if (next) next.selected = true;
      }
    } else if (
      target.localName === "input" &&
      (target as HTMLInputElement).type === "file"
    ) {
      (target as HTMLInputElement).files = value.files ?? null;
    } else {
      const prototype =
        target.localName === "input"
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
      // Frameworks may track programmatic writes through an own value setter.
      // Reset that tracker, then use the browser setter for the user edit.
      if (replay && Object.getOwnPropertyDescriptor(target, "value")?.set) {
        target.value = (source as HTMLInputElement | HTMLTextAreaElement).defaultValue;
      }
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value.value);
    }
    let clicked = false;
    if (value.checked !== undefined) {
      const input = target as HTMLInputElement;
      if (
        replay &&
        !input.disabled &&
        (input.type === "checkbox" || (input.type === "radio" && value.checked))
      ) {
        input.checked = !value.checked;
        input.click();
        clicked = true;
        // An application may cancel the click's default action. The preview
        // value still wins, but the click already delivered its notifications.
        input.checked = value.checked;
      } else input.checked = value.checked;
    }
    if (replay && !clicked) {
      target.dispatchEvent(
        new window.InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertReplacementText",
        }),
      );
      target.dispatchEvent(new window.Event("change", { bubbles: true, composed: true }));
    }
  }

  sync(replay = false): void {
    if (!this.#live) return;
    for (const pair of this.#pairs) {
      if (this.#lifetime.signal.aborted) break;
      const value = read(pair.source);
      if (!this.#edited.has(pair.source) && equal(value, pair.initial)) continue;
      const target = this.#target(pair.source, pair) as Control | null;
      if (target) this.#write(target, pair.source, value, replay);
    }
  }

  async settle(signal: AbortSignal): Promise<void> {
    // A cloned, hidden image may not have decoded yet even when its preview is
    // already painted. Never expose that intermediate tree. Resource failures
    // settle normally; a stalled connection has a bounded activation wait.
    const view = this.#root.ownerDocument.defaultView!;
    const bounds = view.Element.prototype.getBoundingClientRect;
    const parent = Object.getOwnPropertyDescriptor(
      view.Node.prototype,
      "parentNode",
    )!.get!;
    const frame = bounds.call(this.#root.host);
    const visible = (image: HTMLImageElement) => {
      let left = Math.max(0, frame.left);
      let right = Math.min(view.innerWidth, frame.right);
      let top = Math.max(0, frame.top);
      let bottom = Math.min(view.innerHeight, frame.bottom);
      let node: Node | null = parent.call(image) as Node | null;
      while (node && node !== this.#root) {
        if (node.nodeType === 1) {
          const box = bounds.call(node as Element);
          const style = view.getComputedStyle(node as Element);
          if (style.overflowX !== "visible") {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
        }
        node =
          (parent.call(node) as Node | null) ??
          ("host" in node ? (node as ShadowRoot).host : null);
      }
      const box = bounds.call(image);
      return box.right > left && box.left < right && box.bottom > top && box.top < bottom;
    };
    const images = Array.from(this.#live?.querySelectorAll("img") ?? []).filter(
      (image) =>
        image.loading !== "lazy" || image.complete || image.currentSrc || visible(image),
    );
    const lazy = images
      .filter((image) => image.loading === "lazy" && !image.complete)
      .map((image) => {
        const loading = image.getAttribute("loading")!;
        // A staged tree is hidden. Prime only needed lazy images so its decoded
        // pixels are ready at reveal; restore the authored loading attribute.
        image.loading = "eager";
        return { image, loading };
      });
    const assets = [
      ...images.map((image) => image.decode()),
      this.#root.ownerDocument.fonts.ready,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, ASSET_SETTLE_TIMEOUT_MS);
        const aborted = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
          resolve();
        }
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        void Promise.allSettled(assets).then(done);
      });
    } finally {
      for (const { image, loading } of lazy) {
        if (image.getAttribute("loading") === "eager")
          image.setAttribute("loading", loading);
      }
    }
    if (signal.aborted) throw abortError();
    if (!this.#composing.size) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        this.#compositionWaiters.delete(done);
        reject(abortError());
      };
      this.#compositionWaiters.add(done);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  reveal(reveal: () => void): void {
    const preview = this.#preview;
    if (!preview) {
      reveal();
      return;
    }
    let active = this.#root.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const activePath = active ? this.#path(active) : null;
    const selection =
      active && "selectionStart" in active
        ? {
            start: (active as HTMLInputElement).selectionStart,
            end: (active as HTMLInputElement).selectionEnd,
            direction: (active as HTMLInputElement).selectionDirection,
          }
        : null;
    const scroll = [this.#root.host.scrollLeft, this.#root.host.scrollTop];
    const scrolled = [preview, ...Array.from(preview.querySelectorAll<HTMLElement>("*"))]
      .filter((element) => element.scrollLeft || element.scrollTop)
      .map((element) => ({
        path: this.#path(element),
        left: element.scrollLeft,
        top: element.scrollTop,
      }));
    this.sync(true);
    if (this.#lifetime.signal.aborted) return;
    reveal();
    const next =
      active && activePath ? (this.#target(active) as HTMLElement | null) : null;
    if (next && activePath) {
      next.focus({ preventScroll: true });
      if (
        selection?.start !== null &&
        selection?.start !== undefined &&
        selection.end !== null &&
        "selectionStart" in next &&
        (next as HTMLInputElement).selectionStart !== null
      ) {
        (next as HTMLInputElement).setSelectionRange(
          selection.start,
          selection.end,
          selection.direction ?? undefined,
        );
      }
    }
    for (const entry of scrolled) {
      if (!entry.path) continue;
      const element = this.#resolve(entry.path) as HTMLElement | null;
      if (element) {
        element.scrollLeft = entry.left;
        element.scrollTop = entry.top;
      }
    }
    this.#root.host.scrollLeft = scroll[0]!;
    this.#root.host.scrollTop = scroll[1]!;
    this.dispose();
  }

  dispose(): void {
    this.#lifetime.abort();
    this.#pairs = [];
    this.#targets = new WeakMap();
    this.#edited.clear();
    this.#composing.clear();
    this.#live = null;
    this.#window = null;
    this.#preview = null;
    for (const resolve of this.#compositionWaiters) resolve();
    this.#compositionWaiters.clear();
  }
}
