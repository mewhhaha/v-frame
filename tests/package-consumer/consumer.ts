import {
  defineVFrame,
  VFrameElement,
  type VFrameLoadEventDetail,
} from "@mewhhaha/v-frame";
import "@mewhhaha/v-frame/register";
import {
  materializeVFrameDocument,
  materializeStylesheet,
  rewriteAssetAttributes,
  createStylesheetContext,
  rewriteStylesheet,
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
  SSR_LINK_SOURCE,
  SSR_LINK_STYLE,
  SSR_STYLE,
  type StylesheetContext,
  type StylesheetFetchOptions,
  type HTMLRewriterConstructor,
  type MaterializeStylesheetOptions,
} from "@mewhhaha/v-frame/server";

defineVFrame();
const signal: AbortSignal = new AbortController().signal;
const context: StylesheetContext = createStylesheetContext(
  async (url: string, options?: StylesheetFetchOptions) => {
    const response = await fetch(url, { signal: options?.signal });
    return { text: await response.text(), url: response.url };
  },
  (failure) => console.error(failure.url, failure.error),
  signal,
);
const contextSignal: AbortSignal | undefined = context.signal;
void contextSignal;
await rewriteStylesheet("body{color:red}", "https://consumer.test/guest/", context);
const wireConstants: readonly string[] = [
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
  SSR_LINK_SOURCE,
  SSR_LINK_STYLE,
  SSR_STYLE,
];
void wireConstants;
const frame = document.createElement("v-frame") as VFrameElement;
frame.addEventListener("v-frame-load", (event: CustomEvent<VFrameLoadEventDetail>) =>
  console.log(event.detail.url),
);
frame.contentWindow?.document.querySelector("input")?.focus();
const options: MaterializeStylesheetOptions = {
  fetchText: async (url) => ({ text: "body { color: red }", url }),
};
const materialized: Response = await materializeVFrameDocument(
  new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  "https://consumer.test/guest/",
  { ...options, HTMLRewriter: class {} as unknown as HTMLRewriterConstructor },
);
void materialized;
materializeStylesheet("body {color: red}", "https://consumer.test/guest/", options);
rewriteAssetAttributes(
  {
    tagName: "img",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    attributes: [["src", "asset.png"]],
    getAttribute: () => null,
    hasAttribute: () => false,
  },
  "https://consumer.test/guest/",
);
