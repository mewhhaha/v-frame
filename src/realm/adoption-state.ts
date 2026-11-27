import { renderedBy } from "./staging.js";
import { abortError } from "./connect.js";
import {
  EditableWidgets,
  editableSelection,
  isEditingHost,
  syncEditable,
} from "./editable.js";

const CONTROL_SELECTOR = "input,textarea,select";
// Decoding is best-effort: a slow image or font must not hold the reveal forever.
const ASSET_SETTLE_TIMEOUT_MS = 10_000;

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Scope = Element | ShadowRoot;

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

function getter<T>(prototype: object, name: string): (target: object) => T {
  const read = Object.getOwnPropertyDescriptor(prototype, name)!.get!;
  return (target) => read.call(target) as T;
}

// Form controls can shadow inherited DOM members on their form.
function adoptionDOM(view: Window & typeof globalThis) {
  const node = view.Node.prototype;
  const element = view.Element.prototype;
  const fragment = view.DocumentFragment.prototype;
  const nodeType = getter<number>(node, "nodeType");
  const elementChildren = getter<HTMLCollection>(element, "children");
  const shadowChildren = getter<HTMLCollection>(fragment, "children");
  return {
    nodeType,
    getRootNode: node.getRootNode,
    localName: getter<string>(element, "localName"),
    namespaceURI: getter<string | null>(element, "namespaceURI"),
    shadowRoot: getter<ShadowRoot | null>(element, "shadowRoot"),
    getAttribute: element.getAttribute,
    matches: element.matches,
    children(scope: Scope) {
      if (nodeType(scope) === 11) return shadowChildren(scope);
      return elementChildren(scope);
    },
    query(scope: Scope, selector: string): Element[] {
      if (nodeType(scope) === 11) {
        return Array.from(fragment.querySelectorAll.call(scope, selector));
      }
      return Array.from(element.querySelectorAll.call(scope, selector));
    },
  };
}

type AdoptionDOM = ReturnType<typeof adoptionDOM>;

