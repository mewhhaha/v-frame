import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
declare global {
  interface Window {
    releaseGuest(): void;
  }
}

const preview = `<v-html><v-head><style>v-html,v-body{display:block} v-head{display:none}</style></v-head><v-body>
  <div id="editor" contenteditable><p style="text-align:left">First <b>part</b></p></div><div id="other" contenteditable="plaintext-only">Server</div>
  <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module" src="/guest.js"></script>
  </v-body></v-html>`;

function host(markup: string) {
  return htmlDocument(
    `<v-frame adopt src="/guest"><template shadowrootmode="open" shadowrootserializable>${markup}</template></v-frame>`,
  );
}

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": host(preview),
      "/mentions": host(
        preview.replace(
          "First <b>",
          'First <span contenteditable="false" data-mention>@Ada</span> and <span contenteditable="false" data-mention>@Ada</span> <b>',
        ),
      ),
      "/dist/index.js": bundleRoute,
      "/guest.js": {
        type: "text/javascript",
        body: `
        let editor = document.querySelector('#editor');
        const mode = new URL(top.location.href).searchParams.get('mode');
        if (['replace', 'readonly', 'widget'].includes(mode)) {
          const replacement = editor.cloneNode(true);
          if (mode === 'readonly') replacement.contentEditable = 'false';
          editor.replaceWith(replacement);
          editor = replacement;
        }
        if (mode === 'widget' || mode === 'original-toolbar') {
          const mention = editor.querySelector('[data-mention]');
          const widget = document.createElement(mention?.localName || 'p');
          widget.contentEditable = 'false';
          widget.textContent = 'Toolbar';
          widget.onclick = () => editor.dataset.toolbar = 'clicked';
          (mention?.parentElement || editor).prepend(widget);
        }
        if (mode === 'lookalike') {
          const original = editor.querySelector('[data-mention]');
          const widget = original.cloneNode(true);
          original.replaceWith(widget);
          widget.onclick = () => editor.dataset.toolbar = 'clicked';
        }
        editor.querySelector('b').onclick = () => editor.dataset.clicked = 'yes';
        document.addEventListener('input', e => {
          e.target.dataset.model = e.target.textContent;
          e.target.dataset.events = Number(e.target.dataset.events || 0) + 1;
        });
        document.querySelector('#other').textContent = 'Client default';
        await new Promise(resolve => {top.releaseGuest = resolve;});
      `,
      },
    },
  });
});
test.afterAll(async () => fixture.close());

async function pending(page: Page, mode = "", path = "/") {
  await page.goto(fixture.origin + path + "?mode=" + mode);
  await page.evaluate(
    async (url) => (await import(url)).defineVFrame(),
    fixture.origin + "/dist/index.js",
  );
  await page.waitForFunction(() => "releaseGuest" in window);
  const frame = page.locator("v-frame");
  return {
    preview: frame.locator("v-html").first(),
    frame,
    release: async () => {
      await page.evaluate(() => window.releaseGuest());
      await expect(frame).toHaveJSProperty("status", "ready");
    },
  };
}

for (const mode of ["", "replace"]) {
  test(`keeps rich edits, guest listeners, and the caret in the ${mode || "original"} editing host`, async ({
    page,
  }) => {
    const { preview, frame, release } = await pending(page, mode);
    const bold = preview.locator("#editor b");
    await bold.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" two");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await release();
    const editor = frame.locator("#editor");
    await expect(editor.locator("b")).toHaveText("part two");
    await expect(editor).toHaveAttribute("data-events", "1");
    await expect(editor).toHaveAttribute("data-model", "First part two");
    await expect(frame.locator("#other")).toHaveText("Client default");
    await page.keyboard.type("here");
    await expect(editor.locator("b")).toHaveText("part there");
    await editor.locator("b").click();
    await expect(editor).toHaveAttribute("data-clicked", "yes");
  });
}

test("skips an editor that a guest made read-only during activation", async ({
  page,
}) => {
  const { preview, frame, release } = await pending(page, "readonly");
  await preview.locator("#editor b").click();
  await page.keyboard.type("edit");
  await release();
  const editor = frame.locator("#editor");
  await expect(editor).toHaveText("First part");
  await expect(editor).not.toHaveAttribute("data-events");
  expect(await frame.evaluate((el) => el.shadowRoot!.activeElement?.id)).not.toBe(
    "editor",
  );
});

