import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function mountFidelityFrame(page: Page): Promise<Locator> {
  await installBundle(page, fixture.origin);
  return mountFrame(page, {
    src: `${fixture.origin}/documents/dom.html`,
    id: "fidelity-frame",
  });
}

test("adopts, imports, and directly inserts foreign URL subtrees", async ({ page }) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }

    const adoptedAnchor = document.createElement("a");
    adoptedAnchor.setAttribute("href", "adopted/link.html");
    child.document.adoptNode(adoptedAnchor);
    child.document.body.append(adoptedAnchor);

    const sourceImage = document.createElement("img");
    sourceImage.setAttribute("src", "../assets/imported.png");
    const importedImage = child.document.importNode(
      sourceImage,
      true,
    ) as HTMLImageElement;
    child.document.body.append(importedImage);

    const subtree = document.createElement("section");
    const subtreeAnchor = document.createElement("a");
    subtreeAnchor.setAttribute("href", "subtree/link.html");
    const subtreeImage = document.createElement("img");
    subtreeImage.setAttribute("src", "subtree/image.png");
    subtree.append(subtreeAnchor, subtreeImage);
    child.document.body.append(subtree);

    const foreignScript = document.createElement("script");
    foreignScript.textContent = "window.__foreignScriptHostRan = true";
    child.document.body.append(foreignScript);
    const foreignButton = document.createElement("button");
    foreignButton.setAttribute("onclick", "window.__foreignInlineChildRan = true");
    child.document.body.append(foreignButton);
    foreignButton.click();

    const beforeNavigation = {
      adoptedHref: adoptedAnchor.href,
      importedSrc: importedImage.src,
      subtreeHref: subtreeAnchor.href,
      subtreeSrc: subtreeImage.src,
      allUseFacadeDocument: [
        adoptedAnchor,
        importedImage,
        subtree,
        subtreeAnchor,
        subtreeImage,
      ].every((node) => node.ownerDocument === child.document),
      allUseVirtualBase: [
        adoptedAnchor,
        importedImage,
        subtree,
        subtreeAnchor,
        subtreeImage,
      ].every((node) => node.baseURI === child.document.baseURI),
      adoptedRootIsFacade: adoptedAnchor.getRootNode() === child.document,
      parentPrototypeUntouched: document.createElement("html").matches("html"),
      foreignScriptStayedInert:
        !("__foreignScriptHostRan" in window) && !("__foreignScriptHostRan" in child),
      foreignInlineRanInChild:
        !("__foreignInlineChildRan" in window) && "__foreignInlineChildRan" in child,
      foreignInlineAttribute:
        foreignButton.getAttribute("onclick") === "window.__foreignInlineChildRan = true",
    };

    child.history.pushState({}, "", "nested/state.html");
    return {
      beforeNavigation,
      afterNavigation: {
        baseURI: child.document.baseURI,
        adoptedHref: adoptedAnchor.href,
        importedSrc: importedImage.src,
        subtreeHref: subtreeAnchor.href,
        subtreeSrc: subtreeImage.src,
      },
    };
  });

  expect(result).toEqual({
    beforeNavigation: {
      adoptedHref: `${fixture.origin}/documents/adopted/link.html`,
      importedSrc: `${fixture.origin}/assets/imported.png`,
      subtreeHref: `${fixture.origin}/documents/subtree/link.html`,
      subtreeSrc: `${fixture.origin}/documents/subtree/image.png`,
      allUseFacadeDocument: true,
      allUseVirtualBase: true,
      adoptedRootIsFacade: true,
      parentPrototypeUntouched: true,
      foreignScriptStayedInert: true,
      foreignInlineRanInChild: true,
      foreignInlineAttribute: true,
    },
    afterNavigation: {
      baseURI: `${fixture.origin}/documents/nested/state.html`,
      adoptedHref: `${fixture.origin}/documents/nested/adopted/link.html`,
      importedSrc: `${fixture.origin}/documents/assets/imported.png`,
      subtreeHref: `${fixture.origin}/documents/nested/subtree/link.html`,
      subtreeSrc: `${fixture.origin}/documents/nested/subtree/image.png`,
    },
  });
});

test("marks attribute nodes created after their element joined the virtual tree", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const root = virtualDocument.querySelector("#dom-root");
    if (root === null) {
      throw new Error("The fidelity guest has no root element");
    }

    // Authored before insertion, so the marking pass over the subtree sees it.
    const early = virtualDocument.createElement("a");
    early.setAttribute("data-early", "authored");
    root.append(early);

    // Authored after insertion, which no later marking pass ever revisits.
    const late = virtualDocument.createElement("a");
    root.append(late);
    late.setAttribute("data-late", "plain");
    late.setAttribute("href", "late/link.html");
    late.setAttributeNS("http://example.test/ns", "ex:late", "namespaced");

    const attributeNodes = [
      early.getAttributeNode("data-early"),
      late.getAttributeNode("data-late"),
      late.getAttributeNode("href"),
      late.getAttributeNodeNS("http://example.test/ns", "late"),
    ];

    return {
      resolved: attributeNodes.every((attribute) => attribute !== null),
      ownerDocuments: attributeNodes.map(
        (attribute) => attribute?.ownerDocument === virtualDocument,
      ),
      baseURIs: attributeNodes.map((attribute) => attribute?.baseURI),
      hostBaseURI: document.baseURI,
    };
  });

  const guestBaseURI = `${fixture.origin}/documents/dom.html`;
  expect(result).toEqual({
    resolved: true,
    ownerDocuments: [true, true, true, true],
    baseURIs: [guestBaseURI, guestBaseURI, guestBaseURI, guestBaseURI],
    hostBaseURI: `${fixture.origin}/`,
  });
});

