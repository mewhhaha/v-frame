type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Path = Array<number | "shadow">;

interface Value {
  value: string;
  checked?: boolean;
  selected?: boolean[];
  files?: FileList | null;
}

function controls(root: Element): Control[] {
  const result: Control[] = [];
  const visit = (scope: Element | ShadowRoot) => {
    for (const element of scope.querySelectorAll("*")) {
      if (element.matches("input,textarea,select")) result.push(element as Control);
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
  #pairs: Array<{ source: Control; target: Control; initial: Value; path: Path }> = [];

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
          (target as Element).matches("input,textarea,select"),
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

  connect(live: HTMLElement, window: Window & typeof globalThis): void {
    if (!this.#preview) return;
    this.#live = live;
    this.#window = window;
    const targets = controls(live);
    this.#pairs = controls(this.#preview).flatMap((source, index) => {
      const target = targets[index];
      const path = this.#path(source);
      return target && path && target.localName === source.localName
        ? [{ source, target, initial: read(target), path }]
        : [];
    });
    this.sync();
  }

  #write(target: Control, source: Control, value: Value, replay: boolean): void {
    const window = this.#window!;
    if (target.localName === "select") {
      Array.from((target as HTMLSelectElement).options).forEach((option, index) => {
        option.selected = value.selected?.[index] ?? false;
      });
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
      const value = read(pair.source);
      if (!this.#edited.has(pair.source) && equal(value, pair.initial)) continue;
      const target = pair.target.isConnected
        ? pair.target
        : (this.#resolve(pair.path) as Control | null);
      if (target?.localName === pair.source.localName)
        this.#write(target, pair.source, value, replay);
    }
  }

  async settle(signal: AbortSignal): Promise<void> {
    // A cloned, hidden image may not have decoded yet even when its preview is
    // already painted. Never expose that intermediate tree. Resource failures
    // settle normally; a stalled connection has a bounded activation wait.
    const assets = [
      ...Array.from(this.#live?.querySelectorAll("img") ?? [], (image) => image.decode()),
      this.#root.ownerDocument.fonts.ready,
    ];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, 10_000);
      const aborted = () => {
        clearTimeout(timer);
        reject(new DOMException("The v-frame load was superseded", "AbortError"));
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
    if (signal.aborted)
      throw new DOMException("The v-frame load was superseded", "AbortError");
    if (!this.#composing.size) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        this.#compositionWaiters.delete(done);
        reject(new DOMException("The v-frame load was superseded", "AbortError"));
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
    reveal();
    const next = activePath ? (this.#resolve(activePath) as HTMLElement | null) : null;
    if (next && activePath) {
      next.focus({ preventScroll: true });
      if (
        selection?.start !== null &&
        selection?.start !== undefined &&
        selection.end !== null
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
    this.#edited.clear();
    this.#composing.clear();
    this.#live = null;
    this.#window = null;
    this.#preview = null;
    for (const resolve of this.#compositionWaiters) resolve();
    this.#compositionWaiters.clear();
  }
}
