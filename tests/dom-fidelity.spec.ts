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

async function mountFrame(page: Page): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = "fidelity-frame";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}/documents/dom.html`);
  await expect.poll(() => page.locator("#fidelity-frame").evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
}

test("adopts, imports, and directly inserts foreign URL subtrees", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: Window | null;
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
    const importedImage = child.document.importNode(sourceImage, true) as HTMLImageElement;
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
    foreignButton.setAttribute(
      "onclick",
      "window.__foreignInlineChildRan = true",
    );
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
        !("__foreignScriptHostRan" in window) &&
        !("__foreignScriptHostRan" in child),
      foreignInlineRanInChild:
        !("__foreignInlineChildRan" in window) &&
        "__foreignInlineChildRan" in child,
      foreignInlineAttribute:
        foreignButton.getAttribute("onclick") ===
        "window.__foreignInlineChildRan = true",
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

test("scopes shell selectors and root translation to the connected virtual tree", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: Window | null;
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
        rootQuery: virtualDocument.querySelector(":root") ===
          virtualDocument.documentElement,
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

test("keeps document collections live with stable identities", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#fidelity-frame") as HTMLElement & {
      contentWindow: Window | null;
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
      rootByID: virtualDocument.getElementById("virtual-root") ===
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