test("marks attribute nodes written past the facade on a node already in the tree", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const root = virtualDocument.querySelector("#dom-root");
    if (root === null) {
      throw new Error("The fidelity guest has no root element");
    }

    const guest = virtualDocument.createElement("span");
    root.append(guest);

    // The writes the facade never sees: the host page's own Element.prototype,
    // used on a node it holds a reference to, and the reflected setters that
    // never reach setAttribute at all. The element is marked and in the tree,
    // so no later marking pass revisits it.
    Element.prototype.setAttribute.call(guest, "data-outside", "written");
    Element.prototype.setAttributeNS.call(
      guest,
      "http://example.test/ns",
      "ex:outside",
      "namespaced",
    );
    guest.id = "reflected";
    guest.classList.add("reflected");

    // Adopted from the host page rather than authored in the guest, then given
    // an attribute by a reflected setter, which the facade the adoption
    // installed on it does not cover either.
    const adopted = document.createElement("span");
    virtualDocument.adoptNode(adopted);
    root.append(adopted);
    adopted.id = "adopted";

    const attributeNodes = [
      guest.getAttributeNode("data-outside"),
      guest.getAttributeNodeNS("http://example.test/ns", "outside"),
      guest.getAttributeNode("id"),
      Array.from(guest.attributes).find((attribute) => attribute.name === "class") ??
        null,
      adopted.getAttributeNode("id"),
    ];

    // Read in the same task as the writes: the marking has to be synchronous,
    // not a mutation record delivered a microtask later.
    return {
      resolved: attributeNodes.every((attribute) => attribute !== null),
      ownerDocuments: attributeNodes.map(
        (attribute) => attribute?.ownerDocument === virtualDocument,
      ),
      baseURIs: attributeNodes.map((attribute) => attribute?.baseURI),
      hostBaseURI: document.baseURI,
    };
  });

  const guestBaseURI = `${fixture.origin}/documents/dom.html`;
  expect(result).toEqual({
    resolved: true,
    ownerDocuments: [true, true, true, true, true],
    baseURIs: [guestBaseURI, guestBaseURI, guestBaseURI, guestBaseURI, guestBaseURI],
    hostBaseURI: `${fixture.origin}/`,
  });
});

test("keeps a re-parented subtree virtual without walking it again", async ({ page }) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const root = virtualDocument.querySelector("#dom-root");
    if (root === null) {
      throw new Error("The fidelity guest has no root element");
    }

    const branch = virtualDocument.createElement("section");
    branch.innerHTML =
      '<article><a href="moved/link.html">moved</a><img src="moved/image.png"></article>';
    root.append(branch);

    // The move the optimization is about: everything below is already marked,
    // and marking has to stay correct without re-descending into it.
    const destination = virtualDocument.createElement("aside");
    root.append(destination);
    destination.append(branch);

    const anchor = branch.querySelector("a") as HTMLAnchorElement;
    const image = branch.querySelector("img") as HTMLImageElement;
    const descendants = [branch, branch.firstElementChild, anchor, image];

    // Synchronously marks nodes created by textContent, insertAdjacentText, and setHTMLUnsafe.
    anchor.insertAdjacentText("beforeend", " tail");
    const adjacentText = anchor.lastChild;
    const syncTextHost = virtualDocument.createElement("p");
    root.append(syncTextHost);
    syncTextHost.textContent = "sync text";
    const syncTextNode = syncTextHost.firstChild;
    const unsafeHost = virtualDocument.createElement("div");
    root.append(unsafeHost);
    let syncUnsafeLinkHref: string | null = null;
    let syncUnsafeOwner = true;
    if (
      typeof (unsafeHost as Element & { setHTMLUnsafe?: (s: string) => void })
        .setHTMLUnsafe === "function"
    ) {
      (unsafeHost as Element & { setHTMLUnsafe(s: string): void }).setHTMLUnsafe(
        '<a href="unsafe/page.html">unsafe</a>',
      );
      const unsafeLink = unsafeHost.querySelector("a") as HTMLAnchorElement;
      syncUnsafeOwner =
        unsafeLink.ownerDocument === virtualDocument &&
        unsafeLink.getRootNode() === virtualDocument;
      syncUnsafeLinkHref = unsafeLink.href;
    }

    return {
      ownerDocuments: descendants.every(
        (node) => node?.ownerDocument === virtualDocument,
      ),
      roots: descendants.every((node) => node?.getRootNode() === virtualDocument),
      baseURIs: descendants.every((node) => node?.baseURI === virtualDocument.baseURI),
      href: anchor.href,
      src: image.src,
      unpatchedTextOwner: adjacentText?.ownerDocument === virtualDocument,
      syncTextOwner: syncTextNode?.ownerDocument === virtualDocument,
      syncUnsafeOwner,
      syncUnsafeLinkHref,
    };
  });

  expect(result).toEqual({
    ownerDocuments: true,
    roots: true,
    baseURIs: true,
    href: `${fixture.origin}/documents/moved/link.html`,
    src: `${fixture.origin}/documents/moved/image.png`,
    unpatchedTextOwner: true,
    syncTextOwner: true,
    syncUnsafeOwner: true,
    syncUnsafeLinkHref: `${fixture.origin}/documents/unsafe/page.html`,
  });
});

