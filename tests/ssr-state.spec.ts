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

const selectForm = `<input id="name" value="server"><select id="choice"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select><select id="choices" multiple><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select>`;

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
      "/handoff": host('<input id="name" name="name" value="server">', "/handoff.js"),
      "/options": host(selectForm, "/options.js"),
      "/options.js": {
        type: "text/javascript",
        body: `
      const mode=new URL(top.location.href).searchParams.get('mode');
      for(let select of document.querySelectorAll('select')) {
        if(mode==='replace-select') {const replacement=select.cloneNode(true);select.replaceWith(replacement);select=replacement;}
        if(mode==='replace' || mode==='ambiguous' || mode==='keyed') {
          const second=select.options[1].cloneNode(true);
          const third=select.options[2].cloneNode(true);
          select.replaceChildren(document.createElement('option'),third,second);
          if(mode==='ambiguous') select.prepend(second.cloneNode(true));
        } else if(mode==='reorder') select.prepend(select.options[2]);
        else if(mode==='remove') select.options[1].remove();
        else {
          const option=document.createElement('option');option.value=mode==='duplicate'?'two':'zero';option.textContent='Inserted';select.prepend(option);
        }
      }
      globalThis.models={};
      document.addEventListener('change',event=>models[event.target.id]=Array.from(event.target.selectedOptions,option=>option.textContent));
    `,
      },
      "/focus": host(
        '<input id="name" value="server"><button data-action="original">Original</button><a href="#local" data-action="link">Link</a><div contenteditable data-action="editable">Editable</div>',
        "/focus.js",
      ),
      "/focus.js": {
        type: "text/javascript",
        body: `
      const mode=new URL(top.location.href).searchParams.get('mode');
      for(const original of document.querySelectorAll('[data-action]')) {
        const extra=original.cloneNode(true);extra.removeAttribute('id');extra.dataset.action='inserted-'+original.dataset.action;extra.textContent='Inserted';original.before(extra);
        if(mode==='remove') original.remove();
        if(mode==='replace' || mode==='keyed') original.replaceWith(original.cloneNode(true));
      }
    `,
      },
      "/namespace": host(
        '<input id="name" value="server"><svg><base href="/foreign/" target="_blank"></base></svg><a id="asset" href="asset.html">Asset</a>',
        "/namespace.js",
      ),
      "/namespace.js": { type: "text/javascript", body: "globalThis.started=true" },
      "/handoff.js": {
        type: "text/javascript",
        body: `
      const field=document.querySelector('#name');
      const mode=new URL(top.location.href).searchParams.get('mode');
      if(mode==='replace' || mode==='rename') {
        const replacement=field.cloneNode(); replacement.value='client-default';
        if(mode==='rename') replacement.id='renamed';
        field.replaceWith(replacement);
      } else if(mode==='remove' || mode==='ambiguous') field.remove();
      if(mode==='ambiguous') for(const value of ['first','second']) {
        const candidate=document.createElement('input');candidate.name='name';candidate.value=value;
        document.body.append(candidate);
      }
      if(mode==='disconnect') field.oninput=()=>top.document.querySelector('#frame').remove();
      if(mode==='failure') document.querySelector('#name').setSelectionRange=()=>{throw new Error('Selection restoration failed')};
      const extra=document.createElement('input');extra.type='number';extra.id='extra';
      document.body.prepend(extra);
    `,
      },
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

for (const mode of ["insert", "reorder", "replace", "replace-select", "duplicate"]) {
  test(`preserves selected option identities after ${mode} during SSR startup`, async ({
    page,
  }) => {
    const { frame, preview, register, activate } = await pending(
      page,
      `/options?mode=${mode}`,
      "/options.js",
    );
    await preview.locator("#choice").selectOption("two");
    await preview.locator("#choices").selectOption(["two", "three"]);
    await register();
    await activate();
    const selected = await frame.evaluate((element) => {
      const guest = (element as VFrameElement).contentWindow! as Window & {
        models: unknown;
      };
      return {
        single: Array.from(
          guest.document.querySelector<HTMLSelectElement>("#choice")!.selectedOptions,
          (option) => option.textContent,
        ),
        multiple: Array.from(
          guest.document.querySelector<HTMLSelectElement>("#choices")!.selectedOptions,
          (option) => option.textContent,
        ),
        models: guest.models,
      };
    });
    const multiple =
      mode === "reorder" || mode === "replace" ? ["Three", "Two"] : ["Two", "Three"];
    expect(selected).toEqual({
      single: ["Two"],
      multiple,
      models: { choice: ["Two"], choices: multiple },
    });
  });
}

