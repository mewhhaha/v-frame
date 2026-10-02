import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import {
  bundleRoute,
  registerBundleRoute,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import type { VFrameElement } from "../src/index";

const form = `<form><label>Name<input id="name" value="server"></label>
  <label>Note<textarea id="note">server-note</textarea></label>
  <label>Enabled<input id="enabled" type="checkbox" checked></label>
  <label>Choice<select id="choice"><option>one</option><option>two</option></select></label>
  <label>Choices<select id="choices" multiple><option selected>one</option><option>two</option><option>three</option></select></label>
  <label>Upload<input id="upload" type="file"></label>
  <label>A<input id="a" type="radio" name="group" checked></label>
  <label>B<input id="b" type="radio" name="group"></label></form>
  <div id="panel" style="height:70px;overflow:auto"><div style="height:400px">Scroll area</div></div>`;

const reactForm = `<div id="react-root"><form><label>Name<input id="name" value="server"></label><label>Note<textarea id="note">server-note</textarea></label><label>Enabled<input id="enabled" type="checkbox" checked></label><output id="model">server|server-note|true</output><button type="button" id="rerender">Render 0</button></form></div>`;

function host(body: string, module = "/guest.js") {
  return `<!doctype html><html lang="en"><head><title>SSR state</title></head><body style="height:1800px">
    <button id="outside">Outside</button><v-frame id="frame" adopt src="/guest" aria-label="Guest" style="display:block;width:500px;height:280px;overflow:auto">
    <template shadowrootmode="open" shadowrootserializable><v-html><v-head><style>v-html,v-body{display:block}v-head{display:none}v-body{min-height:600px}label{display:block}</style></v-head><v-body>${body}
    <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module" src="${module}"></script>
    </v-body></v-html></template></v-frame><script>globalThis.hydrationErrors=[]</script><script type="module" src="/dist/register.js"></script></body></html>`;
}

let fixture: HTTPFixture;
test.beforeAll(async () => {
  const bundle = await rolldown({
    input: resolve("tests/support/react-adoption-lab.js"),
    platform: "browser",
    resolve: { modules: [resolve("examples/client/node_modules"), "node_modules"] },
  });
  let react: string;
  try {
    react = (await bundle.generate({ format: "es" })).output.find(
      (item) => item.type === "chunk",
    )!.code;
  } finally {
    await bundle.close();
  }
  fixture = await startHTTPFixture({
    routes: {
      "/": host(form),
      "/react": host(reactForm, "/react.js"),
      "/dist/index.js": bundleRoute,
      "/dist/register.js": registerBundleRoute,
      "/guest": "<!doctype html><html><body>Network fallback</body></html>",
      "/react.js": { type: "text/javascript", body: react },
      "/guest.js": {
        type: "text/javascript",
        body: `
      const snapshot=()=>({name:document.querySelector('#name').value,note:document.querySelector('#note').value,checked:document.querySelector('#enabled').checked,choice:document.querySelector('#choice').value,choices:Array.from(document.querySelector('#choices').selectedOptions,o=>o.value),file:document.querySelector('#upload').files[0]?.name,a:document.querySelector('#a').checked,b:document.querySelector('#b').checked});
      globalThis.initial=snapshot(); globalThis.notifications=[];
      document.addEventListener('input',e=>notifications.push('input:'+e.target.id));
      document.addEventListener('change',e=>notifications.push('change:'+e.target.id));
      document.querySelector('#name').addEventListener('input',e=>globalThis.nameModel=e.target.value);
      if(top.location.search.includes('defaults')) document.querySelector('#note').value='client-note';
    `,
      },
    },
  });
});
test.afterAll(async () => fixture.close());

async function pending(page: Page, path = "/", module = "/guest.js") {
  let registration: Route | undefined;
  let script: Route | undefined;
  await page.route("**/dist/register.js", (route) => {
    registration = route;
  });
  await page.route(`**${module}`, (route) => {
    script = route;
  });
  await page.goto(fixture.origin + path, { waitUntil: "commit" });
  const frame = page.locator("#frame");
  await expect(frame.locator("#name")).toBeVisible();
  await expect.poll(() => !!registration).toBe(true);
  return {
    frame,
    preview: frame.locator("v-html").first(),
    register: async () => {
      await registration!.continue();
      await expect.poll(() => !!script).toBe(true);
    },
    release: async () => {
      await script!.continue();
    },
    activate: async () => {
      await script!.continue();
      await expect
        .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
        .toBe("ready");
    },
  };
}

test("preserves early and pending form edits, selection, focus and both scroll positions", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(page);
  await preview.locator("#name").fill("before registration");
  await preview.locator("#enabled").uncheck();
  await preview.locator("#choice").selectOption("two");
  await preview.locator("#choices").selectOption(["two", "three"]);
  await preview.locator("#upload").setInputFiles({
    name: "edit.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("early edit"),
  });
  await preview.locator("#b").check();
  await register();
  await preview.locator("#note").fill("after registration");
  await preview
    .locator("#note")
    .evaluate((element: HTMLTextAreaElement) =>
      element.setSelectionRange(2, 5, "backward"),
    );
  await preview.locator("#panel").evaluate((element) => {
    element.scrollTop = 50;
  });
  await frame.evaluate((element) => {
    element.scrollTop = 40;
  });
  const hostScroll = await page.evaluate(() => scrollY);
  await activate();
  await expect(frame.locator("v-html")).toHaveCount(1);
  const state = await frame.evaluate((element) => {
    const guest = (element as VFrameElement).contentWindow! as Window & {
      initial: unknown;
      notifications: string[];
      nameModel: string;
    };
    const note = guest.document.querySelector<HTMLTextAreaElement>("#note")!;
    return {
      initial: guest.initial,
      notifications: guest.notifications,
      nameModel: guest.nameModel,
      focused: element.shadowRoot!.activeElement?.id,
      selection: [note.selectionStart, note.selectionEnd, note.selectionDirection],
      frameScroll: element.scrollTop,
      panelScroll: guest.document.querySelector("#panel")!.scrollTop,
    };
  });
  expect(state.initial).toEqual({
    name: "before registration",
    note: "after registration",
    checked: false,
    choice: "two",
    choices: ["two", "three"],
    file: "edit.txt",
    a: false,
    b: true,
  });
  expect(state.nameModel).toBe("before registration");
  expect(state.notifications.filter((entry) => entry === "change:enabled")).toHaveLength(
    1,
  );
  expect(state).toMatchObject({
    focused: "note",
    selection: [2, 5, "backward"],
    frameScroll: 40,
    panelScroll: 50,
  });
  expect(await page.evaluate(() => scrollY)).toBe(hostScroll);
});

