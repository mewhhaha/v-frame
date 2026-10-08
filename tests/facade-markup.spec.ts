import { expect, test, type Locator } from "@playwright/test";
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

type World = Window & typeof globalThis;

// Runs one scenario in the host page and in the guest, against the same kind of
// objects, so the browser itself is the expectation.
async function inBothWorlds<T>(frame: Locator, scenario: (win: World) => T) {
  return frame.evaluate((element, source) => {
    const run = new Function(`return (${source})`)() as (win: unknown) => unknown;
    return {
      host: run(window),
      guest: run((element as HTMLElement & { contentWindow: Window }).contentWindow),
    };
  }, scenario.toString()) as Promise<{ host: T; guest: T }>;
}

async function mountDom(page: import("@playwright/test").Page) {
  await installBundle(page, fixture.origin);
  return mountFrame(page, { src: `${fixture.origin}/documents/dom.html` });
}

test("serializes the authored markup, as a plain element does", async ({ page }) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, (win) => {
    const doc = win.document;
    const box = doc.createElement("section");
    doc.body.append(box);
    box.innerHTML =
      '<div id="a" class="c" onclick="window.__clicks = (window.__clicks || 0) + 1" style="color: red">' +
      '<a href="rel/page.html">x</a>' +
      '<img src="p.png" srcset="a.png 1x, b.png 2x">' +
      '<link rel="stylesheet" href="data:text/css,">' +
      '<script type="text/plain" src="s.js"></script>' +
      '<template><b onclick="void 0" style="color: blue">t</b></template>' +
      '<svg viewBox="0 0 1 1"><use href="#z"></use><a xlink:href="rel.svg"></a></svg>' +
      "</div>";
    const target = box.firstElementChild as HTMLElement;
    const getHTML = (target as unknown as { getHTML?: () => string }).getHTML;
    const out = {
      inner: box.innerHTML,
      outer: target.outerHTML,
      getHTML: getHTML === undefined ? null : getHTML.call(box),
      serialized: new win.XMLSerializer().serializeToString(target),
      template: (target.querySelector("template") as HTMLTemplateElement).innerHTML,
    };
    box.remove();
    return out;
  });
  expect(result.guest.inner).toBe(result.host.inner);
  expect(result.guest.outer).toBe(result.host.outer);
  expect(result.guest.getHTML).toBe(result.host.getHTML);
  expect(result.guest.template).toBe(result.host.template);
  expect(result.guest.serialized).toBe(result.host.serialized);
  expect(result.guest.inner).toContain('onclick="window.__clicks');
  expect(result.guest.inner).toContain('style="color: red"');
  expect(result.guest.inner).toContain('src="s.js"');
  expect(result.guest.inner).toContain('href="rel/page.html"');
  expect(result.guest.inner).not.toMatch(/v-frame/);
});

test("XMLSerializer accepts shadow roots and serializes the guest document", async ({
  page,
}) => {
  const frame = await mountDom(page);
  const shadows = await inBothWorlds(frame, (win) => {
    const host = win.document.createElement("div");
    win.document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const link = win.document.createElement("a");
    link.setAttribute("href", "./relative");
    link.setAttribute("onclick", "void 0");
    link.setAttribute("style", "color: red");
    link.textContent = "shadow contents";
    shadow.append(link);
    const result = new win.XMLSerializer().serializeToString(shadow);
    host.remove();
    return result;
  });
  expect(shadows.guest).toBe(shadows.host);
  expect(shadows.guest).toContain('href="./relative"');

  const documentResult = await frame.evaluate((element) => {
    const win = (element as HTMLElement & { contentWindow: World }).contentWindow;
    const doc = win.document;
    doc.documentElement.setAttribute("lang", "en");
    doc.head.innerHTML = "<title>Guest serialization</title>";
    doc.body.innerHTML =
      '<a href="./relative" onclick="void 0" style="color: red">guest contents</a>';
    const expected = document.implementation.createHTMLDocument("Guest serialization");
    expected.documentElement.setAttribute("lang", "en");
    expected.body.innerHTML =
      '<a href="./relative" onclick="void 0" style="color: red">guest contents</a>';
    return {
      guest: new win.XMLSerializer().serializeToString(doc),
      native: new XMLSerializer().serializeToString(expected),
    };
  });
  expect(documentResult.guest).toBe(documentResult.native);
});