for (const mode of ["remove", "ambiguous"]) {
  test(`does not shift a ${mode} selected option to another choice at SSR handoff`, async ({
    page,
  }) => {
    const { frame, preview, register, activate } = await pending(
      page,
      `/options?mode=${mode}`,
      "/options.js",
    );
    await preview.locator("#choice").selectOption("two");
    await preview.locator("#choices").selectOption(["two", "three"]);
    await register();
    await activate();
    await expect(frame.locator("#choice")).toHaveValue("");
    expect(
      await frame
        .locator("#choice")
        .evaluate((select: HTMLSelectElement) => select.selectedIndex),
    ).toBe(-1);
    expect(
      await frame
        .locator("#choices")
        .evaluate((select: HTMLSelectElement) =>
          Array.from(select.selectedOptions, (option) => option.value),
        ),
    ).toEqual(["three"]);
  });
}

test("preserves keyed selections when replacement options have duplicate values", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(
    page,
    "/options?mode=keyed",
    "/options.js",
  );
  await preview.locator("select").evaluateAll((selects: HTMLSelectElement[]) => {
    for (const select of selects)
      Array.from(select.options).forEach((option, index) => {
        option.id = `${select.id}-${index}`;
        option.value = "same";
      });
  });
  await preview.locator("#choice").selectOption({ label: "Two" });
  await preview.locator("#choices").selectOption({ label: "Two" });
  await register();
  await activate();
  expect(
    await frame
      .locator("#choice")
      .evaluate((select: HTMLSelectElement) =>
        Array.from(select.selectedOptions, (option) => option.id),
      ),
  ).toEqual(["choice-1"]);
  expect(
    await frame
      .locator("#choices")
      .evaluate((select: HTMLSelectElement) =>
        Array.from(select.selectedOptions, (option) => option.id),
      ),
  ).toEqual(["choices-1"]);
});

for (const [action, description] of [
  ["original", "button"],
  ["link", "link"],
  ["editable", "editable element"],
]) {
  test(`preserves late focus on the original ${description} after a matching sibling is inserted`, async ({
    page,
  }) => {
    const { frame, preview, register, activate } = await pending(
      page,
      "/focus",
      "/focus.js",
    );
    await register();
    await preview.locator(`[data-action="${action}"]`).focus();
    await activate();
    await expect(frame.locator(`[data-action="${action}"]`)).toBeFocused();
    await expect(frame.locator(`[data-action="inserted-${action}"]`)).not.toBeFocused();
  });
}

for (const mode of ["remove", "replace"]) {
  test(`does not transfer an unkeyed button's focus after ${mode} during SSR startup`, async ({
    page,
  }) => {
    const { frame, preview, register, activate } = await pending(
      page,
      `/focus?mode=${mode}`,
      "/focus.js",
    );
    await preview.locator('[data-action="original"]').focus();
    await register();
    await activate();
    await expect(frame.locator('[data-action="inserted-original"]')).not.toBeFocused();
    if (mode === "replace")
      await expect(frame.locator('[data-action="original"]')).not.toBeFocused();
  });
}

test("preserves a keyed button's focus when it is replaced during SSR startup", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(
    page,
    "/focus?mode=keyed",
    "/focus.js",
  );
  await preview.locator('[data-action="original"]').evaluate((element) => {
    element.id = "keyed-action";
  });
  await preview.locator("#keyed-action").focus();
  await register();
  await activate();
  await expect(frame.locator("#keyed-action")).toBeFocused();
});

test("ignores foreign-namespace base elements when adopting SSR markup", async ({
  page,
}) => {
  const { frame, register, activate } = await pending(
    page,
    "/namespace",
    "/namespace.js",
  );
  await register();
  await activate();
  expect(
    await frame.evaluate((element) => {
      const guest = (element as VFrameElement).contentWindow!;
      const anchor = guest.document.querySelector<HTMLAnchorElement>("#asset")!;
      return {
        baseURI: guest.document.baseURI,
        href: anchor.href,
        physical: Element.prototype.getAttribute.call(anchor, "href"),
      };
    }),
  ).toEqual({
    baseURI: `${fixture.origin}/guest`,
    href: `${fixture.origin}/asset.html`,
    physical: `${fixture.origin}/asset.html`,
  });
});

for (const [mode, description] of [
  ["shift", "shifted control"],
  ["replace", "replaced control"],
  ["rename", "name-matched replacement control"],
]) {
  test(`preserves edits and focus after a ${description} during SSR startup`, async ({
    page,
  }) => {
    const { frame, preview, register, activate } = await pending(
      page,
      `/handoff?mode=${mode}`,
      "/handoff.js",
    );
    await preview.locator("#name").fill("user edit");
    await preview.locator("#name").evaluate((input: HTMLInputElement) => {
      input.setSelectionRange(1, 4, "backward");
    });
    await register();
    await activate();
    const restored = frame.locator('[name="name"]');
    await expect(restored).toBeFocused();
    await expect(restored).toHaveValue("user edit");
    await expect(frame.locator("#extra")).toHaveValue("");
    expect(
      await restored.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]),
    ).toEqual([1, 4, "backward"]);
    await expect(frame.locator("v-html")).toHaveCount(1);
  });
}

