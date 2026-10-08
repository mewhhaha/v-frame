import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

async function mount(page: Page): Promise<void> {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
}

// Each case runs one snippet against the host window and against the guest
// window, so the expectation is native behavior rather than a hand-kept value.

test("a listener's event keeps the native class, members and subclass accessors", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(view: Window & typeof globalThis) {
      const out: Record<string, unknown> = {};
      const attempt = (name: string, read: () => unknown) => {
        try {
          out[name] = read();
        } catch (error) {
          out[name] = `threw ${(error as Error).name}`;
        }
      };
      const button = view.document.createElement("button");
      view.document.body.append(button);
      button.addEventListener("click", (event) => {
        const any = event as unknown as Record<string, any>;
        attempt("constructorIdentity", () => event.constructor === view.MouseEvent);
        attempt("constructorName", () => event.constructor.name);
        attempt("constructorPrototype", () => {
          return (
            (event.constructor as typeof MouseEvent).prototype ===
            view.MouseEvent.prototype
          );
        });
        attempt(
          "constructorStatic",
          () => typeof (event.constructor as any).isPrototypeOf,
        );
        attempt("methodStable", () => any.initEvent === any.initEvent);
        attempt("methodName", () => any.initEvent.name);
        attempt("methodLength", () => any.initEvent.length);
        attempt("preventDefaultStable", () => any.preventDefault === any.preventDefault);
        attempt("preventDefaultName", () => any.preventDefault.name);
        attempt("stopPropagationStable", () => {
          return any.stopPropagation === any.stopPropagation;
        });
        attempt("composedPathStable", () => any.composedPath === any.composedPath);
        attempt("clientXGetter", () => {
          const descriptor = Object.getOwnPropertyDescriptor(
            view.MouseEvent.prototype,
            "clientX",
          )!;
          return descriptor.get!.call(event);
        });
        attempt("getModifierState", () => {
          return view.MouseEvent.prototype.getModifierState.call(event, "Shift");
        });
        attempt("viewIsWindow", () => any.view === view);
        attempt("pointerProperty", () => any.button);
      });
      button.dispatchEvent(
        new view.MouseEvent("click", {
          clientX: 7,
          shiftKey: true,
          bubbles: true,
          view,
        }),
      );
      button.addEventListener("keydown", (event) => {
        attempt("keyGetter", () => {
          const descriptor = Object.getOwnPropertyDescriptor(
            view.KeyboardEvent.prototype,
            "key",
          )!;
          return descriptor.get!.call(event);
        });
        attempt("repeatGetter", () => {
          const descriptor = Object.getOwnPropertyDescriptor(
            view.KeyboardEvent.prototype,
            "repeat",
          )!;
          return descriptor.get!.call(event);
        });
      });
      button.dispatchEvent(new view.KeyboardEvent("keydown", { key: "a", repeat: true }));
      button.addEventListener("custom", (event) => {
        attempt("customHasView", () => "view" in event);
        attempt("customView", () => (event as any).view);
        attempt("customDetail", () => (event as CustomEvent).detail);
      });
      button.dispatchEvent(new view.CustomEvent("custom", { detail: 3 }));
      return out;
    }
    return { host: run(window as Window & typeof globalThis), guest: run(child) };
  });
  expect(result.guest).toEqual(result.host);
  expect(result.host.constructorIdentity).toBe(true);
  expect(result.host.clientXGetter).toBe(7);
});

test("guest event functions keep their identity and logical receiver", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const guest = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(view: Window & typeof globalThis) {
      const callback = function (this: Event) {
        return this.currentTarget;
      };
      class MyEvent extends view.CustomEvent<Function> {
        callback = callback;
        targetDocument() {
          return this.currentTarget === view.document;
        }
        get atDocument() {
          return this.currentTarget === view.document;
        }
      }
      let observed: unknown = null;
      view.document.addEventListener(
        "guest-functions",
        (received) => {
          const event = received as MyEvent & { fixed: Function };
          observed = {
            callback: event.callback === callback,
            callbackTarget: event.callback() === view.document,
            detail: event.detail === callback,
            fixed: event.fixed === callback,
            method: event.targetDocument === MyEvent.prototype.targetDocument,
            methodTarget: event.targetDocument(),
            accessorTarget: event.atDocument,
          };
          event.initEvent = callback as unknown as typeof event.initEvent;
          event.preventDefault = callback as unknown as typeof event.preventDefault;
          Object.assign(observed!, {
            overriddenInitializer: event.initEvent === callback,
            overriddenPreventDefault: event.preventDefault === callback,
          });
        },
        { once: true },
      );
      const event = new MyEvent("guest-functions", { bubbles: true, detail: callback });
      Object.defineProperty(event, "fixed", { value: callback });
      view.document.body.dispatchEvent(event);
      return observed;
    }
    return { host: run(window), guest: run(guest) };
  });
  expect(result.guest).toEqual(result.host);
  expect(Object.values(result.guest!)).toEqual(Array(9).fill(true));
});