test("does not steal focus from another host control or overwrite pristine guest defaults", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(page, "/?defaults");
  await preview.locator("#name").fill("edit");
  await register();
  await page.locator("#outside").focus();
  await activate();
  await expect(page.locator("#outside")).toBeFocused();
  await expect(frame.locator("#name")).toHaveValue("edit");
  await expect(frame.locator("#note")).toHaveValue("client-note");
  expect(
    await frame.evaluate(
      (element) =>
        (
          (element as VFrameElement).contentWindow! as Window & {
            notifications: string[];
          }
        ).notifications,
    ),
  ).toEqual(["input:name", "change:name"]);
});

test("waits for composition end and commits the final IME value", async ({ page }) => {
  const { frame, preview, register, release } = await pending(page);
  await register();
  await preview.locator("#name").focus();
  await preview.locator("#name").dispatchEvent("compositionstart", { data: "に" });
  await preview.locator("#name").evaluate((element: HTMLInputElement) => {
    element.value = "に";
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, isComposing: true }),
    );
  });
  await release();
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (
            (element as VFrameElement).contentWindow! as Window & {
              initial?: { name: string };
            }
          )?.initial?.name,
      ),
    )
    .toBe("に");
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
    .toBe("loading");
  await expect(frame.locator("v-html")).toHaveCount(2);
  await preview.locator("#name").evaluate((element: HTMLInputElement) => {
    element.value = "日本";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    element.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        composed: true,
        data: "日本",
      }),
    );
  });
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
    .toBe("ready");
  await expect(frame.locator("#name")).toHaveValue("日本");
  await expect(frame.locator("#name")).toBeFocused();
});

test("removal aborts a pending composition without reviving its preview", async ({
  page,
}) => {
  const { frame, preview, register, release } = await pending(page);
  await register();
  await preview.locator("#name").dispatchEvent("compositionstart");
  await release();
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          !!((element as VFrameElement).contentWindow! as Window & { initial?: unknown })
            ?.initial,
      ),
    )
    .toBe(true);
  await frame.evaluate((element) => element.remove());
  await expect(page.locator("v-frame")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("React controlled values catch up and survive a subsequent render", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(
    page,
    "/react",
    "/react.js",
  );
  await preview.locator("#name").fill("early");
  await register();
  await preview.locator("#note").fill("pending");
  await preview.locator("#enabled").uncheck();
  await activate();
  await expect(frame.locator("#model")).toHaveText("early|pending|false");
  await frame.locator("#rerender").click();
  await expect(frame.locator("#rerender")).toHaveText("Render 1");
  await expect(frame.locator("#name")).toHaveValue("early");
  await expect(frame.locator("#note")).toHaveValue("pending");
  await expect(frame.locator("#enabled")).not.toBeChecked();
  expect(
    await page.evaluate(
      () =>
        (window as Window & typeof globalThis & { hydrationErrors: string[] })
          .hydrationErrors,
    ),
  ).toEqual([]);
});

test("releases the removed SSR preview while the live realm remains mounted", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit cannot request deterministic GC",
  );
  const { frame, register, activate } = await pending(page);
  await frame.evaluate((element) => {
    (
      window as Window & typeof globalThis & { previewProbe: WeakRef<Node> }
    ).previewProbe = new WeakRef(element.shadowRoot!.firstChild!);
  });
  await register();
  await activate();
  await page.requestGC();
  await page.requestGC();
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & typeof globalThis & { previewProbe: WeakRef<Node> }
        ).previewProbe.deref() === undefined,
    ),
  ).toBe(true);
  await expect(frame.locator("#name")).toHaveValue("server");
});
