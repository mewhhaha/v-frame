import { channel, type FragmentChannel } from "@mewhhaha/v-frame/channel";
import {
  defineVFrame,
  VFrameElement,
  type VFrameLoadEventDetail,
} from "@mewhhaha/v-frame";
import "@mewhhaha/v-frame/register";
import {
  composeFrames,
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
import {
  activeShadowElement,
  defineMockVFrame,
  prettyShadowDOM,
  queryAllShadow,
  queryShadow,
  resetChannels,
  shadowScreen,
  waitFor,
  withinFrame,
  withinShadow,
  type FrameQueries,
  type MockVFrameController,
  type ShadowQueries,
} from "@mewhhaha/v-frame/testing";

const order: FragmentChannel<{ id: string }> = channel("orders.selection.v1");
const unsubscribe = order.subscribe(({ id }) => id.toUpperCase());
order.publish({ id: "42" }, { retain: true });
unsubscribe();

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

const composed: Response = await composeFrames(new Response(null, { status: 204 }), {
  request: new Request("https://consumer.test/"),
  fetchGuest: async (guest) => new Response(guest.url),
});
void composed;

const scopedFrame: FrameQueries = withinFrame(frame);
const scopedShadow: ShadowQueries = withinShadow(document.body);
const mockController: MockVFrameController = defineMockVFrame({
  "/mock": "<button>Mock</button>",
});
mockController.setRoutes({ "/mock": "<p>Updated</p>" });
mockController.clearRequests();
mockController.restore();
void scopedFrame.ready;
void scopedShadow.getByRole;
void shadowScreen.findByText;
void queryShadow(document, "v-frame");
void queryAllShadow(document, "button");
void activeShadowElement();
void prettyShadowDOM(document.body);
void waitFor(() => true);
resetChannels();
