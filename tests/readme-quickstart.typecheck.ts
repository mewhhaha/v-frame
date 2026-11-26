// Compiled by tsconfig.test.json, never run: it pins that the README quickstart
// and examples typecheck without any global `HTMLElementTagNameMap` augmentation.
import { VFrameElement } from "../src/index.js";
import { channel } from "../src/channel.js";
import { composeFrames } from "../src/server/index.js";
import {
  activeShadowElement,
  defineMockVFrame,
  resetChannels,
  shadowScreen,
  withinFrame,
} from "../src/testing.js";

export async function watchOrders(): Promise<void> {
  const frame = document.querySelector("#orders");
  if (!(frame instanceof VFrameElement)) {
    throw new Error("host is missing its orders v-frame");
  }

  frame.addEventListener("v-frame-load", (event) => {
    console.log("orders ready:", event.detail.url);
  });

  frame.addEventListener("v-frame-error", (event) => {
    console.error("orders failed:", event.detail.phase, event.detail.error);
  });

  await frame.whenReady();
  await frame.navigate("/applications/orders/42", { replace: true });
  frame.addEventListener("v-frame-navigated", (event) => {
    console.log("guest moved:", event.detail.from, "->", event.detail.to);
  });
}

export async function ssrComposeExample(
  request: Request,
  renderShell: (req: Request) => Promise<Response>,
  routeToTeamService: (guest: Request) => Promise<Response>,
): Promise<Response> {
  const shellResponse = await renderShell(request);
  return composeFrames(shellResponse, {
    request,
    fetchGuest: (guestRequest) => routeToTeamService(guestRequest),
    timeoutMs: 3000,
    onSlotError: ({ src, error }) => {
      console.warn("guest fallback to client load:", src, error);
    },
  });
}

export function channelExample(renderOrderDetails: (id: string) => void): void {
  const selectedOrder = channel<{ id: string }>("orders.selected.v1");
  selectedOrder.publish({ id: "A42" }, { retain: true });
  const controller = new AbortController();
  selectedOrder.subscribe(({ id }) => renderOrderDetails(id), {
    signal: controller.signal,
  });
  const current = selectedOrder.get();
  void current;
  selectedOrder.clear();
}

export async function testingExample(): Promise<void> {
  const mock = defineMockVFrame({ "/applications/orders/": "<h2>Orders</h2>" });
  try {
    const orders = withinFrame(document.querySelector<VFrameElement>("#orders")!);
    const details = withinFrame(document.querySelector<VFrameElement>("#details")!);
    await Promise.all([orders.ready(), details.ready()]);
    shadowScreen.getByRole("heading", { name: "Order Desk", level: 1 });
    orders.getByRole("button", { name: "Order #42" }).click();
    await details.findByRole("heading", { name: "Order #42" });
    void activeShadowElement();
  } finally {
    mock.restore();
    resetChannels();
  }
}
