import { expect, test, type Page } from "@playwright/test";
import {
  type ContractFixtureServers,
  startContractFixtureServers,
} from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

type Child = Window & typeof globalThis;

// Shared by every test body below. A body is serialized into the page, so it
// cannot close over anything: what it needs arrives as these two arguments.
const HELPERS = `({
  outcome(run) {
    try {
      return { value: run() };
    } catch (error) {
      return { error: error.name };
    }
  },
})`;

interface Helpers {
  outcome<T>(run: () => T): { value?: T; error?: string };
}

async function mountFacadeFrame(page: Page): Promise<void> {
  await installBundle(page, fixture.origin);
  await mountFrame(page, {
    src: `${fixture.origin}/documents/dom.html`,
    id: "facade-frame",
  });
}

function inChild<T>(
  page: Page,
  run: (child: Child, helpers: Helpers) => T | Promise<T>,
): Promise<T> {
  return page.evaluate(
    async ([source, helperSource]) => {
      const frame = document.querySelector("#facade-frame") as HTMLElement & {
        contentWindow: Child | null;
      };
      const helpers = new Function(`return ${helperSource}`)();
      const body = new Function("child", "helpers", `return (${source})(child, helpers)`);
      return await body(frame.contentWindow, helpers);
    },
    [run.toString(), HELPERS] as const,
  ) as Promise<T>;
}

test("hands out collections that pass native brand checks", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const brand = (value: unknown, constructor: Function) => ({
      isArray: Array.isArray(value),
      instance: value instanceof constructor,
      tag: Object.prototype.toString.call(value),
      hasMap: typeof (value as { map?: unknown }).map,
      hasPush: typeof (value as { push?: unknown }).push,
    });
    const doc = child.document;
    const root = doc.querySelector("#dom-root")!;
    return {
      // No selector translation: the browser's own list.
      element: brand(root.querySelectorAll("button"), child.NodeList),
      // Translated shell selectors build a merged list.
      shell: brand(doc.querySelectorAll("html, body"), child.NodeList),
      shellElement: brand(doc.body.querySelectorAll("body, button"), child.NodeList),
      shellLength: doc.querySelectorAll("html, body").length,
      childNodes: brand(doc.childNodes, child.NodeList),
      children: brand(doc.children, child.HTMLCollection),
      rects: brand(root.getClientRects(), child.DOMRectList),
      rectItem: root.getClientRects().item(0) instanceof child.DOMRect,
      tagName: brand(doc.getElementsByTagName("html"), child.HTMLCollection),
      byName: brand(doc.getElementsByName("none"), child.NodeList),
      iterates: Array.from(doc.querySelectorAll("html, body")).length,
      forEach: (() => {
        let count = 0;
        doc.querySelectorAll("html, body").forEach(() => (count += 1));
        return count;
      })(),
      indexed: doc.querySelectorAll("html, body")[0] === doc.documentElement,
      item: doc.children.item(0) === doc.documentElement,
    };
  });

  const nodeList = {
    isArray: false,
    instance: true,
    tag: "[object NodeList]",
    hasMap: "undefined",
    hasPush: "undefined",
  };
  const collection = { ...nodeList, tag: "[object HTMLCollection]" };
  expect(result.element).toEqual(nodeList);
  expect(result.shell).toEqual(nodeList);
  expect(result.shellElement).toEqual(nodeList);
  expect(result.shellLength).toBe(2);
  expect(result.childNodes).toEqual(nodeList);
  expect(result.children).toEqual(collection);
  expect(result.rects).toEqual({
    ...nodeList,
    tag: "[object DOMRectList]",
  });
  expect(result.rectItem).toBe(true);
  expect(result.tagName).toEqual(collection);
  expect(result.byName).toEqual(nodeList);
  expect(result.iterates).toBe(2);
  expect(result.forEach).toBe(2);
  expect(result.indexed).toBe(true);
  expect(result.item).toBe(true);
});