test("marks a detached subtree that changed since it was last walked", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    const root = virtualDocument.querySelector("#dom-root");
    if (root === null) {
      throw new Error("The fidelity guest has no root element");
    }

    // Marked once when it was created, then given children by two paths that do
    // not mark what they create. Nothing observes a detached subtree, so the
    // insertion below has to walk it again.
    const detached = virtualDocument.createElement("section");
    const labelled = virtualDocument.createElement("p");
    labelled.textContent = "written";
    detached.append(labelled);
    const appended = virtualDocument.createElement("p");
    detached.append(appended);
    appended.insertAdjacentText("beforeend", "adjacent");
    root.append(detached);

    // Read synchronously: the walk on insertion is what has to have marked
    // these, not the mutation observer a microtask later.
    return {
      writtenText: labelled.firstChild?.ownerDocument === virtualDocument,
      adjacentText: appended.firstChild?.ownerDocument === virtualDocument,
      writtenBase: labelled.firstChild?.baseURI === virtualDocument.baseURI,
      adjacentBase: appended.firstChild?.baseURI === virtualDocument.baseURI,
    };
  });

  expect(result).toEqual({
    writtenText: true,
    adjacentText: true,
    writtenBase: true,
    adjacentBase: true,
  });
});

test("scopes shell selectors and root translation to the connected virtual tree", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;

    const parsed = new child.DOMParser().parseFromString(
      "<!doctype html><html><head></head><body></body></html>",
      "text/html",
    );
    const detachedHTML = virtualDocument.createElement("html");
    const detachedHead = virtualDocument.createElement("head");
    const detachedBody = virtualDocument.createElement("body");
    detachedHTML.append(detachedHead, detachedBody);

    const template = virtualDocument.createElement("template");
    const templateHTML = virtualDocument.createElement("html");
    const templateBody = virtualDocument.createElement("body");
    templateHTML.append(templateBody);
    template.content.append(templateHTML);

    const detachedRoot = virtualDocument.createElement("div");
    const detachedChild = virtualDocument.createElement("span");
    detachedRoot.append(detachedChild);

    const connected = virtualDocument.createElement("div");
    virtualDocument.body.append(connected);
    const shadowHost = virtualDocument.createElement("div");
    virtualDocument.body.append(shadowHost);
    const nestedShadow = shadowHost.attachShadow({ mode: "open" });
    const shadowChild = virtualDocument.createElement("span");
    nestedShadow.append(shadowChild);

    return {
      connectedSelectors: {
        htmlMatches: virtualDocument.documentElement.matches("html"),
        bodyMatches: virtualDocument.body.matches("body"),
        bodyClosest: connected.closest("body") === virtualDocument.body,
        rootMatches: virtualDocument.documentElement.matches(":root"),
        rootQuery:
          virtualDocument.querySelector(":root") === virtualDocument.documentElement,
      },
      parsedSelectors: {
        htmlMatches: parsed.documentElement.matches("html"),
        bodyQuery: parsed.documentElement.querySelector("body") === parsed.body,
        bodyClosest: parsed.body.closest("body") === parsed.body,
      },
      detachedSelectors: {
        htmlMatches: detachedHTML.matches("html"),
        headQuery: detachedHTML.querySelector("head") === detachedHead,
        bodyQueryCount: detachedHTML.querySelectorAll("body").length,
        bodyClosest: detachedBody.closest("body") === detachedBody,
      },
      templateSelectors: {
        htmlMatches: templateHTML.matches("html"),
        bodyQuery: templateHTML.querySelector("body") === templateBody,
        bodyClosest: templateBody.closest("body") === templateBody,
      },
      roots: {
        detachedRootIsSelf: detachedRoot.getRootNode() === detachedRoot,
        detachedChildUsesSubtreeRoot: detachedChild.getRootNode() === detachedRoot,
        templateUsesFragment: templateHTML.getRootNode() === template.content,
        connectedUsesFacade: connected.getRootNode() === virtualDocument,
        connectedComposedUsesFacade:
          connected.getRootNode({ composed: true }) === virtualDocument,
        nestedShadowPreserved: shadowChild.getRootNode() === nestedShadow,
        nestedShadowComposedUsesFacade:
          shadowChild.getRootNode({ composed: true }) === virtualDocument,
      },
    };
  });

  expect(result).toEqual({
    connectedSelectors: {
      htmlMatches: true,
      bodyMatches: true,
      bodyClosest: true,
      rootMatches: true,
      rootQuery: true,
    },
    parsedSelectors: {
      htmlMatches: true,
      bodyQuery: true,
      bodyClosest: true,
    },
    detachedSelectors: {
      htmlMatches: true,
      headQuery: true,
      bodyQueryCount: 1,
      bodyClosest: true,
    },
    templateSelectors: {
      htmlMatches: true,
      bodyQuery: true,
      bodyClosest: true,
    },
    roots: {
      detachedRootIsSelf: true,
      detachedChildUsesSubtreeRoot: true,
      templateUsesFragment: true,
      connectedUsesFacade: true,
      connectedComposedUsesFacade: true,
      nestedShadowPreserved: true,
      nestedShadowComposedUsesFacade: true,
    },
  });
});

