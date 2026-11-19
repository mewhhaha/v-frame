import { renderedBy } from "./staging.js";
import { abortError } from "./connect.js";
import { editableSelection, isEditingHost, syncEditable } from "./editable.js";

const CONTROL_SELECTOR = "input,textarea,select";
// Decoding is best-effort: a slow image or font must not hold the reveal forever.
const ASSET_SETTLE_TIMEOUT_MS = 10_000;

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

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

function visitPreview(
  scope: Element | ShadowRoot,
  visit: (node: Element | ShadowRoot) => void,
): void {
  visit(scope);
  for (const element of scope.querySelectorAll("*")) {
    visit(element);
    if (element.shadowRoot) visitPreview(element.shadowRoot, visit);
  }
}

function unique<T>(matches: T[]): T | null {
  if (matches.length === 1) return matches[0]!;
  return null;
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
  readonly #edited = new Set<HTMLElement>();
  readonly #formatting = new WeakMap<Element, Set<string>>();
  readonly #formatObserver = new MutationObserver((records) =>
    this.#recordFormat(records),
  );
  readonly #composing = new Set<EventTarget>();
  #finishComposition: (() => void) | undefined;
  #live: HTMLElement | null = null;
  #window: (Window & typeof globalThis) | null = null;
  #pairs: ControlPair[] = [];
  #disclosures: Array<{
    source: HTMLDetailsElement;
    previous: boolean;
    edited: boolean;
  }> = [];
  #targets = new WeakMap<Element, Element>();
  readonly #initialChildren = new Map<Element | ShadowRoot, Element[]>();

  constructor(preview: HTMLElement, root: ShadowRoot) {
    this.#preview = preview;
    this.#root = root;
    // The realm starts asynchronously. Pair its copy with the same elements
    // that were serialized, even if pressing Enter has split a paragraph since.
    visitPreview(preview, (parent) => {
      if (parent === preview || parent.nodeType === 11)
        this.#formatObserver.observe(parent, {
          subtree: true,
          attributeFilter: [
            "style",
            "align",
            "dir",
            "color",
            "face",
            "size",
            "href",
            "class",
          ],
        });
      if (parent.firstElementChild)
        this.#initialChildren.set(parent, Array.from(parent.children));
    });
    const onEdit = (event: Event): void => {
      const path = event.composedPath();
      if (!path.includes(preview)) return;
      const source = path.find(
        (target) =>
          (target as Node).nodeType === 1 &&
          ((target as Element).matches(CONTROL_SELECTOR) ||
            isEditingHost(target as Element)),
      ) as HTMLElement | undefined;
      if (!source) return;
      if (event.type === "compositionend") {
        this.#composing.delete(source);
        if (!this.#composing.size) this.#finishComposition?.();
        return;
      }
      if (event.type === "compositionstart" || (event as InputEvent).isComposing) {
        this.#composing.add(source);
      }
      if (event.type !== "compositionstart") {
        this.#edited.add(source);
        this.sync();
      }
    };
    for (const type of ["input", "change", "compositionstart", "compositionend"]) {
      root.addEventListener(type, onEdit, {
        capture: true,
        signal: this.#lifetime.signal,
      });
    }
  }

  #recordFormat(records: MutationRecord[]): void {
    for (const { target, attributeName } of records) {
      const element = target as HTMLElement;
      if (!element.isContentEditable) continue;
      const names = this.#formatting.get(element) ?? new Set<string>();
      names.add(attributeName!);
      this.#formatting.set(element, names);
    }
  }

  #contains(root: Element, node: Node): boolean {
    return renderedBy(root, node, this.#root.ownerDocument.defaultView!);
  }

  #target(
    source: Element,
    pair = this.#pairs.find((pair) => pair.source === source),
  ): Element | null {
    if (!this.#live) return null;
    const editing = isEditingHost(source);
    const compatible = (candidate: Element) =>
      candidate.localName === source.localName &&
      candidate.namespaceURI === source.namespaceURI &&
      (!editing || isEditingHost(candidate)) &&
      (!pair || (candidate as Control).type === pair.source.type);
    const original = this.#targets.get(source);
    if (original && this.#contains(this.#live, original) && compatible(original))
      return original;
    // IDs and form-control names are local to their original tree. A removed
    // field must never hand its draft to an unrelated component with the same ID.
    const native = this.#root.ownerDocument.defaultView!.Node.prototype;
    const sourceTree = native.getRootNode.call(source);
    let sourceScope: ParentNode = this.#preview!;
    let scope: ParentNode = this.#live;
    if (sourceTree !== this.#root && sourceTree !== this.#preview) {
      if (!("host" in sourceTree)) return null;
      const host = this.#target((sourceTree as ShadowRoot).host);
      if (!host?.shadowRoot) return null;
      sourceScope = sourceTree as ShadowRoot;
      scope = host.shadowRoot;
    }
    let form: Element | null = null;
    if (pair && pair.source.form) {
      form = this.#target(pair.source.form);
      if (!form) return null;
    }
    const candidates = Array.from(scope.querySelectorAll("*")).filter(
      (candidate) =>
        compatible(candidate) && (!pair || (candidate as Control).form === form),
    );
    if (source.id) {
      const matches = candidates.filter((candidate) => candidate.id === source.id);
      if (matches.length) return unique(matches);
    }
    if (source.localName === "form") {
      const name = source.getAttribute("name");
      if (!name) return null;
      // A removed form may share its name with a surviving sibling.
      const named = (candidate: Element) =>
        candidate.namespaceURI === source.namespaceURI &&
        candidate.getAttribute("name") === name;
      if (Array.from(sourceScope.querySelectorAll("form")).filter(named).length !== 1)
        return null;
      const matches = candidates.filter(named);
      return unique(matches);
    }
    if (pair) {
      if (!pair.source.name) return null;
      const matches = candidates.filter(
        (candidate) =>
          (candidate as Control).name === pair.source.name &&
          (pair.source.type !== "radio" ||
            (candidate as Control).value === pair.source.value),
      );
      return unique(matches);
    }
    return null;
  }

  connect(live: HTMLElement, window: Window & typeof globalThis): void {
    if (!this.#preview) return;
    this.#live = live;
    this.#window = window;
    this.#targets.set(this.#preview, live);
    for (const [source, children] of this.#initialChildren) {
      let target: Element | ShadowRoot | null | undefined;
      if (source.nodeType === 11)
        target = this.#targets.get((source as ShadowRoot).host)?.shadowRoot;
      else target = this.#targets.get(source as Element);
      if (!target) continue;
      const targets = target.children;
      children.forEach((element, index) => {
        const next = targets[index];
        if (
          !next ||
          next.localName !== element.localName ||
          next.namespaceURI !== element.namespaceURI
        )
          return;
        this.#targets.set(element, next);
        if (element.localName === "details") {
          this.#disclosures.push({
            source: element as HTMLDetailsElement,
            previous: (next as HTMLDetailsElement).open,
            edited: false,
          });
        }
        if (element.matches(CONTROL_SELECTOR)) {
          this.#pairs.push({
            source: element as Control,
            initial: read(next as Control),
          });
        }
      });
    }
    this.#initialChildren.clear();
    this.sync();
  }

  #notifyInput(target: Element): void {
    target.dispatchEvent(
      new this.#window!.InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertReplacementText",
      }),
    );
  }

  #write(target: Control, source: Control, value: Value, replay: boolean): void {
    const window = this.#window!;
    if (target.localName === "select") {
      const select = target as HTMLSelectElement;
      const options = new Set(select.options);
      select.selectedIndex = -1;
      for (const option of (source as HTMLSelectElement).selectedOptions) {
        let next = this.#targets.get(option) as HTMLOptionElement | null | undefined;
        if (!next || !options.has(next)) {
          const candidates = Array.from(options);
          let matches = candidates.filter(
            (candidate) => option.id && candidate.id === option.id,
          );
          if (!matches.length)
            matches = candidates.filter((candidate) => candidate.value === option.value);
          next = unique(matches);
        }
        if (next) next.selected = true;
      }
    } else if (
      target.localName === "input" &&
      (target as HTMLInputElement).type === "file"
    ) {
      (target as HTMLInputElement).files = value.files ?? null;
    } else if (target.type !== "checkbox" && target.type !== "radio") {
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
    if (value.checked !== undefined) {
      const input = target as HTMLInputElement;
      // Native radio groups notify only the newly selected control.
      if (input.type === "radio" && !value.checked) {
        input.checked = false;
        return;
      }
      if (
        replay &&
        !input.disabled &&
        (input.type === "checkbox" || input.type === "radio")
      ) {
        input.checked = !value.checked;
        input.click();
        // An application may cancel the click's default action. The preview
        // value still wins, but the click already delivered its notifications.
        input.checked = value.checked;
        return;
      }
      input.checked = value.checked;
    }
    if (replay) {
      this.#notifyInput(target);
      target.dispatchEvent(new window.Event("change", { bubbles: true, composed: true }));
    }
  }

  sync(replay = false): void {
    if (!this.#live) return;
    this.#recordFormat(this.#formatObserver.takeRecords());
    for (const disclosure of this.#disclosures) {
      const { source } = disclosure;
      if (source.open !== disclosure.previous) disclosure.edited = true;
      disclosure.previous = source.open;
      if (!disclosure.edited) continue;
      const target = this.#target(source) as HTMLDetailsElement | null;
      if (target && target.open !== source.open) target.open = source.open;
    }
    for (const pair of this.#pairs) {
      if (this.#lifetime.signal.aborted) break;
      const value = read(pair.source);
      if (!this.#edited.has(pair.source) && equal(value, pair.initial)) continue;
      const target = this.#target(pair.source, pair) as Control | null;
      if (target) this.#write(target, pair.source, value, replay);
    }
    for (const source of this.#edited) {
      if (this.#lifetime.signal.aborted) break;
      if (!isEditingHost(source)) continue;
      const target = this.#target(source);
      if (!target) continue;
      syncEditable(source, target, this.#targets, this.#formatting);
      if (replay) this.#notifyInput(target);
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
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ASSET_SETTLE_TIMEOUT_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
        void Promise.allSettled(assets).then(done);
      });
    } finally {
      for (const { image, loading } of lazy) {
        if (image.getAttribute("loading") === "eager")
          image.setAttribute("loading", loading);
      }
    }
    if (!signal.aborted && this.#composing.size) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          this.#finishComposition = undefined;
          resolve();
        };
        this.#finishComposition = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (signal.aborted) throw abortError();
  }

  reveal(reveal: () => void): void {
    const preview = this.#preview;
    if (!preview) {
      reveal();
      return;
    }
    let active = this.#root.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active && !this.#contains(preview, active)) active = null;
    const selection =
      active && "selectionStart" in active
        ? {
            start: (active as HTMLInputElement).selectionStart,
            end: (active as HTMLInputElement).selectionEnd,
            direction: (active as HTMLInputElement).selectionDirection,
          }
        : null;
    const scroll = [this.#root.host.scrollLeft, this.#root.host.scrollTop];
    const scrolled: Array<{ source: Element; left: number; top: number }> = [];
    visitPreview(preview, (source) => {
      if ("scrollTop" in source && (source.scrollTop || source.scrollLeft))
        scrolled.push({ source, left: source.scrollLeft, top: source.scrollTop });
    });
    this.sync(true);
    if (this.#lifetime.signal.aborted) return;
    // External form ownership is lost as soon as the preview is detached.
    const next = active ? (this.#target(active) as HTMLElement | null) : null;
    const restoreSelection =
      active && next && isEditingHost(active)
        ? editableSelection(active, next, this.#targets)
        : undefined;
    reveal();
    if (next && this.#live && this.#contains(this.#live, next)) {
      next.focus({ preventScroll: true });
      restoreSelection?.();
      if (
        selection?.start != null &&
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
      const element = this.#target(entry.source);
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
    this.#formatObserver.disconnect();
    this.#initialChildren.clear();
    this.#pairs = [];
    this.#disclosures = [];
    this.#targets = new WeakMap();
    this.#edited.clear();
    this.#composing.clear();
    this.#live = null;
    this.#window = null;
    this.#preview = null;
    this.#finishComposition?.();
  }
}