test("splitting a paragraph before the realm connects preserves the next paragraph's identity", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const { defineVFrame } = await import(url);
    const editor = document
      .querySelector("v-frame")!
      .shadowRoot!.querySelector<HTMLElement>("#editor")!;
    const byline = document.createElement("p");
    byline.id = "byline";
    byline.textContent = "Author";
    editor.append(byline);
    editor.focus();
    const text = editor.firstElementChild!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 2, text, 2);
    // Upgrade serializes the preview now. The iframe connects in a later task.
    defineVFrame();
    document.execCommand("insertParagraph");
  }, fixture.origin + "/dist/index.js");
  const frame = page.locator("v-frame");
  const paragraphs = frame.locator("v-html").first().locator("#editor p");
  await expect(paragraphs).toHaveText(["Fi", "rst part", "Author"]);
  await page.waitForFunction(() => "releaseGuest" in window);
  await page.evaluate(() => window.releaseGuest());
  await expect(frame).toHaveJSProperty("status", "ready");
  await expect(paragraphs).toHaveText(["Fi", "rst part", "Author"]);
  expect(await paragraphs.evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual([
    "",
    "",
    "byline",
  ]);
});

test("keeps multi-line plaintext edits through an in-progress composition", async ({
  page,
}) => {
  const { frame, preview } = await pending(page);
  const field = preview.locator("#other");
  await field.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("draft");
  const text = await field.innerText();
  await field.dispatchEvent("compositionstart", { bubbles: true, composed: true });
  await page.evaluate(() => window.releaseGuest());
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(frame).toHaveJSProperty("status", "loading");
  await field.dispatchEvent("compositionend", { bubbles: true, composed: true });
  await expect(frame).toHaveJSProperty("status", "ready");
  expect(await frame.locator("#other").innerText()).toBe(text);
  await expect(frame.locator("#other")).toHaveAttribute("data-events", "1");
});

test("retains native formatting and the guest's read-only widget", async ({ page }) => {
  const { preview, frame, release } = await pending(page, "widget");
  await preview.locator("#editor b").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" two");
  await page.evaluate(() => document.execCommand("justifyCenter"));
  const alignment = await preview
    .locator("#editor p")
    .evaluate((p) => getComputedStyle(p).textAlign);
  expect(alignment).toContain("center");
  await release();
  const editor = frame.locator("#editor");
  await expect(editor.locator("[contenteditable=false]")).toHaveText("Toolbar");
  await expect(editor.locator("p").last()).toHaveCSS("text-align", alignment);
  await page.keyboard.type("!");
  await expect(editor.locator("b")).toHaveText("part two!");
  await editor.locator("b").click();
  await expect(editor).toHaveAttribute("data-clicked", "yes");
});

async function deleteMention(page: Page, mention: Locator) {
  await mention.evaluate((mention) => {
    mention.closest<HTMLElement>("#editor")!.focus();
    const before = mention.previousSibling as Text;
    const after = mention.nextSibling as Text;
    document.getSelection()!.setBaseAndExtent(before, before.length - 1, after, 1);
  });
  await page.keyboard.press("Backspace");
}

for (const mode of ["original-toolbar", "widget"]) {
  test(`deleting a preview mention keeps its sibling and the guest toolbar in ${mode}`, async ({
    page,
  }) => {
    const { preview, frame, release } = await pending(page, mode, "/mentions");
    const mentions = preview.locator("[data-mention]");
    await deleteMention(page, mentions.first());
    await expect(mentions).toHaveCount(1);
    await release();
    const editor = frame.locator("#editor");
    await expect(editor.locator("[data-mention]")).toHaveCount(1);
    await expect(editor).toHaveText(/and @Ada/);
    await editor.getByText("Toolbar", { exact: true }).click();
    await expect(editor).toHaveAttribute("data-toolbar", "clicked");
  });
}

test("an identical read-only control inserted by the guest survives preview deletion", async ({
  page,
}) => {
  const { preview, frame, release } = await pending(page, "lookalike", "/mentions");
  await preview.locator("b").click();
  await page.keyboard.type("!");
  await deleteMention(page, preview.locator("[data-mention]").first());
  await release();
  const editor = frame.locator("#editor");
  const mentions = editor.locator("[data-mention]");
  await expect(mentions).toHaveCount(2);
  await mentions.first().click();
  await expect(editor).toHaveAttribute("data-toolbar", "clicked");
});