test("keeps live collections correct and stable without per-collection bookkeeping", async ({
  page,
}) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const doc = child.document;
    // Many distinct names must not make later mutations or lookups slower or
    // wrong: each collection answers from a version, not from a registered
    // invalidator.
    for (let index = 0; index < 500; index += 1) {
      doc.getElementsByTagName(`probe-${index}`);
      doc.getElementsByClassName(`probe-${index}`);
      doc.getElementsByName(`probe-${index}`);
    }
    const heads = doc.getElementsByTagName("head");
    const bodies = doc.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "body");
    const named = doc.getElementsByName("late");
    const before = [heads.length, bodies.length, named.length];
    const late = doc.createElement("input");
    late.setAttribute("name", "late");
    doc.body.append(late);
    const after = [heads.length, bodies.length, named.length];
    late.setAttribute("name", "gone");
    const renamed = named.length;
    return {
      before,
      after,
      renamed,
      sameIdentity: doc.getElementsByTagName("head") === heads,
      sameNamed: doc.getElementsByName("late") === named,
      root: heads[0]?.localName,
    };
  });

  expect(result.before).toEqual([1, 1, 0]);
  expect(result.after).toEqual([1, 1, 1]);
  expect(result.renamed).toBe(0);
  expect(result.sameIdentity).toBe(true);
  expect(result.sameNamed).toBe(true);
  expect(result.root).toBe("v-head");
});

test("lets listeners call native Event methods on the event they were handed", async ({
  page,
}) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, async (child) => {
    const doc = child.document;
    const target = doc.querySelector("#click-target") as HTMLElement;
    const hostStamps: number[] = [];
    const captureHostStamp = (event: Event) => hostStamps.push(event.timeStamp);
    window.addEventListener("click", captureHostStamp, true);
    const seen: Record<string, unknown> = {};
    target.addEventListener("click", (event) => {
      const prototype = child.Event.prototype;
      seen.type = Object.getOwnPropertyDescriptor(prototype, "type")!.get!.call(event);
      seen.bubbles = Object.getOwnPropertyDescriptor(prototype, "bubbles")!.get!.call(
        event,
      );
      seen.target = Object.getOwnPropertyDescriptor(prototype, "target")!.get!.call(
        event,
      );
      seen.composedPath = prototype.composedPath.call(event).length > 0;
      seen.timeStamp = event.timeStamp;
      try {
        prototype.stopPropagation.call(event);
        prototype.preventDefault.call(event);
        seen.threw = null;
      } catch (error) {
        seen.threw = (error as Error).name;
      }
      seen.defaultPrevented = event.defaultPrevented;
      seen.cancelBubble = event.cancelBubble;
      const returnValue = Object.getOwnPropertyDescriptor(prototype, "returnValue")!;
      seen.returnValueBefore = returnValue.get!.call(event);
      returnValue.set!.call(event, true);
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    // Dispatched from the guest, so the logical event is a guest-realm one too.
    target.dispatchEvent(
      new child.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    target.click();
    window.removeEventListener("click", captureHostStamp, true);
    return {
      seen,
      stampMatches:
        hostStamps.length > 0 && hostStamps.includes(seen.timeStamp as number),
      click: click.type,
    };
  });

  expect(result.seen.threw).toBeNull();
  expect(result.seen.type).toBe("click");
  expect(result.seen.bubbles).toBe(true);
  expect(result.seen.composedPath).toBe(true);
  expect(result.seen.defaultPrevented).toBe(true);
  expect(result.seen.cancelBubble).toBe(true);
  expect(result.seen.returnValueBefore).toBe(false);
  expect(result.stampMatches).toBe(true);
});

test("hides host nodes from relatedTarget and keeps every composed event inside the frame", async ({
  page,
}) => {
  await mountFacadeFrame(page);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "host-neighbour";
    button.textContent = "host";
    document.querySelector("#host")!.before(button);
  });

  const leaked = await inChild(page, (child) => {
    const doc = child.document;
    const target = doc.querySelector("#click-target") as HTMLElement;
    const hostButton = document.querySelector("#host-neighbour")!;
    // Types the old fixed relay list did not stop, dispatched with the host
    // realm's own dispatchEvent so no facade patch sees them.
    const types = [
      "mouseover",
      "mouseout",
      "pointerover",
      "pointerout",
      "pointercancel",
      "touchmove",
      "touchcancel",
      "paste",
      "copy",
      "cut",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "dragenter",
      "dragover",
      "dragleave",
      "drag",
      "mouseenter",
      "wheel",
      "scroll",
      "keyup",
    ];
    const hostSaw: string[] = [];
    const listeners = types.map((type) => {
      const listener = () => hostSaw.push(type);
      document.addEventListener(type, listener);
      window.addEventListener(type, listener);
      document.body.addEventListener(type, listener);
      document.querySelector("#facade-frame")!.addEventListener(type, listener);
      return [type, listener] as const;
    });
    const nativeDispatch = EventTarget.prototype.dispatchEvent;
    for (const type of types) {
      nativeDispatch.call(
        target,
        new Event(type, { bubbles: true, composed: true, cancelable: true }),
      );
    }
    for (const [type, listener] of listeners) {
      document.removeEventListener(type, listener);
      window.removeEventListener(type, listener);
      document.body.removeEventListener(type, listener);
      document.querySelector("#facade-frame")!.removeEventListener(type, listener);
    }

    const related: unknown[] = [];
    target.addEventListener("mouseover", (event) => {
      related.push((event as MouseEvent).relatedTarget);
    });
    nativeDispatch.call(
      target,
      new MouseEvent("mouseover", {
        bubbles: true,
        composed: true,
        relatedTarget: hostButton,
      }),
    );
    const guestNeighbour = doc.querySelector("main")!;
    nativeDispatch.call(
      target,
      new MouseEvent("mouseover", {
        bubbles: true,
        composed: true,
        relatedTarget: guestNeighbour,
      }),
    );
    return {
      hostSaw,
      related: related.map((value) => (value === guestNeighbour ? "guest" : value)),
    };
  });

  expect(leaked.hostSaw).toEqual([]);
  expect(leaked.related).toEqual([null, "guest"]);
});