test("copies handlers, styles and scripts through markup round trips", async ({
  page,
}) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, (win) => {
    const doc = win.document;
    const source = doc.createElement("section");
    const copy = doc.createElement("section");
    const again = doc.createElement("section");
    doc.body.append(source, copy, again);
    source.innerHTML =
      '<p id="p" onclick="window.__clicks = (window.__clicks || 0) + 1" style="color: rgb(255, 0, 0)">x</p>' +
      '<script type="text/plain" src="s.js"></script>';
    copy.innerHTML = source.innerHTML;
    (win as unknown as { __clicks: number }).__clicks = 0;
    const p = copy.querySelector("p") as HTMLElement;
    p.click();
    const replaced = doc.createElement("div");
    again.append(replaced);
    replaced.innerHTML = '<span id="s" style="color: rgb(0, 128, 0)">y</span>';
    const span = replaced.firstElementChild as HTMLElement;
    const authored = span.outerHTML;
    span.outerHTML = authored;
    const out = {
      clicks: (win as unknown as { __clicks: number }).__clicks,
      color: win.getComputedStyle(p).color,
      spanColor: win.getComputedStyle(replaced.firstElementChild!).color,
      scriptSrc: copy.querySelector("script")!.getAttribute("src"),
      scriptType: copy.querySelector("script")!.getAttribute("type"),
    };
    source.remove();
    copy.remove();
    again.remove();
    return out;
  });
  expect(result.guest).toEqual(result.host);
  expect(result.guest.clicks).toBe(1);
  expect(result.guest.color).toBe("rgb(255, 0, 0)");
  expect(result.guest.spanColor).toBe("rgb(0, 128, 0)");
});

const ORDER_SCENARIOS = (win: World) => {
  const doc = win.document;
  const results: Record<string, unknown> = {};
  const build = () => {
    const wrap = doc.createElement("div");
    const box = doc.createElement("div");
    wrap.append(box);
    doc.body.append(wrap);
    box.innerHTML = '<p id="x"></p><i id="n"></i><b id="m"></b><u id="e"></u>';
    const byId = (id: string) => box.querySelector(`#${id}`) as HTMLElement;
    const observer = new win.MutationObserver(() => undefined);
    observer.observe(box, { childList: true });
    const finish = () => ({
      order: Array.from(box.children).map((child) => child.id || child.tagName),
      records: observer.takeRecords().length,
    });
    return { wrap, box, byId, finish, observer };
  };
  const run = (name: string, step: (api: ReturnType<typeof build>) => void) => {
    const api = build();
    let error: string | null = null;
    try {
      step(api);
    } catch (thrown) {
      error = (thrown as DOMException).name;
    }
    results[name] = { ...api.finish(), error };
    api.observer.disconnect();
    api.wrap.remove();
  };
  run("after next sibling", ({ byId }) => byId("x").after(byId("n"), "t"));
  run("after reversed", ({ byId }) => byId("x").after(byId("m"), byId("n")));
  run("before previous sibling", ({ byId }) => byId("n").before("t", byId("x")));
  run("prepend first child", ({ box, byId }) => box.prepend(byId("x"), "t"));
  run("prepend later", ({ box, byId }) => box.prepend(byId("m"), byId("n")));
  run("append existing", ({ box, byId }) => box.append(byId("x"), byId("n")));
  run("replaceWith self", ({ byId }) => byId("n").replaceWith(byId("n")));
  run("replaceWith self and other", ({ byId }) => byId("n").replaceWith(byId("n"), "t"));
  run("replaceWith next", ({ byId }) => byId("n").replaceWith(byId("m"), "t"));
  run("replaceWith none", ({ byId }) => byId("n").replaceWith());
  run("text node after", ({ box, byId }) => {
    const text = doc.createTextNode("w");
    byId("x").before(text);
    text.after(byId("n"), byId("e"));
    return void box;
  });
  run("ancestor rejected", ({ wrap, byId }) => byId("x").after(byId("m"), wrap));
  run("ancestor rejected for replace", ({ wrap, byId }) =>
    byId("n").replaceWith(byId("m"), wrap),
  );
  return results;
};

test("after, before, prepend and replaceWith insert like the browser's", async ({
  page,
}) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, ORDER_SCENARIOS);
  expect(result.guest).toEqual(result.host);
  expect(result.guest["after next sibling"]).toMatchObject({
    order: ["x", "n", "m", "e"].length ? ["x", "n", "m", "e"] : [],
    records: 2,
  });
  expect(result.guest["prepend first child"]).toMatchObject({
    order: ["x", "n", "m", "e"],
  });
  expect(result.guest["replaceWith self"]).toMatchObject({
    order: ["x", "n", "m", "e"],
  });
  expect(result.guest["ancestor rejected"]).toMatchObject({
    error: "HierarchyRequestError",
  });
});

