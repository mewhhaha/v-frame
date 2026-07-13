import { expect, test, type Page } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./support/fixture-server";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
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
    frame.id = "url-frame";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}/documents/dynamic-base-urls.html`);
  await expect.poll(() => page.locator("#url-frame").evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
}

test("updates the first valid connected base and HTML URL properties synchronously", async ({ page }) => {
  await mountFrame(page);

  const states = await page.evaluate(async () => {
    const frame = document.querySelector("#url-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The URL frame has no child window");
    }

    const virtualDocument = child.document;
    const anchor = virtualDocument.querySelector("#initial-anchor") as HTMLAnchorElement;
    const image = virtualDocument.querySelector("#initial-image") as HTMLImageElement;
    const form = virtualDocument.querySelector("#initial-form") as HTMLFormElement;
    const initialBase = virtualDocument.querySelector("#initial-base") as HTMLBaseElement;
    const secondaryBase = virtualDocument.querySelector("#secondary-base") as HTMLBaseElement;
    const invalidBase = virtualDocument.querySelector("#invalid-base") as HTMLBaseElement;
    const snapshot = () => ({
      baseURI: virtualDocument.baseURI,
      href: anchor.href,
      src: image.src,
      action: form.action,
      authored: [
        anchor.getAttribute("href"),
        image.getAttribute("src"),
        form.getAttribute("action"),
      ],
    });

    const result: Record<string, ReturnType<typeof snapshot>> = {
      initial: snapshot(),
    };

    const prependedBase = virtualDocument.createElement("base");
    prependedBase.href = "/prepended/";
    virtualDocument.head.prepend(prependedBase);
    result.prepended = snapshot();

    prependedBase.setAttribute("href", "relative-base/");
    result.changed = snapshot();

    const newAnchor = virtualDocument.createElement("a");
    const newImage = virtualDocument.createElement("img");
    const newForm = virtualDocument.createElement("form");
    newAnchor.setAttribute("href", "new.html");
    newImage.src = "new.png";
    newForm.action = "new-submit";
    virtualDocument.body.append(newAnchor, newImage, newForm);
    result.newResources = {
      baseURI: virtualDocument.baseURI,
      href: newAnchor.href,
      src: newImage.src,
      action: newForm.action,
      authored: [
        newAnchor.getAttribute("href"),
        newImage.getAttribute("src"),
        newForm.getAttribute("action"),
      ],
    };

    prependedBase.remove();
    result.removed = snapshot();

    initialBase.before(secondaryBase);
    result.reordered = snapshot();

    secondaryBase.href = "/changed-secondary/";
    result.propertyChanged = snapshot();

    secondaryBase.removeAttribute("href");
    initialBase.setAttribute("href", "relative-root/");
    child.history.pushState({}, "", "nested/state.html");
    result.historyWithBase = snapshot();

    initialBase.remove();
    result.withoutBase = snapshot();

    child.history.pushState({}, "", "later/page.html");
    result.historyWithoutBase = snapshot();

    invalidBase.remove();
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    result.afterObserverDelivery = snapshot();
    return result;
  });

  const authored = ["asset.html", "asset.png", "submit"];
  expect(states).toEqual({
    initial: {
      baseURI: `${fixture.origin}/initial-base/`,
      href: `${fixture.origin}/initial-base/asset.html`,
      src: `${fixture.origin}/initial-base/asset.png`,
      action: `${fixture.origin}/initial-base/submit`,
      authored,
    },
    prepended: {
      baseURI: `${fixture.origin}/prepended/`,
      href: `${fixture.origin}/prepended/asset.html`,
      src: `${fixture.origin}/prepended/asset.png`,
      action: `${fixture.origin}/prepended/submit`,
      authored,
    },
    changed: {
      baseURI: `${fixture.origin}/documents/relative-base/`,
      href: `${fixture.origin}/documents/relative-base/asset.html`,
      src: `${fixture.origin}/documents/relative-base/asset.png`,
      action: `${fixture.origin}/documents/relative-base/submit`,
      authored,
    },
    newResources: {
      baseURI: `${fixture.origin}/documents/relative-base/`,
      href: `${fixture.origin}/documents/relative-base/new.html`,
      src: `${fixture.origin}/documents/relative-base/new.png`,
      action: `${fixture.origin}/documents/relative-base/new-submit`,
      authored: ["new.html", "new.png", "new-submit"],
    },
    removed: {
      baseURI: `${fixture.origin}/initial-base/`,
      href: `${fixture.origin}/initial-base/asset.html`,
      src: `${fixture.origin}/initial-base/asset.png`,
      action: `${fixture.origin}/initial-base/submit`,
      authored,
    },
    reordered: {
      baseURI: `${fixture.origin}/secondary-base/`,
      href: `${fixture.origin}/secondary-base/asset.html`,
      src: `${fixture.origin}/secondary-base/asset.png`,
      action: `${fixture.origin}/secondary-base/submit`,
      authored,
    },
    propertyChanged: {
      baseURI: `${fixture.origin}/changed-secondary/`,
      href: `${fixture.origin}/changed-secondary/asset.html`,
      src: `${fixture.origin}/changed-secondary/asset.png`,
      action: `${fixture.origin}/changed-secondary/submit`,
      authored,
    },
    historyWithBase: {
      baseURI: `${fixture.origin}/documents/relative-root/nested/relative-root/`,
      href: `${fixture.origin}/documents/relative-root/nested/relative-root/asset.html`,
      src: `${fixture.origin}/documents/relative-root/nested/relative-root/asset.png`,
      action: `${fixture.origin}/documents/relative-root/nested/relative-root/submit`,
      authored,
    },
    withoutBase: {
      baseURI: `${fixture.origin}/documents/relative-root/nested/state.html`,
      href: `${fixture.origin}/documents/relative-root/nested/asset.html`,
      src: `${fixture.origin}/documents/relative-root/nested/asset.png`,
      action: `${fixture.origin}/documents/relative-root/nested/submit`,
      authored,
    },
    historyWithoutBase: {
      baseURI: `${fixture.origin}/documents/relative-root/nested/later/page.html`,
      href: `${fixture.origin}/documents/relative-root/nested/later/asset.html`,
      src: `${fixture.origin}/documents/relative-root/nested/later/asset.png`,
      action: `${fixture.origin}/documents/relative-root/nested/later/submit`,
      authored,
    },
    afterObserverDelivery: {
      baseURI: `${fixture.origin}/documents/relative-root/nested/later/page.html`,
      href: `${fixture.origin}/documents/relative-root/nested/later/asset.html`,
      src: `${fixture.origin}/documents/relative-root/nested/later/asset.png`,
      action: `${fixture.origin}/documents/relative-root/nested/later/submit`,
      authored,
    },
  });
});

test("keeps authored srcset candidates while rebasing their physical URLs", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#url-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The URL frame has no child window");
    }

    const virtualDocument = child.document;
    const image = virtualDocument.querySelector("#initial-srcset") as HTMLImageElement;
    const initialBase = virtualDocument.querySelector("#initial-base") as HTMLBaseElement;
    const secondaryBase = virtualDocument.querySelector("#secondary-base") as HTMLBaseElement;
    const invalidBase = virtualDocument.querySelector("#invalid-base") as HTMLBaseElement;
    const physicalSrcset = (element: Element) =>
      Element.prototype.getAttribute.call(element, "srcset");
    const snapshot = (element: HTMLImageElement) => ({
      attribute: element.getAttribute("srcset"),
      property: element.srcset,
      physical: physicalSrcset(element),
    });

    const states = { initial: snapshot(image) };
    const prependedBase = virtualDocument.createElement("base");
    prependedBase.href = "/srcset-base/";
    virtualDocument.head.prepend(prependedBase);
    const prepended = snapshot(image);

    const dynamicImage = virtualDocument.createElement("img");
    dynamicImage.srcset = "new-small.png 1x, data:image/png;base64,BBBB 2x";
    virtualDocument.body.append(dynamicImage);
    const dynamic = snapshot(dynamicImage);

    prependedBase.setAttribute("href", "relative-srcset/");
    const changed = {
      existing: snapshot(image),
      dynamic: snapshot(dynamicImage),
    };
    child.history.pushState({}, "", "nested/state.html");
    const afterHistory = {
      existing: snapshot(image),
      dynamic: snapshot(dynamicImage),
    };

    prependedBase.remove();
    initialBase.remove();
    secondaryBase.remove();
    invalidBase.remove();
    const withoutBase = {
      existing: snapshot(image),
      dynamic: snapshot(dynamicImage),
    };
    return { ...states, prepended, dynamic, changed, afterHistory, withoutBase };
  });

  const initialAuthored = "small.png 1x, data:image/png;base64,AAAA 2x";
  const dynamicAuthored = "new-small.png 1x, data:image/png;base64,BBBB 2x";
  const srcset = (authored: string, physical: string) => ({
    attribute: authored,
    property: authored,
    physical,
  });
  expect(result).toEqual({
    initial: srcset(
      initialAuthored,
      `${fixture.origin}/initial-base/small.png 1x, data:image/png;base64,AAAA 2x`,
    ),
    prepended: srcset(
      initialAuthored,
      `${fixture.origin}/srcset-base/small.png 1x, data:image/png;base64,AAAA 2x`,
    ),
    dynamic: srcset(
      dynamicAuthored,
      `${fixture.origin}/srcset-base/new-small.png 1x, data:image/png;base64,BBBB 2x`,
    ),
    changed: {
      existing: srcset(
        initialAuthored,
        `${fixture.origin}/documents/relative-srcset/small.png 1x, data:image/png;base64,AAAA 2x`,
      ),
      dynamic: srcset(
        dynamicAuthored,
        `${fixture.origin}/documents/relative-srcset/new-small.png 1x, data:image/png;base64,BBBB 2x`,
      ),
    },
    afterHistory: {
      existing: srcset(
        initialAuthored,
        `${fixture.origin}/documents/relative-srcset/nested/relative-srcset/small.png 1x, data:image/png;base64,AAAA 2x`,
      ),
      dynamic: srcset(
        dynamicAuthored,
        `${fixture.origin}/documents/relative-srcset/nested/relative-srcset/new-small.png 1x, data:image/png;base64,BBBB 2x`,
      ),
    },
    withoutBase: {
      existing: srcset(
        initialAuthored,
        `${fixture.origin}/documents/relative-srcset/nested/small.png 1x, data:image/png;base64,AAAA 2x`,
      ),
      dynamic: srcset(
        dynamicAuthored,
        `${fixture.origin}/documents/relative-srcset/nested/new-small.png 1x, data:image/png;base64,BBBB 2x`,
      ),
    },
  });
});

test("updates baseURI synchronously when textContent removes a base subtree", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#url-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The URL frame has no child window");
    }

    const virtualDocument = child.document;
    virtualDocument.querySelector("#initial-base")?.remove();
    virtualDocument.querySelector("#secondary-base")?.remove();
    virtualDocument.querySelector("#invalid-base")?.remove();
    const container = virtualDocument.createElement("section");
    const base = virtualDocument.createElement("base");
    base.href = "/text-content-base/";
    container.append(base);
    virtualDocument.body.prepend(container);
    const before = virtualDocument.baseURI;
    container.textContent = "removed";
    return { before, after: virtualDocument.baseURI };
  });

  expect(result).toEqual({
    before: `${fixture.origin}/text-content-base/`,
    after: `${fixture.origin}/documents/dynamic-base-urls.html`,
  });
});

test("synchronizes base changes made through host-realm DOM methods", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#url-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The URL frame has no child window");
    }

    const virtualDocument = child.document;
    const initialBase = virtualDocument.querySelector("#initial-base") as HTMLBaseElement;
    Element.prototype.setAttribute.call(initialBase, "href", "/host-bypass/");
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    const changed = virtualDocument.baseURI;

    const prependedBase = virtualDocument.createElement("base");
    prependedBase.href = "/host-inserted/";
    Node.prototype.insertBefore.call(
      virtualDocument.head,
      prependedBase,
      virtualDocument.head.firstChild,
    );
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    const inserted = virtualDocument.baseURI;

    Element.prototype.remove.call(prependedBase);
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    return { changed, inserted, removed: virtualDocument.baseURI };
  });

  expect(result).toEqual({
    changed: `${fixture.origin}/host-bypass/`,
    inserted: `${fixture.origin}/host-inserted/`,
    removed: `${fixture.origin}/host-bypass/`,
  });
});

test("rebases SVG href and xlink resources without replacing SVGAnimatedString", async ({ page }) => {
  await mountFrame(page);

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#url-frame") as HTMLElement & {
      contentWindow: Window | null;
      shadowRoot: ShadowRoot | null;
    };
    const child = frame.contentWindow;
    if (child === null || frame.shadowRoot === null) {
      throw new Error("The URL frame is missing its child realm or shadow root");
    }

    const virtualDocument = child.document;
    const svgImage = virtualDocument.querySelector("#svg-image") as SVGImageElement;
    const svgUse = virtualDocument.querySelector("#svg-use") as SVGUseElement;
    const filterImage = virtualDocument.querySelector("#svg-filter-image") as SVGFEImageElement;
    const initialBase = virtualDocument.querySelector("#initial-base") as HTMLBaseElement;
    const secondaryBase = virtualDocument.querySelector("#secondary-base") as HTMLBaseElement;
    const invalidBase = virtualDocument.querySelector("#invalid-base") as HTMLBaseElement;
    const xlinkNamespace = "http://www.w3.org/1999/xlink";
    const physicalAttribute = (element: Element, name: string) =>
      Element.prototype.getAttribute.call(element, name);
    const snapshot = () => ({
      baseURI: virtualDocument.baseURI,
      image: {
        attribute: svgImage.getAttribute("href"),
        baseVal: svgImage.href.baseVal,
        physical: physicalAttribute(svgImage, "href"),
      },
      use: {
        attribute: svgUse.getAttribute("xlink:href"),
        namespaced: svgUse.getAttributeNS(xlinkNamespace, "href"),
        baseVal: svgUse.href.baseVal,
        physical: physicalAttribute(svgUse, "xlink:href"),
      },
      filterImage: {
        attribute: filterImage.getAttribute("href"),
        baseVal: filterImage.href.baseVal,
        physical: physicalAttribute(filterImage, "href"),
      },
      animatedStringPreserved:
        typeof svgImage.href === "object" &&
        "baseVal" in svgImage.href &&
        "animVal" in svgImage.href,
    });

    const states: Record<string, ReturnType<typeof snapshot>> = {
      initial: snapshot(),
    };
    initialBase.setAttribute("href", "svg-relative/");
    states.changedBase = snapshot();

    const svgNamespace = "http://www.w3.org/2000/svg";
    const dynamicImage = virtualDocument.createElementNS(svgNamespace, "image") as SVGImageElement;
    const dynamicUse = virtualDocument.createElementNS(svgNamespace, "use") as SVGUseElement;
    const dynamicFilterImage = virtualDocument.createElementNS(
      svgNamespace,
      "feImage",
    ) as SVGFEImageElement;
    dynamicImage.href.baseVal = "dynamic-image.svg";
    dynamicUse.setAttributeNS(xlinkNamespace, "xlink:href", "dynamic-symbols.svg#shape");
    dynamicFilterImage.setAttribute("href", "dynamic-filter.svg");
    virtualDocument.querySelector("svg")?.append(
      dynamicImage,
      dynamicUse,
      dynamicFilterImage,
    );
    const dynamic = {
      image: [
        dynamicImage.getAttribute("href"),
        dynamicImage.href.baseVal,
        physicalAttribute(dynamicImage, "href"),
      ],
      use: [
        dynamicUse.getAttribute("xlink:href"),
        dynamicUse.getAttributeNS(xlinkNamespace, "href"),
        dynamicUse.href.baseVal,
        physicalAttribute(dynamicUse, "xlink:href"),
      ],
      filterImage: [
        dynamicFilterImage.getAttribute("href"),
        dynamicFilterImage.href.baseVal,
        physicalAttribute(dynamicFilterImage, "href"),
      ],
    };

    child.history.pushState({}, "", "nested/state.html");
    states.afterHistory = snapshot();
    secondaryBase.remove();
    invalidBase.remove();
    initialBase.remove();
    states.withoutBase = snapshot();
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    states.afterObserverDelivery = snapshot();
    return { dynamic, states };
  });

  const initialState = {
    baseURI: `${fixture.origin}/initial-base/`,
    image: {
      attribute: "image.svg",
      baseVal: "image.svg",
      physical: `${fixture.origin}/initial-base/image.svg`,
    },
    use: {
      attribute: "symbols.svg#shape",
      namespaced: "symbols.svg#shape",
      baseVal: "symbols.svg#shape",
      physical: `${fixture.origin}/initial-base/symbols.svg#shape`,
    },
    filterImage: {
      attribute: "filter.svg",
      baseVal: "filter.svg",
      physical: `${fixture.origin}/initial-base/filter.svg`,
    },
    animatedStringPreserved: true,
  };
  expect(result).toEqual({
    dynamic: {
      image: [
        "dynamic-image.svg",
        "dynamic-image.svg",
        `${fixture.origin}/documents/svg-relative/dynamic-image.svg`,
      ],
      use: [
        "dynamic-symbols.svg#shape",
        "dynamic-symbols.svg#shape",
        "dynamic-symbols.svg#shape",
        `${fixture.origin}/documents/svg-relative/dynamic-symbols.svg#shape`,
      ],
      filterImage: [
        "dynamic-filter.svg",
        "dynamic-filter.svg",
        `${fixture.origin}/documents/svg-relative/dynamic-filter.svg`,
      ],
    },
    states: {
      initial: initialState,
      changedBase: {
        ...initialState,
        baseURI: `${fixture.origin}/documents/svg-relative/`,
        image: {
          ...initialState.image,
          physical: `${fixture.origin}/documents/svg-relative/image.svg`,
        },
        use: {
          ...initialState.use,
          physical: `${fixture.origin}/documents/svg-relative/symbols.svg#shape`,
        },
        filterImage: {
          ...initialState.filterImage,
          physical: `${fixture.origin}/documents/svg-relative/filter.svg`,
        },
      },
      afterHistory: {
        ...initialState,
        baseURI: `${fixture.origin}/documents/svg-relative/nested/svg-relative/`,
        image: {
          ...initialState.image,
          physical: `${fixture.origin}/documents/svg-relative/nested/svg-relative/image.svg`,
        },
        use: {
          ...initialState.use,
          physical: `${fixture.origin}/documents/svg-relative/nested/svg-relative/symbols.svg#shape`,
        },
        filterImage: {
          ...initialState.filterImage,
          physical: `${fixture.origin}/documents/svg-relative/nested/svg-relative/filter.svg`,
        },
      },
      withoutBase: {
        ...initialState,
        baseURI: `${fixture.origin}/documents/svg-relative/nested/state.html`,
        image: {
          ...initialState.image,
          physical: `${fixture.origin}/documents/svg-relative/nested/image.svg`,
        },
        use: {
          ...initialState.use,
          physical: `${fixture.origin}/documents/svg-relative/nested/symbols.svg#shape`,
        },
        filterImage: {
          ...initialState.filterImage,
          physical: `${fixture.origin}/documents/svg-relative/nested/filter.svg`,
        },
      },
      afterObserverDelivery: {
        ...initialState,
        baseURI: `${fixture.origin}/documents/svg-relative/nested/state.html`,
        image: {
          ...initialState.image,
          physical: `${fixture.origin}/documents/svg-relative/nested/image.svg`,
        },
        use: {
          ...initialState.use,
          physical: `${fixture.origin}/documents/svg-relative/nested/symbols.svg#shape`,
        },
        filterImage: {
          ...initialState.filterImage,
          physical: `${fixture.origin}/documents/svg-relative/nested/filter.svg`,
        },
      },
    },
  });
});