test("parses and clones virtual template contents", async ({ page }) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }

    const template = child.document.createElement("template");
    template.innerHTML = '<button type="button"><span>Open</span></button>';
    const button = template.content.firstElementChild;
    const clone = button?.cloneNode(true);

    return {
      buttonMarkup: button?.outerHTML,
      cloneMarkup: clone instanceof child.Element ? clone.outerHTML : null,
      contentUsesFacadeDocument: template.content.ownerDocument === child.document,
      buttonUsesFacadeDocument: button?.ownerDocument === child.document,
      buttonUsesTemplateRoot: button?.getRootNode() === template.content,
    };
  });

  expect(result).toEqual({
    buttonMarkup: '<button type="button"><span>Open</span></button>',
    cloneMarkup: '<button type="button"><span>Open</span></button>',
    contentUsesFacadeDocument: true,
    buttonUsesFacadeDocument: true,
    buttonUsesTemplateRoot: true,
  });
});

test("reports element geometry in the virtual viewport coordinate space", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }

    frame.style.cssText = [
      "position: fixed",
      "left: 120px",
      "top: 80px",
      "width: 400px",
      "height: 300px",
      "border: 7px solid transparent",
    ].join(";");
    const target = child.document.createElement("button");
    target.id = "geometry-target";
    target.style.cssText = [
      "position: fixed",
      "left: 40px",
      "top: 50px",
      "width: 90px",
      "height: 30px",
    ].join(";");
    child.document.body.append(target);

    const virtualRect = target.getBoundingClientRect();
    const physicalRect = Element.prototype.getBoundingClientRect.call(target);
    const frameRect = frame.getBoundingClientRect();
    const hitX = virtualRect.left + virtualRect.width / 2;
    const hitY = virtualRect.top + virtualRect.height / 2;
    const hit = child.document.elementFromPoint(hitX, hitY);
    const hits = child.document.elementsFromPoint(hitX, hitY);

    return {
      virtualRect: {
        left: virtualRect.left,
        top: virtualRect.top,
        width: virtualRect.width,
        height: virtualRect.height,
      },
      translatedLeft: physicalRect.left - frameRect.left - frame.clientLeft,
      translatedTop: physicalRect.top - frameRect.top - frame.clientTop,
      clientRectLeft: target.getClientRects().item(0)?.left,
      hitTarget: hit === target,
      hitsContainTarget: Array.from(hits).includes(target),
    };
  });

  expect(result.virtualRect.left).toBeCloseTo(result.translatedLeft, 5);
  expect(result.virtualRect.top).toBeCloseTo(result.translatedTop, 5);
  expect(result.virtualRect.width).toBe(90);
  expect(result.virtualRect.height).toBe(30);
  expect(result.clientRectLeft).toBeCloseTo(result.virtualRect.left, 5);
  expect(result.hitTarget).toBe(true);
  expect(result.hitsContainTarget).toBe(true);
});

test("positions native popovers in the virtual viewport", async ({ page }) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }

    frame.style.cssText = [
      "position: fixed",
      "left: 120px",
      "top: 80px",
      "width: 400px",
      "height: 300px",
      "border: 7px solid transparent",
      "overflow: hidden",
    ].join(";");
    const popover = child.document.createElement("div");
    popover.popover = "manual";
    popover.style.cssText = [
      "position: absolute",
      "inset: auto",
      "left: 360px",
      "top: 280px",
      "width: 90px",
      "height: 30px",
      "margin: 0",
    ].join(";");
    child.document.body.append(popover);
    popover.showPopover();

    const virtualRect = popover.getBoundingClientRect();
    const physicalRect = Element.prototype.getBoundingClientRect.call(popover);
    const frameRect = frame.getBoundingClientRect();
    const result = {
      open: popover.matches(":popover-open"),
      virtualLeft: virtualRect.left,
      virtualTop: virtualRect.top,
      physicalLeft: physicalRect.left,
      physicalTop: physicalRect.top,
      expectedPhysicalLeft: frameRect.left + frame.clientLeft + 360,
      expectedPhysicalTop: frameRect.top + frame.clientTop + 280,
      extendsPastFrame:
        physicalRect.right > frameRect.right && physicalRect.bottom > frameRect.bottom,
      outsideHitRetargetsToFrame:
        document.elementFromPoint(frameRect.right + 20, physicalRect.top + 15) === frame,
    };
    popover.hidePopover();
    return result;
  });

  expect(result.open).toBe(true);
  expect(result.virtualLeft).toBeCloseTo(360, 5);
  expect(result.virtualTop).toBeCloseTo(280, 5);
  expect(result.physicalLeft).toBeCloseTo(result.expectedPhysicalLeft, 5);
  expect(result.physicalTop).toBeCloseTo(result.expectedPhysicalTop, 5);
  expect(result.extendsPastFrame).toBe(true);
  expect(result.outsideHitRetargetsToFrame).toBe(true);
});