test("does not transfer a removed SSR control's focus or value to its neighbour", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(
    page,
    "/handoff?mode=remove",
    "/handoff.js",
  );
  await preview.locator("#name").fill("user edit");
  await register();
  await activate();
  await expect(frame.locator("#name")).toHaveCount(0);
  await expect(frame.locator("#extra")).not.toBeFocused();
  await expect(frame.locator("#extra")).toHaveValue("");
});

test("ambiguous replacement controls keep their values instead of inheriting SSR edits", async ({
  page,
}) => {
  const { frame, preview, register, activate } = await pending(
    page,
    "/handoff?mode=ambiguous",
    "/handoff.js",
  );
  await preview.locator("#name").fill("user edit");
  await register();
  await activate();
  const fields = frame.locator('[name="name"]');
  await expect(fields).toHaveCount(2);
  await expect(fields.nth(0)).toHaveValue("first");
  await expect(fields.nth(1)).toHaveValue("second");
  await expect(fields.nth(0)).not.toBeFocused();
  await expect(fields.nth(1)).not.toBeFocused();
});

test("disconnecting during handoff notifications does not revive the frame or emit load", async ({
  page,
}) => {
  const { frame, preview, register, release } = await pending(
    page,
    "/handoff?mode=disconnect",
    "/handoff.js",
  );
  await preview.locator("#name").fill("user edit");
  const handle = await frame.elementHandle();
  if (!handle) throw new Error("Missing frame");
  await handle.evaluate((element) => {
    (element as VFrameElement & { loads: number }).loads = 0;
    element.addEventListener("v-frame-load", () => {
      (element as VFrameElement & { loads: number }).loads++;
    });
  });
  await register();
  await release();
  await expect(page.locator("v-frame")).toHaveCount(0);
  expect(
    await handle.evaluate((element) => ({
      status: (element as VFrameElement).status,
      loads: (element as VFrameElement & { loads: number }).loads,
    })),
  ).toEqual({ status: "idle", loads: 0 });
  await handle.dispose();
});

test("a replacement started during SSR handoff cannot roll back to the aborted realm", async ({
  page,
}) => {
  const { frame, preview, register, release } = await pending(
    page,
    "/handoff",
    "/handoff.js",
  );
  await preview.locator("#name").fill("user edit");
  await register();
  await frame.evaluate((element) => {
    const frame = element as VFrameElement & {
      handoffFailures: boolean[];
      handoffLoads: number;
    };
    frame.handoffFailures = [];
    frame.handoffLoads = 0;
    frame.addEventListener("v-frame-error", (event) =>
      frame.handoffFailures.push(event.detail.fatal),
    );
    frame.addEventListener("v-frame-load", () => frame.handoffLoads++);
    frame.shadowRoot!.addEventListener(
      "input",
      () => {
        frame.src = "/missing-replacement";
      },
      { capture: true, once: true },
    );
  });
  await release();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("error");
  expect(
    await frame.evaluate((element) => {
      const frame = element as VFrameElement & {
        handoffFailures: boolean[];
        handoffLoads: number;
      };
      return {
        failures: frame.handoffFailures,
        loads: frame.handoffLoads,
        window: frame.contentWindow,
        url: frame.currentURL,
      };
    }),
  ).toEqual({ failures: [true], loads: 0, window: null, url: null });
  await expect(frame.locator("iframe")).toHaveCount(0);
  await frame.evaluate((element: VFrameElement) => {
    element.src = "/guest";
  });
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  await expect(frame.locator("v-body")).toHaveText("Network fallback");
});

test("a failed SSR handoff reports its error and releases the failed realm", async ({
  page,
}) => {
  const { frame, preview, register, release } = await pending(
    page,
    "/handoff?mode=failure",
    "/handoff.js",
  );
  await preview.locator("#name").fill("user edit");
  await frame.evaluate((element) => {
    (
      window as Window &
        typeof globalThis & {
          handoffErrors: Array<{ phase: string; fatal: boolean; message: string }>;
        }
    ).handoffErrors = [];
    element.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent).detail;
      (
        window as Window &
          typeof globalThis & {
            handoffErrors: Array<{ phase: string; fatal: boolean; message: string }>;
          }
      ).handoffErrors.push({
        phase: detail.phase,
        fatal: detail.fatal,
        message: detail.error.message,
      });
    });
  });
  await register();
  await release();
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
    .toBe("error");
  expect(
    await page.evaluate(
      () =>
        (
          window as Window &
            typeof globalThis & {
              handoffErrors: Array<{ phase: string; fatal: boolean; message: string }>;
            }
        ).handoffErrors,
    ),
  ).toEqual([
    { phase: "bootstrap", fatal: true, message: "Selection restoration failed" },
  ]);
  await expect(frame.locator("iframe")).toHaveCount(0);
  await expect(frame.locator("v-html")).toHaveCount(0);
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
