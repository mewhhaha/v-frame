import { createStylesheetContext, rewriteStylesheet } from "../../../src/css.js";

const inertScriptType = "application/vnd.v-frame";

async function fetchStylesheet(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new TypeError(
      `v-frame SSR stylesheet ${url} returned ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

class StylesheetText {
  readonly #documentURL: string;
  #source = "";

  constructor(documentURL: string) {
    this.#documentURL = documentURL;
  }

  async text(chunk: Text): Promise<void> {
    this.#source += chunk.text;
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }

    const source = this.#source;
    this.#source = "";
    const context = createStylesheetContext(fetchStylesheet);
    const rewritten = await rewriteStylesheet(source, this.#documentURL, context);
    // Raw insertion preserves CSS operators such as `>`. A CSS escape keeps an
    // imported string from terminating the surrounding HTML style element.
    const serializedStylesheet = rewritten.replace(/<\/style/gi, "\\3c /style");
    chunk.replace(serializedStylesheet, { html: true });
  }
}

export function materializeVFrameDocument(
  response: Response,
  documentURL: string,
): Response {
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.tagName = "v-html";
      },
    })
    .on("head", {
      element(element) {
        element.tagName = "v-head";
        element.prepend(
          "<style>v-html,v-body{display:block}v-head{display:none}</style>",
          { html: true },
        );
      },
    })
    .on("body", {
      element(element) {
        element.tagName = "v-body";
      },
    })
    .on("style", new StylesheetText(documentURL))
    .on("script", {
      element(element) {
        if (
          element.getAttribute("type") === inertScriptType &&
          element.hasAttribute("data-v-frame-script")
        ) {
          return;
        }

        const authoredType = element.getAttribute("type");
        element.removeAttribute("data-v-frame-script");
        element.removeAttribute("data-v-frame-type");
        element.setAttribute("type", inertScriptType);
        element.setAttribute("data-v-frame-script", "");
        if (authoredType !== null) {
          element.setAttribute("data-v-frame-type", authoredType);
        }
      },
    })
    .transform(response);
}