test("keeps document collections live with stable identities", async ({ page }) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The fidelity frame has no child window");
    }
    const virtualDocument = child.document;
    virtualDocument.documentElement.id = "virtual-root";
    virtualDocument.documentElement.className = "shell-class";

    const forms = virtualDocument.forms;
    const images = virtualDocument.images;
    const scripts = virtualDocument.scripts;
    const links = virtualDocument.links;
    const anchors = virtualDocument.anchors;
    const styleSheets = virtualDocument.styleSheets;
    const allElements = virtualDocument.getElementsByTagName("*");
    const rootTags = virtualDocument.getElementsByTagName("html");
    const formTags = virtualDocument.getElementsByTagName("form");
    const shellClasses = virtualDocument.getElementsByClassName("shell-class");

    const initial = {
      forms: forms.length,
      images: images.length,
      scripts: scripts.length,
      links: links.length,
      anchors: anchors.length,
      styleSheets: styleSheets.length,
      allElements: allElements.length,
      rootTags: rootTags.length,
      shellClasses: shellClasses.length,
      rootByID:
        virtualDocument.getElementById("virtual-root") ===
        virtualDocument.documentElement,
      rootByTag: rootTags[0] === virtualDocument.documentElement,
      rootByClass: shellClasses.item(0) === virtualDocument.documentElement,
    };

    const form = virtualDocument.createElement("form");
    form.id = "live-form";
    form.setAttribute("name", "checkout");
    const image = virtualDocument.createElement("img");
    image.id = "live-image";
    const script = virtualDocument.createElement("script");
    script.id = "live-script";
    const link = virtualDocument.createElement("a");
    link.id = "live-link";
    link.href = "linked.html";
    link.name = "live-anchor";
    const style = virtualDocument.createElement("style");
    const classMatch = virtualDocument.createElement("div");
    classMatch.className = "shell-class";
    virtualDocument.body.append(form, image, script, link, style, classMatch);

    const afterInsertion = {
      forms: forms.length,
      images: images.length,
      scripts: scripts.length,
      links: links.length,
      anchors: anchors.length,
      styleSheets: styleSheets.length,
      allElements: allElements.length,
      formTags: formTags.length,
      shellClasses: shellClasses.length,
      formIndex: forms[0]?.id,
      formItem: forms.item(0)?.id,
      formNamedByID: forms.namedItem("live-form") === form,
      formNamedByName: forms.namedItem("checkout") === form,
      imageIndex: images[0]?.id,
      scriptIndex: scripts[0]?.id,
      linkIndex: links[0]?.id,
      anchorIndex: anchors[0]?.id,
      sheetItem: styleSheets.item(0) === style.sheet,
    };

    form.remove();
    image.remove();
    script.remove();
    link.remove();
    style.remove();
    classMatch.remove();

    return {
      initial,
      afterInsertion,
      afterRemoval: {
        forms: forms.length,
        images: images.length,
        scripts: scripts.length,
        links: links.length,
        anchors: anchors.length,
        styleSheets: styleSheets.length,
        allElements: allElements.length,
        formTags: formTags.length,
        shellClasses: shellClasses.length,
        removedIndex: forms[0] ?? null,
        removedItem: forms.item(0),
        removedNamedItem: forms.namedItem("live-form"),
      },
      stableIdentities: {
        forms: virtualDocument.forms === forms,
        images: virtualDocument.images === images,
        scripts: virtualDocument.scripts === scripts,
        links: virtualDocument.links === links,
        anchors: virtualDocument.anchors === anchors,
        styleSheets: virtualDocument.styleSheets === styleSheets,
        allElements: virtualDocument.getElementsByTagName("*") === allElements,
        rootTags: virtualDocument.getElementsByTagName("html") === rootTags,
        formTags: virtualDocument.getElementsByTagName("form") === formTags,
        classes: virtualDocument.getElementsByClassName("shell-class") === shellClasses,
      },
    };
  });

  expect(result.initial).toMatchObject({
    forms: 0,
    images: 0,
    scripts: 0,
    links: 0,
    anchors: 0,
    styleSheets: 0,
    rootTags: 1,
    shellClasses: 1,
    rootByID: true,
    rootByTag: true,
    rootByClass: true,
  });
  expect(result.afterInsertion).toMatchObject({
    forms: 1,
    images: 1,
    scripts: 1,
    links: 1,
    anchors: 1,
    styleSheets: 1,
    formTags: 1,
    shellClasses: 2,
    formIndex: "live-form",
    formItem: "live-form",
    formNamedByID: true,
    formNamedByName: true,
    imageIndex: "live-image",
    scriptIndex: "live-script",
    linkIndex: "live-link",
    anchorIndex: "live-link",
    sheetItem: true,
  });
  expect(result.afterInsertion.allElements).toBe(result.initial.allElements + 6);
  expect(result.afterRemoval).toEqual({
    forms: 0,
    images: 0,
    scripts: 0,
    links: 0,
    anchors: 0,
    styleSheets: 0,
    allElements: result.initial.allElements,
    formTags: 0,
    shellClasses: 1,
    removedIndex: null,
    removedItem: null,
    removedNamedItem: null,
  });
  expect(result.stableIdentities).toEqual({
    forms: true,
    images: true,
    scripts: true,
    links: true,
    anchors: true,
    styleSheets: true,
    allElements: true,
    rootTags: true,
    formTags: true,
    classes: true,
  });
});

