import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import { type HTTPFixture } from "./support/http-fixture";
import {
  mountGuestDocument,
  startGuestDocumentFixture,
} from "./support/guest-document-fixture";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startGuestDocumentFixture();
});

test.afterAll(async () => fixture.close());

const mounted = (page: Page, route?: string) => mountGuestDocument(page, fixture, route);

test("stylesheet redirects preserve asset and import bases and live link identity", async ({
  page,
}) => {
  const frame = await mounted(page, "/linked");
  const identity = await frame.evaluate((element: VFrameElement) => {
    const link =
      element.contentWindow!.document.querySelector<HTMLLinkElement>("#theme")!;
    return {
      connected: link.isConnected,
      sheet: link.sheet !== null,
      owner: link.sheet?.ownerNode === link,
      href: link.sheet?.href,
    };
  });
  expect(identity).toEqual({
    connected: true,
    sheet: true,
    owner: true,
    href: `${fixture.origin}/new/theme.css`,
  });
  await expect(frame.locator("#target")).toHaveCSS("color", "rgb(11, 22, 33)");
  await expect(frame.locator("#target")).toHaveCSS(
    "background-image",
    `url("${fixture.origin}/new/asset.svg")`,
  );
  expect(fixture.requests).not.toContain("/old/nested.css");

  const disabled = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const link = guest.document.querySelector<HTMLLinkElement>("#theme")!;
    link.disabled = true;
    const disabled = guest.getComputedStyle(
      guest.document.querySelector("#target")!,
    ).color;
    link.disabled = false;
    link.media = "not all";
    const unmatched = guest.getComputedStyle(
      guest.document.querySelector("#target")!,
    ).color;
    link.media = "all";
    return {
      disabled,
      unmatched,
      restored: guest.getComputedStyle(guest.document.querySelector("#target")!).color,
    };
  });
  expect(disabled).toEqual({
    disabled: "rgb(0, 0, 0)",
    unmatched: "rgb(0, 0, 0)",
    restored: "rgb(11, 22, 33)",
  });

  const replaced = await frame.evaluate(async (element: VFrameElement) => {
    const link =
      element.contentWindow!.document.querySelector<HTMLLinkElement>("#theme")!;
    const oldSheet = link.sheet!;
    const loaded = new Promise<void>((resolve) =>
      link.addEventListener("load", () => resolve(), { once: true }),
    );
    link.href = "/blue.css";
    await loaded;
    const index = oldSheet.insertRule('#held { background-image: url("held.svg") }');
    return {
      oldURL: oldSheet.href,
      replaced: link.sheet !== oldSheet,
      background: (oldSheet.cssRules[index] as CSSStyleRule).style.backgroundImage,
    };
  });
  expect(replaced).toEqual({
    oldURL: `${fixture.origin}/new/theme.css`,
    replaced: true,
    background: `url("${fixture.origin}/new/held.svg")`,
  });
  await expect(frame.locator("#target")).toHaveCSS("color", "rgb(44, 55, 66)");
  const removed = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const link = guest.document.querySelector<HTMLLinkElement>("#theme")!;
    link.remove();
    return {
      sheet: link.sheet === null,
      color: guest.getComputedStyle(guest.document.querySelector("#target")!).color,
    };
  });
  expect(removed).toEqual({ sheet: true, color: "rgb(0, 0, 0)" });
});

test("inline style writes preserve other CSSOM rules instead of reparsing the sheet", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const nodes = Array.from({ length: 100 }, () => {
      const node = guest.document.createElement("div");
      node.style.color = "rgb(1, 2, 3)";
      guest.document.body.append(node);
      return node;
    });
    const style = element.shadowRoot!.querySelector<HTMLStyleElement>(
      "style[data-v-frame-inline-styles]",
    )!;
    const sheet = style.sheet!;
    const rules = Array.from(sheet.cssRules);
    let reparses = 0;
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    Object.defineProperty(style, "textContent", {
      configurable: true,
      get: () => textContent.get!.call(style),
      set: (value: string) => {
        reparses++;
        textContent.set!.call(style, value);
      },
    });
    for (const node of nodes) node.style.color = "rgb(4, 5, 6)";
    return {
      reparses,
      retained: rules.every((rule, index) => sheet.cssRules[index] === rule),
      colors: new Set(nodes.map((node) => guest.getComputedStyle(node).color)).size,
      first: guest.getComputedStyle(nodes[0]!).color,
      count: sheet.cssRules.length,
    };
  });
  expect(result).toEqual({
    reparses: 0,
    retained: true,
    colors: 1,
    first: "rgb(4, 5, 6)",
    count: 100,
  });
});