test("the guest's MutationObserver looks native and exposes no internals", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    async function run(view: Window & typeof globalThis) {
      const Observer = view.MutationObserver as unknown as Record<string, unknown>;
      const records: string[] = [];
      const observer = new view.MutationObserver((list) => {
        for (const record of list) records.push(record.type);
      });
      const target = view.document.createElement("div");
      view.document.body.append(target);
      observer.observe(target, { attributes: true });
      target.setAttribute("a", "1");
      await Promise.resolve();
      return {
        name: view.MutationObserver.name,
        length: view.MutationObserver.length,
        ownNames: Object.getOwnPropertyNames(view.MutationObserver).sort(),
        internals: typeof Observer.mutateInternally,
        records,
      };
    }
    return {
      host: await run(window as Window & typeof globalThis),
      guest: await run(child),
    };
  });
  expect(result.guest).toEqual(result.host);
  expect(result.host.internals).toBe("undefined");
});

test("window and body handler properties are one slot and keep their listener position", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(view: Window & typeof globalThis) {
      const out: Record<string, unknown> = {};
      const body = view.document.body;
      const order: string[] = [];
      const first = () => order.push("first");
      const last = () => order.push("last");
      view.addEventListener("resize", first);
      view.onresize = () => order.push("handler-1");
      view.addEventListener("resize", last);
      view.onresize = () => order.push("handler-2");
      view.dispatchEvent(new view.Event("resize"));
      out.order = order.slice();
      view.removeEventListener("resize", first);
      view.removeEventListener("resize", last);
      view.onresize = null;

      const f = () => {};
      const g = () => {};
      for (const name of [
        "resize",
        "scroll",
        "blur",
        "focus",
        "hashchange",
        "popstate",
      ]) {
        const bodyKey = `on${name}` as "onresize";
        body[bodyKey] = f as never;
        out[`${name}:body->window`] = view[bodyKey] === f;
        view[bodyKey] = g as never;
        out[`${name}:window->body`] = body[bodyKey] === g;
        body[bodyKey] = null;
        out[`${name}:cleared`] = view[bodyKey] === null;
      }

      // One slot, one call.
      let calls = 0;
      body.onresize = () => calls++;
      view.dispatchEvent(new view.Event("resize"));
      out.calls = calls;
      body.onresize = null;

      const argumentCounts: number[] = [];
      body.onerror = function (...args: unknown[]) {
        argumentCounts.push(args.length);
        out.errorArgs = args.map((arg) => (arg instanceof view.Error ? "Error" : arg));
        return true;
      };
      out.windowOnError = view.onerror === body.onerror;
      out.cancelled = !view.dispatchEvent(
        new view.ErrorEvent("error", {
          message: "m",
          filename: "s.js",
          lineno: 1,
          colno: 2,
          error: new view.Error("e"),
          cancelable: true,
        }),
      );
      out.argumentCounts = argumentCounts;
      body.onerror = null;

      body.setAttribute(
        "onerror",
        "window.__argumentCount = arguments.length; return true",
      );
      out.attributeCancelled = !view.dispatchEvent(
        new view.ErrorEvent("error", { message: "m", cancelable: true }),
      );
      out.attributeArguments = (
        view as unknown as Record<string, unknown>
      ).__argumentCount;
      body.removeAttribute("onerror");
      return out;
    }
    return { host: run(window as Window & typeof globalThis), guest: run(child) };
  });
  expect(result.guest).toEqual(result.host);
  expect(result.host.order).toEqual(["first", "handler-2", "last"]);
  expect(result.host.errorArgs).toEqual(["m", "s.js", 1, 2, "Error"]);
});