test("iterates live collections, resolves null-namespace attributes, and trusts real clicks", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const virtualDocument = frame.contentWindow!.document;
    const named = virtualDocument.createElement("input");
    named.setAttribute("name", "iterated");
    named.id = "iterated-input";
    virtualDocument.body.append(named);

    const styled = virtualDocument.createElement("div");
    styled.id = "ns-styled";
    styled.textContent = "clickable";
    styled.style.color = "rgb(4, 5, 6)";
    virtualDocument.body.append(styled);

    styled.addEventListener("click", (event) => {
      styled.dataset.trusted = String(event.isTrusted);
    });
  });

  await page.locator("#fidelity-frame").locator("#ns-styled").click();

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const virtualDocument = frame.contentWindow!.document;
    const iterated: string[] = [];
    virtualDocument.getElementsByName("iterated").forEach((node) => {
      iterated.push((node as Element).id);
    });
    const styled = virtualDocument.querySelector("#ns-styled") as HTMLElement;
    return {
      iterated,
      styleNS: styled.getAttributeNS(null, "style"),
      styleQualified: styled.getAttribute("style"),
      hasStyleNS: styled.hasAttributeNS(null, "style"),
      trusted: styled.dataset.trusted,
    };
  });

  expect(result).toEqual({
    iterated: ["iterated-input"],
    styleNS: "color: rgb(4, 5, 6);",
    styleQualified: "color: rgb(4, 5, 6);",
    hasStyleNS: true,
    trusted: "true",
  });
});

test("matches foreign tag names case-sensitively and keeps unknown on-attributes plain", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const virtualDocument = frame.contentWindow!.document;

    const svg = virtualDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    const gradient = virtualDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "linearGradient",
    );
    svg.append(gradient);
    virtualDocument.body.append(svg);

    const emptyID = virtualDocument.createElement("div");
    emptyID.setAttribute("id", "");
    virtualDocument.body.append(emptyID);

    const plain = virtualDocument.createElement("div");
    plain.setAttribute("once", "true");
    plain.setAttribute("onboarding-step", "intro");
    plain.setAttribute("onclick", "this.dataset.clicked = 'yes'");
    virtualDocument.body.append(plain);
    plain.click();

    return {
      byAuthoredCase: virtualDocument.getElementsByTagName("linearGradient").length,
      byLowercase: virtualDocument.getElementsByTagName("lineargradient").length,
      emptyLookupIsNull: virtualDocument.getElementById("") === null,
      onceAttribute: plain.getAttribute("once"),
      onboardingAttribute: plain.getAttribute("onboarding-step"),
      onceSelectorMatches: plain.matches("[once]"),
      inlineHandlerRan: (plain as HTMLElement).dataset.clicked ?? null,
    };
  });

  expect(result).toEqual({
    byAuthoredCase: 1,
    byLowercase: 0,
    emptyLookupIsNull: true,
    onceAttribute: "true",
    onboardingAttribute: "intro",
    onceSelectorMatches: true,
    inlineHandlerRan: "yes",
  });
});

