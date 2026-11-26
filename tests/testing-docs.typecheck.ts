// Compiled by tsconfig.test.json, never run: it pins that the docs/testing.md
// examples typecheck cleanly without any global `HTMLElementTagNameMap` augmentation.
import type { VFrameElement } from "@mewhhaha/v-frame";
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
} from "@mewhhaha/v-frame/testing";

export async function verifyComposedFlow(): Promise<void> {
  const ordersFrame = document.querySelector<VFrameElement>("#orders");
  const detailsFrame = document.querySelector<VFrameElement>("#details");
  if (!ordersFrame || !detailsFrame) return;

  const orders = withinFrame(ordersFrame);
  const details = withinFrame(detailsFrame);
  await Promise.all([orders.ready(), details.ready()]);

  shadowScreen.getByRole("heading", { name: "Shell Workspace", level: 1 });
  orders.getByRole("button", { name: "Save" }).click();
  await details.findByText("Selected #42");

  const custom = withinShadow(document.body, { testIdAttribute: "data-test" });
  custom.queryByTestId("orders-row");
  queryShadow<HTMLButtonElement>(ordersFrame, "button");
  queryAllShadow(document, "v-frame");
  activeShadowElement();
  await waitFor(() => prettyShadowDOM(ordersFrame));
  resetChannels();
  resetChannels({ disconnectSubscribers: true });
}

export async function verifyMockShell(): Promise<void> {
  const mock = defineMockVFrame({
    "/applications/orders/": `<h2>Orders</h2><button type="button">Create order</button>`,
    "/applications/orders/42": () => ({ html: `<h2>Order #42</h2>` }),
  });
  try {
    const frame = document.createElement("v-frame") as VFrameElement;
    frame.src = "/applications/orders/";
    document.body.append(frame);
    const orders = withinFrame(frame);
    await orders.ready();
    orders.getByRole("heading", { name: "Orders" });
    await frame.navigate("/applications/orders/42");
    void mock.requests;
  } finally {
    mock.restore();
    resetChannels({ disconnectSubscribers: true });
  }
}