function visitPreview(
  dom: AdoptionDOM,
  scope: Scope,
  visit: (node: Scope) => void,
): void {
  visit(scope);
  for (const element of dom.query(scope, "*")) {
    visit(element);
    const shadow = dom.shadowRoot(element);
    if (shadow) visitPreview(dom, shadow, visit);
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
  readonly #dom: AdoptionDOM;
  readonly #lifetime = new AbortController();
  readonly #edited = new Set<HTMLElement>();
  readonly #formatting = new WeakMap<Element, Set<string>>();
  readonly #editableWidgets = new EditableWidgets();
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
    this.#dom = adoptionDOM(root.ownerDocument.defaultView!);
    // The realm starts asynchronously. Pair its copy with the same elements
    // that were serialized, even if pressing Enter has split a paragraph since.
    const Input = preview.ownerDocument.defaultView!.HTMLInputElement;
    visitPreview(this.#dom, preview, (parent) => {
      // Hand-authored previews may predate the server's readonly safeguard.
      if (parent instanceof Input && parent.type === "number" && !parent.readOnly)
        parent.readOnly = true;
      if (parent === preview || this.#dom.nodeType(parent) === 11)
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
      const children = this.#dom.children(parent);
      if (children.length) this.#initialChildren.set(parent, Array.from(children));
    });
    const onEdit = (event: Event): void => {
      const path = event.composedPath();
      if (!path.includes(preview)) return;
      const source = path.find(
        (target) =>
          "nodeType" in target &&
          this.#dom.nodeType(target) === 1 &&
          (this.#dom.matches.call(target, CONTROL_SELECTOR) ||
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
    const dom = this.#dom;
    const tag = dom.localName(source);
    const namespace = dom.namespaceURI(source);
    const editing = isEditingHost(source);
    const compatible = (candidate: Element) =>
      dom.localName(candidate) === tag &&
      dom.namespaceURI(candidate) === namespace &&
      (!editing || isEditingHost(candidate)) &&
      (!pair || (candidate as Control).type === pair.source.type);
    const original = this.#targets.get(source);
    if (original && this.#contains(this.#live, original) && compatible(original))
      return original;
    // IDs and form-control names are local to their original tree. A removed
    // field must never hand its draft to an unrelated component with the same ID.
    const sourceTree = dom.getRootNode.call(source);
    let sourceScope: Scope = this.#preview!;
    let scope: Scope = this.#live;
    if (sourceTree !== this.#root && sourceTree !== this.#preview) {
      if (dom.nodeType(sourceTree) !== 11 || !("host" in sourceTree)) return null;
      const host = this.#target((sourceTree as ShadowRoot).host);
      const shadow = host && dom.shadowRoot(host);
      if (!shadow) return null;
      sourceScope = sourceTree as ShadowRoot;
      scope = shadow;
    }
    const sourceForm = pair?.source.form ?? null;
    let form: Element | null = null;
    if (sourceForm) {
      form = this.#target(sourceForm);
      if (!form) return null;
    }
    const candidates = dom
      .query(scope, "*")
      .filter(
        (candidate) =>
          compatible(candidate) && (!pair || (candidate as Control).form === form),
      );
    const match = (matches: Element[], key: (candidate: Element) => boolean) => {
      const target = unique(matches);
      if (!target) return null;
      const originals = dom
        .query(sourceScope, "*")
        .filter(
          (candidate) =>
            compatible(candidate) &&
            (!pair || (candidate as Control).form === sourceForm) &&
            key(candidate),
        );
      if (unique(originals) === source) return target;
      return null;
    };
    const id = dom.getAttribute.call(source, "id");
    if (id) {
      const keyed = (candidate: Element) => dom.getAttribute.call(candidate, "id") === id;
      const matches = candidates.filter(keyed);
      if (matches.length) return match(matches, keyed);
    }
    if (tag === "form") {
      const name = dom.getAttribute.call(source, "name");
      if (!name) return null;
      const named = (candidate: Element) =>
        dom.getAttribute.call(candidate, "name") === name;
      return match(candidates.filter(named), named);
    }
    if (pair) {
      if (!pair.source.name) return null;
      const named = (candidate: Element) =>
        (candidate as Control).name === pair.source.name &&
        (pair.source.type !== "radio" ||
          (candidate as Control).value === pair.source.value);
      return match(candidates.filter(named), named);
    }
    return null;
  }

  connect(live: HTMLElement, window: Window & typeof globalThis): void {
    if (!this.#preview) return;
    this.#live = live;
    this.#window = window;
    this.#targets.set(this.#preview, live);
    const dom = this.#dom;
    for (const [source, children] of this.#initialChildren) {
      this.#editableWidgets.capture(source, children);
      let target: Element | ShadowRoot | null | undefined;
      if (dom.nodeType(source) === 11) {
        const host = this.#targets.get((source as ShadowRoot).host);
        target = host && dom.shadowRoot(host);
      } else target = this.#targets.get(source as Element);
      if (!target) continue;
      const targets = dom.children(target);
      children.forEach((element, index) => {
        const next = targets[index];
        const tag = dom.localName(element);
        if (
          !next ||
          dom.localName(next) !== tag ||
          dom.namespaceURI(next) !== dom.namespaceURI(element)
        )
          return;
        this.#targets.set(element, next);
        if (tag === "details") {
          this.#disclosures.push({
            source: element as HTMLDetailsElement,
            previous: (next as HTMLDetailsElement).open,
            edited: false,
          });
        }
        if (dom.matches.call(element, CONTROL_SELECTOR)) {
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
      syncEditable(
        source,
        target,
        this.#targets,
        this.#formatting,
        this.#editableWidgets,
      );
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
    interface ClipRect {
      left: number;
      right: number;
      top: number;
      bottom: number;
    }
    const rootClip: ClipRect = {
      left: Math.max(0, frame.left),
      right: Math.min(view.innerWidth, frame.right),
      top: Math.max(0, frame.top),
      bottom: Math.min(view.innerHeight, frame.bottom),
    };
    // Memoize ancestor clip geometry within this synchronous read-only visibility
    // pass so lazy galleries do not recompute getComputedStyle/getBoundingClientRect
    // for shared containers on every image.
    const clipCache = new Map<Node, ClipRect>();
    const ancestorClip = (node: Node | null): ClipRect => {
      if (node === null || node === this.#root) return rootClip;
      const cached = clipCache.get(node);
      if (cached !== undefined) return cached;
      const nextParent =
        (parent.call(node) as Node | null) ??
        ("host" in node ? (node as ShadowRoot).host : null);
      let clip = ancestorClip(nextParent);
      if (node.nodeType === 1) {
        const style = view.getComputedStyle(node as Element);
        const clipX = style.overflowX !== "visible";
        const clipY = style.overflowY !== "visible";
        if (clipX || clipY) {
          const box = bounds.call(node as Element);
          clip = {
            left: clipX ? Math.max(clip.left, box.left) : clip.left,
            right: clipX ? Math.min(clip.right, box.right) : clip.right,
            top: clipY ? Math.max(clip.top, box.top) : clip.top,
            bottom: clipY ? Math.min(clip.bottom, box.bottom) : clip.bottom,
          };
        }
      }
      clipCache.set(node, clip);
      return clip;
    };
    const visible = (image: HTMLImageElement) => {
      const clip = ancestorClip(parent.call(image) as Node | null);
      const box = bounds.call(image);
      return (
        box.right > clip.left &&
        box.left < clip.right &&
        box.bottom > clip.top &&
        box.top < clip.bottom
      );
    };
    const images = Array.from(this.#live?.querySelectorAll("img") ?? []).filter(
      (image) =>
        image.loading !== "lazy" || image.complete || image.currentSrc || visible(image),
    );
    clipCache.clear();
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
    while (active) {
      const deeper = this.#dom.shadowRoot(active)?.activeElement;
      if (!deeper) break;
      active = deeper;
    }
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
    const view = this.#root.ownerDocument.defaultView!;
    const scrollLeft = Object.getOwnPropertyDescriptor(
      view.Element.prototype,
      "scrollLeft",
    )!;
    const scrollTop = Object.getOwnPropertyDescriptor(
      view.Element.prototype,
      "scrollTop",
    )!;
    const scrolled: Array<{ source: Element; left: number; top: number }> = [];
    visitPreview(this.#dom, preview, (source) => {
      if (this.#dom.nodeType(source) !== 1) return;
      const left: number = scrollLeft.get!.call(source);
      const top: number = scrollTop.get!.call(source);
      if (left || top) scrolled.push({ source: source as Element, left, top });
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
      if (
        this.#dom.localName(next) === "form" &&
        this.#dom.namespaceURI(next) === "http://www.w3.org/1999/xhtml"
      )
        view.HTMLElement.prototype.focus.call(next, { preventScroll: true });
      else next.focus({ preventScroll: true });
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
        scrollLeft.set!.call(element, entry.left);
        scrollTop.set!.call(element, entry.top);
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