test("preserves selector union edge cases, detached native edits, and inert template custom elements", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow!;
    const virtualDocument = child.document;
    const root = virtualDocument.querySelector("#dom-root")!;

    // 1. Selector union edge cases: comments, quoted commas, unclosed brackets, SyntaxError, closest/matches.
    const item = virtualDocument.createElement("div");
    item.className = "union-item";
    item.setAttribute("data-comma", "a,b");
    root.append(item);

    let syntaxError = false;
    try {
      virtualDocument.querySelector("body, ..invalid");
    } catch (error) {
      syntaxError = error instanceof child.DOMException && error.name === "SyntaxError";
    }
    const unclosedBracketMatches =
      virtualDocument.querySelector("body [data-comma") === item;
    let commentQueryOk = false;
    try {
      commentQueryOk = virtualDocument.querySelector("body /* , */ .union-item") === item;
    } catch {
      commentQueryOk = false;
    }
    const quotedQueryOk =
      virtualDocument.querySelector('body [data-comma="a,b"]') === item;
    const closestBody = item.closest("body") === virtualDocument.body;
    const closestHtml = item.closest("html") === virtualDocument.documentElement;
    const matchesBodyDescendant = item.matches("body .union-item");
    const matchesRootDescendant = item.matches(":root .union-item");

    // 2. Detached-subtree watcher: native edits while detached, removed script not executed, base change rebases.
    const section = virtualDocument.createElement("section");
    const anchor = virtualDocument.createElement("a");
    anchor.setAttribute("href", "rel/before.html");
    const childDiv = virtualDocument.createElement("div");
    childDiv.append(virtualDocument.createElement("i"));
    section.append(
      anchor,
      childDiv,
      virtualDocument.createElement("p"),
      virtualDocument.createElement("p"),
    );
    root.append(section);

    // Invalid removeChild must throw without stranding a detached watch.
    let notFoundThrew = false;
    try {
      childDiv.removeChild(anchor);
    } catch (error) {
      notFoundThrew =
        error instanceof child.DOMException && error.name === "NotFoundError";
    }

    // Detach, apply native host mutations synchronously, and re-attach.
    // Repeat twice so both the initial full-walk path and the armed clean-watch
    // invalidation path are exercised.
    section.remove();
    const nativeNode = document.createElement("span");
    nativeNode.textContent = "native-added";
    Node.prototype.appendChild.call(childDiv, nativeNode);
    Element.prototype.setAttribute.call(childDiv, "data-native", "ok");
    const transientScript = virtualDocument.createElement("script");
    transientScript.textContent = "window.__transientRan = true;";
    section.append(transientScript);
    transientScript.remove();

    root.append(section);

    const nativeNodeOwner = nativeNode.ownerDocument === virtualDocument;
    const nativeAttrOwner =
      childDiv.getAttributeNode("data-native")?.ownerDocument === virtualDocument;
    const transientScriptRan =
      (child as unknown as { __transientRan?: boolean }).__transientRan === true;

    // Second detach (now armed with clean-subtree watch): native node + attribute edits
    // invalidate the watch and repair synchronously on re-attach.
    section.remove();
    const secondNativeNode = document.createElement("em");
    Node.prototype.appendChild.call(childDiv, secondNativeNode);
    Element.prototype.setAttribute.call(childDiv, "data-native-2", "ok2");
    root.append(section);
    const secondNativeNodeOwner = secondNativeNode.ownerDocument === virtualDocument;
    const secondNativeAttrOwner =
      childDiv.getAttributeNode("data-native-2")?.ownerDocument === virtualDocument;

    // Detach, change <base>, and re-attach without mutating section directly.
    section.remove();
    const base = virtualDocument.createElement("base");
    base.setAttribute("href", "/rebased/sub/");
    virtualDocument.head.append(base);
    root.append(section);
    const rebasedPhysicalHref = Element.prototype.getAttribute.call(anchor, "href");
    base.remove();

    // 3. innerHTML with custom element inside <template> vs live markup.
    let upgradedCount = 0;
    class TestWidget extends child.HTMLElement {
      constructor() {
        super();
        upgradedCount += 1;
      }
    }
    child.customElements.define("x-test-widget", TestWidget);
    const hostBox = virtualDocument.createElement("div");
    root.append(hostBox);
    hostBox.innerHTML =
      "<x-test-widget></x-test-widget><template><x-test-widget></x-test-widget></template>";
    const templateHtml = (hostBox.querySelector("template") as HTMLTemplateElement)
      .innerHTML;

    // 4. CSSOM .sheet with nested rules (wait for async dynamic style rewrite to commit).
    const styleEl = virtualDocument.createElement("style");
    styleEl.textContent =
      "body { color: rgb(1, 2, 3); .nested-child { color: rgb(4, 5, 6); } }";
    virtualDocument.head.append(styleEl);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((styleEl.sheet?.cssRules.length ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ruleCount = styleEl.sheet?.cssRules.length ?? 0;

    return {
      syntaxError,
      unclosedBracketMatches,
      commentQueryOk,
      quotedQueryOk,
      closestBody,
      closestHtml,
      matchesBodyDescendant,
      matchesRootDescendant,
      notFoundThrew,
      nativeNodeOwner,
      nativeAttrOwner,
      secondNativeNodeOwner,
      secondNativeAttrOwner,
      transientScriptRan,
      rebasedPhysicalHref,
      upgradedCount,
      templateHtml,
      ruleCount,
    };
  });

  expect(result).toEqual({
    syntaxError: true,
    unclosedBracketMatches: true,
    commentQueryOk: true,
    quotedQueryOk: true,
    closestBody: true,
    closestHtml: true,
    matchesBodyDescendant: true,
    matchesRootDescendant: true,
    notFoundThrew: true,
    nativeNodeOwner: true,
    nativeAttrOwner: true,
    secondNativeNodeOwner: true,
    secondNativeAttrOwner: true,
    transientScriptRan: false,
    rebasedPhysicalHref: `${fixture.origin}/rebased/sub/rel/before.html`,
    upgradedCount: 1,
    templateHtml: "<x-test-widget></x-test-widget>",
    ruleCount: 1,
  });
});