test("relays every document event handler property, not a fixed subset", async ({
  page,
}) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const doc = child.document;
    const target = doc.querySelector("#click-target") as HTMLElement;
    const nativeDispatch = EventTarget.prototype.dispatchEvent;
    const names = [
      "paste",
      "contextmenu",
      "mouseover",
      "drop",
      "pointercancel",
      "dragenter",
      "copy",
      "cut",
      "auxclick",
      "mouseenter",
    ].filter((name) => `on${name}` in doc);
    const fired: string[] = [];
    for (const name of names) {
      (doc as unknown as Record<string, unknown>)[`on${name}`] = function (
        this: Document,
        event: Event,
      ) {
        fired.push(`${name}:${this === doc}:${event.currentTarget === doc}`);
      };
    }
    for (const name of names) {
      nativeDispatch.call(target, new Event(name, { bubbles: true, composed: true }));
    }
    const readBack = names.every(
      (name) =>
        typeof (doc as unknown as Record<string, unknown>)[`on${name}`] === "function",
    );
    return { names, fired, readBack };
  });

  expect(result.names.length).toBeGreaterThanOrEqual(7);
  expect(result.fired).toEqual(result.names.map((name) => `${name}:true:true`));
  expect(result.readBack).toBe(true);
});

test("keeps an event handler's place in the listener order when it is reassigned", async ({
  page,
}) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const doc = child.document;
    const hostElement = document.createElement("div");
    const guestElement = doc.createElement("div");
    doc.body.append(guestElement);
    const handlers = (target: EventTarget, host: boolean) => {
      const order: string[] = [];
      const element = target as HTMLElement;
      const fire = () => element.dispatchEvent(new (host ? Event : child.Event)("click"));
      element.onclick = () => order.push("first");
      element.addEventListener("click", () => order.push("listener"));
      element.onclick = () => order.push("second");
      fire();
      const reassigned = order.splice(0);
      element.onclick = null;
      element.onclick = () => order.push("third");
      fire();
      return { reassigned, reactivated: order.splice(0) };
    };
    const documentHandlers = () => {
      const order: string[] = [];
      const fire = () =>
        doc.body.dispatchEvent(new child.Event("click", { bubbles: true }));
      doc.onclick = () => order.push("first");
      doc.addEventListener("click", () => order.push("listener"));
      doc.onclick = () => order.push("second");
      fire();
      const reassigned = order.splice(0);
      doc.onclick = null;
      doc.onclick = () => order.push("third");
      fire();
      return { reassigned, reactivated: order.splice(0) };
    };
    return {
      native: handlers(hostElement, true),
      guest: handlers(guestElement, false),
      document: documentHandlers(),
    };
  });

  expect(result.native).toEqual({
    reassigned: ["second", "listener"],
    reactivated: ["listener", "third"],
  });
  expect(result.guest).toEqual(result.native);
  expect(result.document).toEqual(result.native);
});

