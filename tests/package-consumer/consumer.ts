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
  type MaterializeStylesheetOptions,
} from "@mewhhaha/v-frame/server";

defineVFrame();
const frame = document.createElement("v-frame") as VFrameElement;
frame.addEventListener("v-frame-load", (event: CustomEvent<VFrameLoadEventDetail>) =>
  console.log(event.detail.url),
);
frame.contentWindow?.document.querySelector("input")?.focus();
const options: MaterializeStylesheetOptions = {
  fetchText: async (url) => ({ text: "body { color: red }", url }),
};
materializeVFrameDocument(
  new Response("<html></html>"),
  "https://consumer.test/guest/",
  options,
);
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