test("WebIDL conversions reject symbols and attribute names validate whatever force says", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(view: Window & typeof globalThis) {
      const out: Record<string, unknown> = {};
      const attempt = (name: string, action: () => unknown) => {
        try {
          out[name] = action();
        } catch (error) {
          out[name] = `threw ${(error as Error).name}`;
        }
      };
      const anchor = view.document.createElement("a");
      view.document.body.append(anchor);
      attempt("hrefSymbol", () => {
        anchor.href = Symbol() as never;
        return anchor.getAttribute("href");
      });
      attempt("hrefSurrogate", () => {
        anchor.href = "x\ud800";
        return anchor.getAttribute("href");
      });
      const image = view.document.createElement("img");
      view.document.body.append(image);
      attempt("srcsetSymbol", () => {
        image.srcset = Symbol() as never;
        return image.getAttribute("srcset");
      });
      const svg = view.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      view.document.body.append(svg);
      attempt("svgStyleSymbol", () => {
        (svg as unknown as { style: unknown }).style = Symbol();
        return svg.getAttribute("style");
      });
      const svgAnchor = view.document.createElementNS("http://www.w3.org/2000/svg", "a");
      svg.append(svgAnchor);
      attempt("svgHrefSymbol", () => {
        (svgAnchor as unknown as SVGAElement).href.baseVal = Symbol() as never;
        return svgAnchor.getAttribute("href");
      });
      const link = view.document.createElement("link");
      attempt("relSymbol", () => {
        link.rel = Symbol() as never;
        return link.getAttribute("rel");
      });
      const script = view.document.createElement("script");
      attempt("typeSymbol", () => {
        script.type = Symbol() as never;
        return script.getAttribute("type");
      });
      const element = view.document.createElement("div");
      view.document.body.append(element);
      attempt("toggleBadFalse", () => element.toggleAttribute("a b", false));
      attempt("toggleBadTrue", () => element.toggleAttribute("a b", true));
      attempt("toggleBadUnforced", () => element.toggleAttribute("a b"));
      attempt("toggleGood", () => element.toggleAttribute("ok", false));
      return out;
    }
    return { host: run(window as Window & typeof globalThis), guest: run(child) };
  });
  expect(result.guest).toEqual(result.host);
  expect(result.host.hrefSymbol).toBe("threw TypeError");
  expect(result.host.toggleBadFalse).toBe("threw InvalidCharacterError");
});

test("document.title collapses whitespace and finds the first HTML title anywhere", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(doc: Document) {
      const out: Record<string, unknown> = {};
      for (const existing of Array.from(doc.querySelectorAll("title"))) existing.remove();
      out.none = doc.title;
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      const svgTitle = doc.createElementNS("http://www.w3.org/2000/svg", "title");
      svgTitle.textContent = "svg";
      svg.append(svgTitle);
      doc.body.append(svg);
      out.svgIgnored = doc.title;
      const title = doc.createElement("title");
      title.innerHTML = "  a \n\t b  <b>nested</b> c ";
      doc.body.append(title);
      out.collapsed = doc.title;
      const inner = doc.createElement("i");
      inner.textContent = "ignored";
      title.append(inner);
      out.childElementIgnored = doc.title;
      out.inBody = title.parentNode === doc.body;
      doc.title = " set ";
      out.bodyTitleUpdated = [title.textContent, doc.querySelectorAll("title").length];
      title.remove();
      out.afterRemoval = doc.title;
      doc.title = "created";
      out.created = [doc.title, doc.head.querySelectorAll("title").length];
      svg.remove();
      return out;
    }
    const nativeDocument = document.implementation.createHTMLDocument("");
    return { host: run(nativeDocument), guest: run(child.document) };
  });
  expect(result.guest).toEqual(result.host);
  expect(result.host.collapsed).toBe("a b <b>nested</b> c");
  expect(result.host.childElementIgnored).toBe("a b <b>nested</b> c");
});

test("inline style reads and writes match native after the hot path cache", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function run(view: Window & typeof globalThis) {
      const out: Record<string, unknown> = {};
      const element = view.document.createElement("div");
      view.document.body.append(element);
      const style = element.style;
      style.setProperty("color", "bogus-value");
      out.rejected = [style.color];
      style.setProperty("color", "red");
      style.margin = "1px 2px";
      style.margin = "bogus";
      style.backgroundImage = 'url("a.png")';
      out.afterWrites = [style.color, style.margin];
      out.url = style.backgroundImage.includes("a.png");
      style.cssText = "width: 3px";
      out.cssText = [style.width, style.color];
      style.removeProperty("width");
      out.removed = [style.width];
      style.setProperty("--x", "calc(1px + 2px)");
      out.custom = [style.getPropertyValue("--x")];
      return out;
    }
    return { host: run(window as Window & typeof globalThis), guest: run(child) };
  });
  expect(result.guest).toEqual(result.host);
});