test("reflects every window-handler body property onto the window", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const doc = child.document;
    const body = doc.body as unknown as Record<string, unknown>;
    const calls: string[] = [];
    const names = [
      "resize",
      "hashchange",
      "popstate",
      "message",
      "beforeunload",
      "unload",
      "pageshow",
      "blur",
    ];
    for (const name of names) {
      body[`on${name}`] = function (this: unknown, event: Event) {
        calls.push(`${name}:${this === child}:${event.type}`);
      };
    }
    const readBack = names.every((name) => typeof body[`on${name}`] === "function");
    for (const name of names) {
      child.dispatchEvent(new child.Event(name));
    }
    // An inline attribute for a handler HTMLElement does not carry.
    doc.body.setAttribute("onoffline", "window.__offline = (window.__offline || 0) + 1");
    child.dispatchEvent(new child.Event("offline"));
    // Ordinary handlers stay on the element.
    let elementCalls = 0;
    body.onclick = () => (elementCalls += 1);
    child.dispatchEvent(new child.Event("click"));
    doc.body.dispatchEvent(new child.Event("click"));
    // Replacing and clearing.
    body.onresize = null;
    child.dispatchEvent(new child.Event("resize"));
    return {
      calls,
      readBack,
      offline: (child as unknown as { __offline?: number }).__offline,
      elementCalls,
    };
  });

  expect(result.readBack).toBe(true);
  expect(result.calls).toEqual([
    "resize:true:resize",
    "hashchange:true:hashchange",
    "popstate:true:popstate",
    "message:true:message",
    "beforeunload:true:beforeunload",
    "unload:true:unload",
    "pageshow:true:pageshow",
    "blur:true:blur",
  ]);
  expect(result.offline).toBe(1);
  expect(result.elementCalls).toBe(1);
});