const RANGE_SCENARIO = (win: World) => {
  const doc = win.document;
  const host = win as unknown as { __rc: number };
  const out: Record<string, unknown> = {};
  for (const mode of ["document", "constructor"] as const) {
    for (const operation of ["cloneContents", "extractContents"] as const) {
      const box = doc.createElement("div");
      const target = doc.createElement("div");
      doc.body.append(box, target);
      box.innerHTML =
        'pre <b id="b" style="color: rgb(255, 0, 0)">bold <i id="i" onclick="window.__rc = (window.__rc || 0) + 1" style="color: rgb(0, 128, 0)">ital</i> tail</b>' +
        '<script type="text/plain" src="s.js"></script><u onclick="window.__rc = (window.__rc || 0) + 10">end</u> post';
      host.__rc = 0;
      const range = mode === "document" ? doc.createRange() : new win.Range();
      const bold = box.querySelector("b") as HTMLElement;
      range.setStart(bold.firstChild as Text, 2);
      range.setEnd(box.lastChild as Text, 2);
      const fragment = range[operation]();
      target.append(fragment);
      const italic = target.querySelector("i") as HTMLElement;
      italic.click();
      (target.querySelector("u") as HTMLElement).click();
      const key = `${mode} ${operation}`;
      out[key] = {
        clicks: host.__rc,
        boldStyle: target.querySelector("b")!.getAttribute("style"),
        boldColor: win.getComputedStyle(target.querySelector("b")!).color,
        italicColor: win.getComputedStyle(italic).color,
        scriptSrc: target.querySelector("script")!.getAttribute("src"),
        scriptType: target.querySelector("script")!.getAttribute("type"),
        markup: target.innerHTML,
        left: box.innerHTML,
      };
      box.remove();
      target.remove();
    }
  }
  return out;
};

test("Range.cloneContents and extractContents keep what the nodes were authored with", async ({
  page,
}) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, RANGE_SCENARIO);
  expect(result.guest).toEqual(result.host);
  expect(result.guest["document cloneContents"]).toMatchObject({
    clicks: 11,
    boldStyle: "color: rgb(255, 0, 0)",
    italicColor: "rgb(0, 128, 0)",
    scriptSrc: "s.js",
  });
});

test("Range insertion rejects non-nodes with the guest's TypeError", async ({ page }) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, (win) => {
    const box = win.document.createElement("div");
    box.textContent = "range";
    win.document.body.append(box);
    const out = [];
    for (const range of [win.document.createRange(), new win.Range()]) {
      range.selectNodeContents(box);
      for (const method of ["insertNode", "surroundContents"] as const) {
        for (const value of [null, undefined, {}, { nodeType: 1 }]) {
          try {
            range[method](value as Node);
            out.push("accepted");
          } catch (error) {
            out.push(error instanceof win.TypeError);
          }
        }
      }
    }
    box.remove();
    return out;
  });
  expect(result.guest).toEqual(result.host);
  expect(result.guest).toEqual(Array(16).fill(true));
});

test("Range clones preserve authored metadata at text and element boundaries", async ({
  page,
}) => {
  const frame = await mountDom(page);
  const result = await inBothWorlds(frame, (win) => {
    const box = win.document.createElement("div");
    win.document.body.append(box);
    box.innerHTML =
      '<aside><i>before</i></aside><p style="color: red">start<b style="color: blue">bold</b></p><p onclick="void 0">end<i>tail</i></p><aside><i>after</i></aside>';
    const [first, second] = Array.from(box.querySelectorAll("p")) as [
      HTMLParagraphElement,
      HTMLParagraphElement,
    ];
    const boundaries: Array<[Node, number, Node, number]> = [
      [first.firstChild!, 2, second.firstChild!, 2],
      [first, 1, second, 1],
      [box, 1, second.firstChild!, 2],
      [first.firstChild!, 2, box, 3],
      [first.firstChild!, 1, first.firstChild!, 4],
      [first, first.childNodes.length, second, 0],
      [box, 1, box, 3],
    ];
    const out = boundaries.map(([start, startOffset, end, endOffset]) => {
      const range = win.document.createRange();
      range.setStart(start, startOffset);
      range.setEnd(end, endOffset);
      const copy = win.document.createElement("div");
      copy.append(range.cloneContents());
      return copy.innerHTML;
    });
    box.remove();
    return out;
  });
  expect(result.guest).toEqual(result.host);
});
