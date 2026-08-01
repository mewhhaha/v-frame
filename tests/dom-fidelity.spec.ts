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

    // A node the guest adds through an API the facade does not intercept is
    // reported to the realm's mutation observer, which is what lets the move
    // above skip the walk. Read it after the observer has run.
    anchor.insertAdjacentText("beforeend", " tail");
    const unpatchedText = anchor.lastChild;

    return new Promise<Record<string, unknown>>((settle) => {
      setTimeout(() => {
        settle({
          ownerDocuments: descendants.every(
            (node) => node?.ownerDocument === virtualDocument,
          ),
          roots: descendants.every((node) => node?.getRootNode() === virtualDocument),
          baseURIs: descendants.every(
            (node) => node?.baseURI === virtualDocument.baseURI,
          ),
          href: anchor.href,
          src: image.src,
          unpatchedTextOwner: unpatchedText?.ownerDocument === virtualDocument,
        });
      }, 0);
    });
  });

  expect(result).toEqual({
    ownerDocuments: true,
    roots: true,
    baseURIs: true,
    href: `${fixture.origin}/documents/moved/link.html`,
    src: `${fixture.origin}/documents/moved/image.png`,
    unpatchedTextOwner: true,
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
    styleNS: "color:rgb(4,5,6)",
    styleQualified: "color:rgb(4,5,6)",
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