test("converts WebIDL arguments like the browser", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child, { outcome }) => {
    const doc = child.document;
    const both = <T>(run: (document: Document) => T) => {
      const guest = doc.createElement("section");
      doc.body.append(guest);
      return {
        native: outcome(() => run(document)),
        guest: outcome(() => run(doc)),
      };
    };
    const onPair = <T>(
      run: (element: HTMLElement, owner: Document) => T,
    ): { native: unknown; guest: unknown } => {
      const nativeElement = document.createElement("div");
      document.body.append(nativeElement);
      const guestElement = doc.createElement("div");
      doc.body.append(guestElement);
      const nativeResult = outcome(() => run(nativeElement, document));
      const guestResult = outcome(() => run(guestElement, doc));
      nativeElement.remove();
      guestElement.remove();
      return { native: nativeResult, guest: guestResult };
    };

    return {
      innerHTMLNull: onPair((element) => {
        element.innerHTML = "<b>x</b>";
        element.innerHTML = null as unknown as string;
        return element.innerHTML;
      }),
      outerHTMLNull: onPair((element) => {
        const parent = element.ownerDocument.createElement("div");
        const inner = element.ownerDocument.createElement("span");
        parent.append(inner);
        inner.outerHTML = null as unknown as string;
        return parent.innerHTML;
      }),
      setPropertyNull: onPair((element) => {
        element.style.setProperty("color", "red");
        element.style.setProperty("color", null);
        return [element.style.color, element.getAttribute("style")];
      }),
      shorthandNull: onPair((element) => {
        element.style.margin = "1px";
        (element.style as unknown as Record<string, unknown>).margin = null;
        return [element.style.margin, element.getAttribute("style")];
      }),
      cssTextNull: onPair((element) => {
        element.style.color = "red";
        (element.style as unknown as Record<string, unknown>).cssText = null;
        return [element.style.color, element.getAttribute("style")];
      }),
      toggleNull: onPair((element) => {
        const absent = element.toggleAttribute("data-a", null as unknown as boolean);
        element.setAttribute("data-b", "");
        const present = element.toggleAttribute("data-b", null as unknown as boolean);
        return [
          absent,
          present,
          element.hasAttribute("data-a"),
          element.hasAttribute("data-b"),
        ];
      }),
      setAttributeNull: onPair((element) => {
        element.setAttribute(null as unknown as string, "x");
        return [
          element.getAttribute("null"),
          element.hasAttribute(null as unknown as string),
        ];
      }),
      createElementNull: both((owner) => {
        const created = owner.createElement(null as unknown as string);
        return created.localName;
      }),
      createElementSymbol: both((owner) => {
        const before = owner.querySelectorAll("*").length;
        let created: unknown;
        try {
          created = owner.createElement(Symbol("x") as unknown as string);
        } catch (error) {
          return [(error as Error).name, owner.querySelectorAll("*").length === before];
        }
        return created;
      }),
      namespaceError: onPair((element) => element.setAttributeNS(null, "a:b", "x")),
      namespaceCase: onPair((element) => {
        element.setAttributeNS(null, "FOO", "x");
        return element.getAttributeNames();
      }),
      namespaceEmpty: onPair((element) => {
        element.setAttributeNS("", "bar", "x");
        return element.getAttributeNames();
      }),
      removeNamespaceCase: onPair((element) => {
        element.setAttribute("foo", "x");
        element.removeAttributeNS(null, "FOO");
        return element.getAttributeNames();
      }),
    };
  });

  for (const [name, pair] of Object.entries(result)) {
    expect(pair.guest, name).toEqual(pair.native);
  }
  expect(result.innerHTMLNull.guest).toEqual({ value: "" });
  expect(result.outerHTMLNull.guest).toEqual({ value: "" });
  expect(result.setPropertyNull.guest).toEqual({ value: ["", ""] });
  expect(result.toggleNull.guest).toEqual({ value: [false, false, false, false] });
  expect(result.setAttributeNull.guest).toEqual({ value: ["x", true] });
  expect(result.createElementNull.guest).toEqual({ value: "null" });
  expect(result.createElementSymbol.guest).toEqual({ value: ["TypeError", true] });
  expect(result.namespaceError.guest).toEqual({ error: "NamespaceError" });
  expect(result.namespaceCase.guest).toEqual({ value: ["FOO"] });
});