test("handles shadowed form.contains, physical base removals, raw style serialization, and Event method shapes", async ({
  page,
}) => {
  await mountFidelityFrame(page);

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow!;
    const d = child.document;
    const root = d.body;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    // 1. Form with <input name="contains"> under detached watch.
    const form = d.createElement("form");
    form.innerHTML = '<input name="contains"><p>1</p><p>2</p><p>3</p><p>4</p>';
    root.append(form);
    await tick();
    form.remove();
    const addedChild = d.createElement("span");
    form.append(addedChild);
    root.append(form);
    const formReconnected = form.isConnected;
    form.remove();

    // 2. Shadowed documentElement.contains must not break closest().
    const b = d.createElement("b");
    root.append(b);
    (d.documentElement as unknown as { contains: () => boolean }).contains = () => false;
    const closestSurvived = b.closest("b") === b;
    delete (d.documentElement as unknown as { contains?: unknown }).contains;
    b.remove();

    // 3. Synchronous removal of a natively appended <base> rebases URLs immediately.
    const hostDiv = d.createElement("div");
    const rawBase = d.createElement("base");
    const link = d.createElement("a");
    link.setAttribute("href", "zzz");
    root.append(hostDiv, link);
    Node.prototype.appendChild.call(hostDiv, rawBase);
    rawBase.setAttribute("href", "/elsewhere/");
    const hrefWithBase = Element.prototype.getAttribute.call(link, "href");
    hostDiv.textContent = "";
    const hrefAfterTextClear = Element.prototype.getAttribute.call(link, "href");
    hostDiv.remove();
    link.remove();

    // 4. Raw physical style attr hidden from authored innerHTML/outerHTML.
    const rawBox = d.createElement("div");
    const rawSpan = d.createElement("span");
    root.append(rawBox);
    rawBox.append(rawSpan);
    Element.prototype.setAttribute.call(rawSpan, "style", "color:red");
    const rawSerialized = [
      rawSpan.getAttribute("style"),
      rawBox.innerHTML,
      rawSpan.outerHTML,
    ];
    rawBox.remove();

    // 5. Detached leaf with authored URL whose physical attribute was removed natively.
    const leafAnchor = d.createElement("a");
    leafAnchor.setAttribute("href", "leaf.html");
    Element.prototype.removeAttribute.call(leafAnchor, "href");
    root.append(leafAnchor);
    const leafRebased = Element.prototype.getAttribute.call(leafAnchor, "href");
    leafAnchor.remove();

    // 6. Custom element constructor relocating target during insertAdjacentHTML.
    const p = d.createElement("div");
    const q = d.createElement("div");
    const target = d.createElement("b");
    p.append(target);
    root.append(p, q);
    child.customElements.define(
      "x-relocate-audit",
      class extends child.HTMLElement {
        constructor() {
          super();
          q.append(target);
        }
      },
    );
    target.insertAdjacentHTML("afterend", "<x-relocate-audit></x-relocate-audit>");
    const relocatedHTML = [p.innerHTML, q.innerHTML];
    p.remove();
    q.remove();

    // 7. Non-constructible Event.prototype method shape.
    const eventMethodHasPrototype = Object.hasOwn(
      child.Event.prototype.stopImmediatePropagation,
      "prototype",
    );

    // 8. Popover translate cascade order: guest adoptedStyleSheets override internal top-layer sheet.
    const pop = d.createElement("div");
    pop.setAttribute("popover", "manual");
    root.append(pop);
    const guestSheet = new child.CSSStyleSheet();
    guestSheet.replaceSync(":where([popover]){translate:97px 101px}");
    d.adoptedStyleSheets = [guestSheet];
    pop.showPopover();
    await tick();
    const popoverTranslate = child.getComputedStyle(pop).translate;
    pop.hidePopover();
    pop.remove();
    d.adoptedStyleSheets = [];

    // 9. Form with <input name="localName"> inside innerHTML parse & replace.
    const formBox = d.createElement("div");
    formBox.innerHTML = '<form><input name="localName"></form>';
    const formParseHTML = formBox.innerHTML;
    const namedForm = formBox.firstElementChild as HTMLFormElement;
    namedForm.innerHTML = "<b></b>";
    const formReplaceHTML = namedForm.innerHTML;

    // 10. Uppercase HTML-namespace element keeps case-sensitive parser context (non-rawtext).
    const upperStyle = d.createElementNS("http://www.w3.org/1999/xhtml", "STYLE");
    upperStyle.innerHTML = "<b>ok</b>";
    const upperStyleChild = upperStyle.firstChild?.nodeName ?? null;

    // 11. Reentrant Node.prototype.textContent.set toString() connecting a script still executes it.
    const reentrantScript = d.createElement("script");
    Object.getOwnPropertyDescriptor(child.Node.prototype, "textContent")!.set!.call(
      reentrantScript,
      {
        toString() {
          root.append(reentrantScript);
          return "window.__reentrantTextRan = 42;";
        },
      },
    );
    await tick();
    const reentrantTextRan =
      (child as unknown as { __reentrantTextRan?: number }).__reentrantTextRan ?? null;
    reentrantScript.remove();

    // 12. Retained NamedNodeMap + IDL property write across 1st and 2nd detach preserves Attr identity.
    const watchBox = d.createElement("div");
    watchBox.innerHTML = "<b><i></i></b><p></p><p></p><p></p>";
    root.append(watchBox);
    await tick();
    const watchChild = watchBox.firstElementChild as HTMLElement;
    const namedAttrs = watchChild.attributes;
    watchChild.title = "first";
    watchBox.remove();
    root.append(watchBox);
    const firstDetachedAttr = namedAttrs.removeNamedItem("title");
    const firstAttrOk =
      firstDetachedAttr.ownerDocument === d && firstDetachedAttr.baseURI === d.baseURI;
    watchChild.title = "second";
    watchBox.remove();
    root.append(watchBox);
    const secondDetachedAttr = namedAttrs.removeNamedItem("title");
    const secondAttrOk =
      secondDetachedAttr.ownerDocument === d && secondDetachedAttr.baseURI === d.baseURI;
    watchBox.remove();

    return {
      formReconnected,
      closestSurvived,
      hrefWithBase,
      hrefAfterTextClear,
      rawSerialized,
      leafRebased,
      relocatedHTML,
      eventMethodHasPrototype,
      popoverTranslate,
      formParseHTML,
      formReplaceHTML,
      upperStyleChild,
      reentrantTextRan,
      firstAttrOk,
      secondAttrOk,
    };
  });

  expect(result).toEqual({
    formReconnected: true,
    closestSurvived: true,
    hrefWithBase: `${fixture.origin}/elsewhere/zzz`,
    hrefAfterTextClear: `${fixture.origin}/documents/zzz`,
    rawSerialized: [null, "<span></span>", "<span></span>"],
    leafRebased: `${fixture.origin}/documents/leaf.html`,
    relocatedHTML: ["", "<b></b><x-relocate-audit></x-relocate-audit>"],
    eventMethodHasPrototype: false,
    popoverTranslate: "97px 101px",
    formParseHTML: '<form><input name="localName"></form>',
    formReplaceHTML: "<b></b>",
    upperStyleChild: "B",
    reentrantTextRan: 42,
    firstAttrOk: true,
    secondAttrOk: true,
  });
});
