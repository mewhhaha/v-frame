import { expect, test, type Page } from "@playwright/test";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

async function mountFrame(page: Page, pathname = "/documents/dom.html"): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = "event-fidelity-frame";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}${pathname}`);
  await expect.poll(() => page.locator("#event-fidelity-frame").evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
}

test("uses one logical event across the element, document, and window path", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#event-fidelity-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The event fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const target = virtualDocument.createElement("button");
    target.id = "physical-event-target";
    virtualDocument.body.append(target);

    const order: Array<{
      scope: string;
      target: boolean;
      currentTarget: boolean;
      phase: number;
    }> = [];
    const events: Event[] = [];
    const record = (scope: string, expectedCurrentTarget: EventTarget) =>
      (event: Event) => {
        events.push(event);
        order.push({
          scope,
          target: event.target === target,
          currentTarget: event.currentTarget === expectedCurrentTarget,
          phase: event.eventPhase,
        });
      };

    child.addEventListener("logical-path", record("window-capture", child), true);
    virtualDocument.addEventListener(
      "logical-path",
      record("document-capture", virtualDocument),
      true,
    );
    virtualDocument.documentElement.addEventListener(
      "logical-path",
      record("html-capture", virtualDocument.documentElement),
      true,
    );
    target.addEventListener("logical-path", record("target-capture", target), true);
    target.addEventListener("logical-path", record("target-bubble", target));
    virtualDocument.documentElement.addEventListener(
      "logical-path",
      record("html-bubble", virtualDocument.documentElement),
    );
    virtualDocument.addEventListener(
      "logical-path",
      record("document-bubble", virtualDocument),
    );
    child.addEventListener("logical-path", record("window-bubble", child));

    let escapedEvents = 0;
    frame.addEventListener("logical-path", () => escapedEvents += 1);
    target.dispatchEvent(new child.CustomEvent("logical-path", {
      bubbles: true,
      composed: true,
    }));
    const retainedEvent = events[0];

    const stoppedScopes: string[] = [];
    virtualDocument.documentElement.addEventListener("stopped-at-html", (event) => {
      stoppedScopes.push("html");
      event.stopPropagation();
    });
    virtualDocument.addEventListener("stopped-at-html", () => {
      stoppedScopes.push("document");
    });
    child.addEventListener("stopped-at-html", () => stoppedScopes.push("window"));
    target.dispatchEvent(new child.Event("stopped-at-html", {
      bubbles: true,
      composed: true,
    }));

    const directScopes: string[] = [];
    const directEvents: Event[] = [];
    virtualDocument.documentElement.addEventListener("document-direct", () => {
      directScopes.push("html");
    });
    child.addEventListener("document-direct", (event) => {
      directScopes.push("window-capture");
      directEvents.push(event);
    }, true);
    virtualDocument.addEventListener("document-direct", (event) => {
      directScopes.push("document");
      directEvents.push(event);
    });
    child.addEventListener("document-direct", (event) => {
      directScopes.push("window-bubble");
      directEvents.push(event);
    });
    virtualDocument.dispatchEvent(new child.Event("document-direct", { bubbles: true }));

    virtualDocument.onreadystatechange = () => false;
    const cancelingPropertyEvent = new child.Event("readystatechange", {
      cancelable: true,
    });
    const propertyDispatchResult = virtualDocument.dispatchEvent(cancelingPropertyEvent);

    const rootTargetPhases: Array<{ scope: string; phase: number }> = [];
    const recordRootTargetPhase = (scope: string) => (event: Event) => {
      rootTargetPhases.push({ scope, phase: event.eventPhase });
    };
    child.addEventListener(
      "root-target",
      recordRootTargetPhase("window-capture"),
      true,
    );
    virtualDocument.addEventListener(
      "root-target",
      recordRootTargetPhase("document-capture"),
      true,
    );
    virtualDocument.documentElement.addEventListener(
      "root-target",
      recordRootTargetPhase("html-capture"),
      true,
    );
    virtualDocument.documentElement.addEventListener(
      "root-target",
      recordRootTargetPhase("html-bubble"),
    );
    virtualDocument.addEventListener(
      "root-target",
      recordRootTargetPhase("document-bubble"),
    );
    child.addEventListener("root-target", recordRootTargetPhase("window-bubble"));
    virtualDocument.documentElement.dispatchEvent(new child.Event("root-target", {
      bubbles: true,
      composed: true,
    }));

    const physicalClickState = {
      scopes: [] as string[],
      oneEvent: true,
      childMouseEvent: true,
      targets: true,
      currentTargets: true,
      cancelBubbleClear: true,
      firstEvent: null as Event | null,
      escapedEvents: 0,
    };
    const recordPhysicalClick = (scope: string, expectedCurrentTarget: EventTarget) =>
      (event: Event) => {
        if (physicalClickState.firstEvent === null) {
          physicalClickState.firstEvent = event;
        } else {
          physicalClickState.oneEvent &&= physicalClickState.firstEvent === event;
        }
        physicalClickState.scopes.push(scope);
        physicalClickState.childMouseEvent &&= event instanceof child.MouseEvent;
        physicalClickState.targets &&= event.target === target;
        physicalClickState.currentTargets &&=
          event.currentTarget === expectedCurrentTarget;
        physicalClickState.cancelBubbleClear &&= !event.cancelBubble;
      };
    target.addEventListener("click", recordPhysicalClick("target", target));
    virtualDocument.addEventListener(
      "click",
      recordPhysicalClick("document", virtualDocument),
    );
    child.addEventListener("click", recordPhysicalClick("window", child));
    frame.addEventListener("click", () => physicalClickState.escapedEvents += 1);
    Object.defineProperty(child, "__physicalClickState", {
      configurable: true,
      value: physicalClickState,
    });

    return {
      order,
      oneEvent: events.every((event) => event === events[0]),
      retainedCurrentTarget: retainedEvent?.currentTarget ?? null,
      retainedPhase: retainedEvent?.eventPhase,
      escapedEvents,
      stoppedScopes,
      directScopes,
      directOneEvent: directEvents.every((event) => event === directEvents[0]),
      directTarget: directEvents.every((event) => event.target === virtualDocument),
      directRetainedCurrentTarget: directEvents[0]?.currentTarget ?? null,
      propertyHandlerVisible: virtualDocument.onreadystatechange !== null,
      propertyDispatchResult,
      propertyDefaultPrevented: cancelingPropertyEvent.defaultPrevented,
      rootTargetPhases,
    };
  });

  expect(result).toEqual({
    order: [
      { scope: "window-capture", target: true, currentTarget: true, phase: 1 },
      { scope: "document-capture", target: true, currentTarget: true, phase: 1 },
      { scope: "html-capture", target: true, currentTarget: true, phase: 1 },
      { scope: "target-capture", target: true, currentTarget: true, phase: 2 },
      { scope: "target-bubble", target: true, currentTarget: true, phase: 2 },
      { scope: "html-bubble", target: true, currentTarget: true, phase: 3 },
      { scope: "document-bubble", target: true, currentTarget: true, phase: 3 },
      { scope: "window-bubble", target: true, currentTarget: true, phase: 3 },
    ],
    oneEvent: true,
    retainedCurrentTarget: null,
    retainedPhase: 0,
    escapedEvents: 0,
    stoppedScopes: ["html"],
    directScopes: ["window-capture", "document", "window-bubble"],
    directOneEvent: true,
    directTarget: true,
    directRetainedCurrentTarget: null,
    propertyHandlerVisible: true,
    propertyDispatchResult: false,
    propertyDefaultPrevented: true,
    rootTargetPhases: [
      { scope: "window-capture", phase: 1 },
      { scope: "document-capture", phase: 1 },
      { scope: "html-capture", phase: 2 },
      { scope: "html-bubble", phase: 2 },
      { scope: "document-bubble", phase: 3 },
      { scope: "window-bubble", phase: 3 },
    ],
  });

  await page.locator("#event-fidelity-frame").locator("#physical-event-target").click();
  const physicalClick = await page.evaluate(() => {
    const frame = document.querySelector("#event-fidelity-frame") as HTMLElement & {
      contentWindow: (Window & {
        __physicalClickState: {
          scopes: string[];
          oneEvent: boolean;
          childMouseEvent: boolean;
          targets: boolean;
          currentTargets: boolean;
          cancelBubbleClear: boolean;
          firstEvent: Event | null;
          escapedEvents: number;
        };
      }) | null;
    };
    const state = frame.contentWindow?.__physicalClickState;
    return state === undefined ? null : {
      scopes: state.scopes,
      oneEvent: state.oneEvent,
      childMouseEvent: state.childMouseEvent,
      targets: state.targets,
      currentTargets: state.currentTargets,
      cancelBubbleClear: state.cancelBubbleClear,
      retainedCurrentTarget: state.firstEvent?.currentTarget ?? null,
      retainedPhase: state.firstEvent?.eventPhase,
      escapedEvents: state.escapedEvents,
    };
  });
  expect(physicalClick).toEqual({
    scopes: ["target", "document", "window"],
    oneEvent: true,
    childMouseEvent: true,
    targets: true,
    currentTargets: true,
    cancelBubbleClear: true,
    retainedCurrentTarget: null,
    retainedPhase: 0,
    escapedEvents: 0,
  });
});

test("keeps document structure, namespace collections, and observation logical", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#event-fidelity-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The event fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const htmlNamespace = "http://www.w3.org/1999/xhtml";
    const htmlElements = virtualDocument.getElementsByTagNameNS(htmlNamespace, "html");
    const namedElements = virtualDocument.getElementsByName("live-name");
    const embeds = virtualDocument.embeds;

    const nestedHTML = virtualDocument.createElement("html");
    const nestedHead = virtualDocument.createElement("head");
    const nestedBody = virtualDocument.createElement("body");
    nestedHTML.append(nestedHead, nestedBody);
    virtualDocument.body.append(nestedHTML);

    const namedInput = virtualDocument.createElement("input");
    const nameAttribute = virtualDocument.createAttribute("name");
    nameAttribute.value = "live-name";
    namedInput.setAttributeNode(nameAttribute);
    const shadowHost = virtualDocument.createElement("div");
    const nestedShadow = shadowHost.attachShadow({ mode: "open" });
    const embed = virtualDocument.createElement("embed");
    virtualDocument.body.append(namedInput, shadowHost, embed);

    const shallowRecords: MutationRecord[] = [];
    const deepRecords: MutationRecord[] = [];
    const shallowObserver = new child.MutationObserver((records) => {
      shallowRecords.push(...records);
    });
    const deepObserver = new child.MutationObserver((records) => {
      deepRecords.push(...records);
    });
    shallowObserver.observe(virtualDocument, { attributes: true, subtree: false });
    deepObserver.observe(virtualDocument, { attributes: true, subtree: true });
    virtualDocument.documentElement.setAttribute("data-observed", "yes");
    await Promise.resolve();
    shallowObserver.disconnect();
    deepObserver.disconnect();

    let directMutationError: string | null = null;
    try {
      virtualDocument.appendChild(virtualDocument.createComment("unsupported"));
    } catch (error) {
      directMutationError = (error as DOMException).name;
    }

    const beforeRemoval = {
      htmlElements: htmlElements.length,
      namedElements: namedElements.length,
      embeds: embeds.length,
    };
    const selectors = {
      queryUsesShellFirst: virtualDocument.querySelector("html") ===
        virtualDocument.documentElement,
      queryIncludesNested: virtualDocument.querySelectorAll("html").length,
      nestedMatches: nestedHTML.matches("html") && nestedHead.matches("head") &&
        nestedBody.matches("body"),
      nestedClosest: nestedBody.closest("html") === nestedHTML,
    };
    nestedHTML.remove();
    namedInput.remove();
    embed.remove();

    return {
      structure: {
        doctypeName: virtualDocument.doctype?.name,
        childNodes: Array.from(virtualDocument.childNodes).map((node) => node.nodeName),
        firstChildIsDoctype: virtualDocument.firstChild === virtualDocument.doctype,
        doctypeParent: virtualDocument.doctype?.parentNode === virtualDocument,
        rootPreviousSibling: virtualDocument.documentElement.previousSibling ===
          virtualDocument.doctype,
      },
      selectors,
      ownership: {
        attribute: nameAttribute.ownerDocument === virtualDocument,
        attachedAttribute: namedInput.getAttributeNode("name")?.ownerDocument ===
          virtualDocument,
        shadowRoot: nestedShadow.ownerDocument === virtualDocument,
      },
      collections: {
        beforeRemoval,
        afterRemoval: {
          htmlElements: htmlElements.length,
          namedElements: namedElements.length,
          embeds: embeds.length,
        },
        pluginsAlias: virtualDocument.plugins === embeds,
      },
      observation: {
        shallowRecords: shallowRecords.length,
        deepTargets: deepRecords.map((record) =>
          record.target === virtualDocument.documentElement
        ),
      },
      directMutationError,
    };
  });

  expect(result).toEqual({
    structure: {
      doctypeName: "html",
      childNodes: ["html", "V-HTML"],
      firstChildIsDoctype: true,
      doctypeParent: true,
      rootPreviousSibling: true,
    },
    selectors: {
      queryUsesShellFirst: true,
      queryIncludesNested: 2,
      nestedMatches: true,
      nestedClosest: true,
    },
    ownership: {
      attribute: true,
      attachedAttribute: true,
      shadowRoot: true,
    },
    collections: {
      beforeRemoval: { htmlElements: 2, namedElements: 1, embeds: 1 },
      afterRemoval: { htmlElements: 1, namedElements: 0, embeds: 0 },
      pluginsAlias: true,
    },
    observation: { shallowRecords: 0, deepTargets: [true] },
    directMutationError: "NotSupportedError",
  });
});

test("runs document lifecycle and body load property handlers once", async ({ page }) => {
  await mountFrame(page, "/documents/inline-body-load.html");
  const inlineResult = await page.evaluate(() => {
    const frame = document.querySelector("#event-fidelity-frame") as HTMLElement & {
      contentWindow: (Window & { __documentLifecycle: unknown }) | null;
    };
    return frame.contentWindow?.__documentLifecycle;
  });
  expect(inlineResult).toEqual({
    bodyLoads: 1,
    readyStates: [
      { state: "interactive", target: true, currentTarget: true, thisValue: true },
      { state: "complete", target: true, currentTarget: true, thisValue: true },
    ],
  });

  await mountFrame(page, "/documents/property-body-load.html");
  const propertyLoads = await page.evaluate(() => {
    const frame = document.querySelector("#event-fidelity-frame") as HTMLElement & {
      contentWindow: (Window & {
        __bodyPropertyLoads: { replaced: number; active: number };
      }) | null;
    };
    return frame.contentWindow?.__bodyPropertyLoads;
  });
  expect(propertyLoads).toEqual({ replaced: 0, active: 1 });
});