test("validates arguments before touching state or running constructors", async ({
  page,
}) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child, { outcome }) => {
    const doc = child.document;
    let constructed = 0;
    child.customElements.define(
      "fidelity-probe",
      class extends child.HTMLElement {
        constructor() {
          super();
          constructed += 1;
        }
      },
    );
    const guest = doc.createElement("div");
    doc.body.append(guest);
    const bad = outcome(() =>
      guest.insertAdjacentHTML(
        "bad" as InsertPosition,
        "<fidelity-probe></fidelity-probe>",
      ),
    );
    const constructedByBadPosition = constructed;

    const virtualParent = doc.createElement("div");
    doc.body.append(virtualParent);
    const hostParent = document.createElement("div");
    const appendNull = (parent: Node) => {
      try {
        parent.appendChild(null as unknown as Node);
      } catch (error) {
        return [(error as Error).name, /Node/.test((error as Error).message)];
      }
      return null;
    };
    const replaceNull = (parent: Node) => {
      try {
        parent.replaceChild(null as unknown as Node, parent.firstChild ?? parent);
      } catch (error) {
        return (error as Error).name;
      }
      return null;
    };
    const insertAdjacentElementNull = (element: Element) =>
      outcome(() =>
        element.insertAdjacentElement("beforeend", null as unknown as Element),
      );

    // Re-dispatching an event that is still being dispatched is rejected, and
    // the rejection must not move the event's logical target.
    const targets: unknown[] = [];
    const errors: string[] = [];
    const reentrant = doc.createElement("span");
    doc.body.append(reentrant);
    reentrant.addEventListener("ping", (event) => {
      try {
        doc.dispatchEvent(event);
      } catch (error) {
        errors.push((error as Error).name);
      }
      targets.push(event.target === reentrant);
    });
    reentrant.dispatchEvent(new child.Event("ping"));

    // A listener that cannot be one is rejected when it is registered.
    const listenerErrors = (target: EventTarget) =>
      ["notAFunction", 1, true, Symbol("x")].map(
        (listener) =>
          outcome(() =>
            target.addEventListener("x", listener as unknown as EventListener),
          ).error ?? null,
      );
    const accepted = (target: EventTarget) => [
      outcome(() => target.addEventListener("x", null)).error ?? null,
      outcome(() => target.addEventListener("x", undefined as unknown as null)).error ??
        null,
      outcome(() => target.addEventListener("x", { handleEvent() {} })).error ?? null,
    ];

    return {
      bad,
      constructedByBadPosition,
      virtualAppend: appendNull(virtualParent),
      hostAppend: appendNull(hostParent),
      virtualReplace: replaceNull(virtualParent),
      adjacent: insertAdjacentElementNull(guest),
      nativeAdjacent: insertAdjacentElementNull(document.createElement("div")),
      reentrantTargets: targets,
      reentrantErrors: errors,
      listeners: {
        host: listenerErrors(document.createElement("div")),
        element: listenerErrors(guest),
        document: listenerErrors(doc),
        window: listenerErrors(child),
      },
      accepted: {
        element: accepted(guest),
        document: accepted(doc),
        window: accepted(child),
      },
    };
  });

  expect(result.bad).toEqual({ error: "SyntaxError" });
  expect(result.constructedByBadPosition).toBe(0);
  expect(result.virtualAppend).toEqual(result.hostAppend);
  expect(result.virtualAppend).toEqual(["TypeError", true]);
  expect(result.virtualReplace).toBe("TypeError");
  expect(result.adjacent).toEqual(result.nativeAdjacent);
  expect(result.reentrantErrors).toEqual(["InvalidStateError"]);
  expect(result.reentrantTargets).toEqual([true]);
  expect(result.listeners.host).toEqual([
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
  ]);
  expect(result.listeners.element).toEqual(result.listeners.host);
  expect(result.listeners.document).toEqual(result.listeners.host);
  expect(result.listeners.window).toEqual(result.listeners.host);
  expect(result.accepted.element).toEqual([null, null, null]);
  expect(result.accepted.document).toEqual([null, null, null]);
  expect(result.accepted.window).toEqual([null, null, null]);
});

test("replaces children as one validated mutation", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, async (child, { outcome }) => {
    const doc = child.document;
    const summarize = (records: MutationRecord[]) =>
      records.map((record) => ({
        type: record.type,
        added: record.addedNodes.length,
        removed: record.removedNodes.length,
      }));
    const exercise = async (
      owner: Document,
      observerConstructor: typeof MutationObserver,
    ) => {
      const parent = owner.createElement("div");
      owner.body.append(parent);
      const [first, second, third] = ["a", "b", "c"].map((name) => {
        const child = owner.createElement(name);
        parent.append(child);
        return child;
      });
      const records: MutationRecord[] = [];
      const observer = new observerConstructor((batch) => records.push(...batch));
      observer.observe(parent, { childList: true });

      const selfReplace = outcome(() => parent.replaceChildren(parent));
      const ancestorReplace = outcome(() => {
        const inner = owner.createElement("p");
        parent.append(inner);
        inner.replaceChildren(parent);
      });
      parent.lastChild!.remove();
      const survivors = parent.childNodes.length;
      await Promise.resolve();
      records.length = 0;

      parent.replaceChildren(owner.createElement("x"), "text");
      await Promise.resolve();
      const replaced = summarize(records);
      records.length = 0;

      parent.innerHTML = "<i></i><u></u>";
      await Promise.resolve();
      const innerHTML = summarize(records);
      records.length = 0;

      parent.firstElementChild!.outerHTML = "<s></s><em></em>";
      await Promise.resolve();
      const outerHTML = summarize(records);
      records.length = 0;

      parent.replaceChildren();
      await Promise.resolve();
      const emptied = summarize(records);
      observer.disconnect();
      void first;
      void second;
      void third;
      return {
        selfReplace,
        ancestorReplace,
        survivors,
        replaced,
        innerHTML,
        outerHTML,
        emptied,
      };
    };
    return {
      native: await exercise(document, MutationObserver),
      guest: await exercise(doc, child.MutationObserver),
    };
  });

  expect(result.guest).toEqual(result.native);
  expect(result.guest.selfReplace).toEqual({ error: "HierarchyRequestError" });
  expect(result.guest.survivors).toBe(3);
  expect(result.guest.replaced).toEqual([{ type: "childList", added: 2, removed: 3 }]);
  expect(result.guest.outerHTML).toHaveLength(1);
});

test("selects through the guest document and returns guest ranges", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child, { outcome }) => {
    const doc = child.document;
    const selection = child.getSelection()!;
    const copy = doc.createElement("p");
    copy.id = "selection-copy";
    copy.textContent = "abc";
    doc.body.append(copy);

    const modify = outcome(() => selection.modify("move", "forward", "character"));

    selection.removeAllRanges();
    selection.collapse(doc, 0);
    const collapsed = {
      rangeCount: selection.rangeCount,
      type: selection.type,
      inTree:
        selection.anchorNode !== null &&
        doc.documentElement.contains(selection.anchorNode),
    };

    selection.removeAllRanges();
    selection.selectAllChildren(doc);
    const all = {
      rangeCount: selection.rangeCount,
      includesCopy: selection.toString().includes("abc"),
    };

    selection.removeAllRanges();
    selection.setBaseAndExtent(doc, 0, doc, 2);
    const extent = {
      rangeCount: selection.rangeCount,
      includesCopy: selection.toString().includes("abc"),
    };

    // A range the selection hands back must register what it inserts.
    selection.removeAllRanges();
    const range = doc.createRange();
    range.selectNodeContents(copy);
    selection.addRange(range);
    const handedOut = selection.getRangeAt(0);
    const foreign = document.createElement("b");
    foreign.textContent = "inserted";
    const foreignBefore = foreign.ownerDocument === doc;
    handedOut.collapse(true);
    handedOut.insertNode(foreign);
    const inserted = {
      before: foreignBefore,
      after: foreign.ownerDocument === doc,
      root: foreign.getRootNode() === doc,
    };

    // Outside the guest tree the selection ignores the call, as it does for a
    // node outside its own document.
    selection.removeAllRanges();
    selection.collapse(document.body, 0);
    const outside = selection.rangeCount;

    return { modify, collapsed, all, extent, inserted, outside };
  });

  expect(result.modify).toEqual({ error: "NotSupportedError" });
  expect(result.collapsed).toEqual({ rangeCount: 1, type: "Caret", inTree: true });
  expect(result.all).toEqual({ rangeCount: 1, includesCopy: true });
  expect(result.extent).toEqual({ rangeCount: 1, includesCopy: true });
  expect(result.inserted).toEqual({ before: false, after: true, root: true });
  expect(result.outside).toBe(0);
});

test("selects inside a shadow root the guest attached", async ({ page }) => {
  await mountFacadeFrame(page);

  const result = await inChild(page, (child) => {
    const doc = child.document;
    const selection = child.getSelection()!;
    const hostElement = doc.createElement("div");
    doc.body.append(hostElement);
    const shadow = hostElement.attachShadow({ mode: "open" });
    const text = doc.createTextNode("shadow text");
    shadow.append(text);

    selection.removeAllRanges();
    selection.setBaseAndExtent(text, 0, text, 6);
    return {
      rangeCount: selection.rangeCount,
      anchorIsText: selection.anchorNode === text,
      focusOffset: selection.focusOffset,
      contains: selection.containsNode(text, true),
      selected: selection.toString(),
    };
  });

  expect(result.rangeCount).toBe(1);
  expect(result.anchorIsText).toBe(true);
  expect(result.focusOffset).toBe(6);
  expect(result.contains).toBe(true);
  expect(result.selected).toBe("shadow");
});
