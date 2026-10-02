import { expect, test, type Locator, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import { bundleRoute, startHTTPFixture, type HTTPFixture } from "./support/http-fixture";
import { interactionLab } from "./support/interaction-lab";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";
import { auditAccessibility } from "./support/accessibility";

let fixture: HTTPFixture;
let frame: Locator;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": '<!doctype html><html lang="en"><head><title>Host</title></head><body><main><button id="before">Before guest</button><div id="host"></div><button id="after">After guest</button></main></body></html>',
      "/dist/index.js": bundleRoute,
      "/lab": interactionLab,
    },
  });
});
test.afterAll(async () => fixture.close());
test.beforeEach(async ({ page }) => {
  await installBundle(page, fixture.origin);
  frame = await mountFrame(page, { src: `${fixture.origin}/lab`, id: "interactive" });
  await frame.evaluate((element) => {
    element.style.cssText = "width:640px;height:620px;margin:24px;overflow:auto";
  });
});
test.afterEach(async () => {
  if (await frame.count()) expect(await frameFailures(frame)).toEqual([]);
});

async function audit(page: Page): Promise<void> {
  const results = await auditAccessibility(page);
  expect(
    results.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test("passes WCAG audits across the shadow boundary", async ({ page }) => {
  await audit(page);
});

test("the accessibility scanner detects unnamed controls inside a guest", async ({
  page,
}) => {
  await frame.evaluate((element) => {
    const document = (element as VFrameElement).contentWindow!.document;
    const input = document.createElement("input");
    input.id = "guest-audit-canary";
    document.body.append(input);
  });
  const results = await auditAccessibility(page);
  const missingLabel = results.violations.find(({ id }) => id === "label");
  expect(missingLabel?.nodes.map(({ target }) => JSON.stringify(target))).toEqual(
    expect.arrayContaining([expect.stringContaining("guest-audit-canary")]),
  );
});

test("preserves explicit and implicit labels, descriptions and dynamic names", async () => {
  const email = frame.getByRole("textbox", { name: "Email address" });
  await expect(email).toHaveAccessibleDescription("Used for delivery updates.");
  await expect(frame.getByRole("switch", { name: "Delivery updates" })).not.toBeChecked();
  await expect(frame.getByRole("group", { name: "Delivery speed" })).toBeVisible();
  await expect(frame.getByRole("combobox", { name: "Region" })).toBeVisible();
  await frame.locator('label[for="email"]').evaluate((label) => {
    label.textContent = "Contact email";
  });
  await expect(email).toHaveCount(0);
  await expect(
    frame.getByRole("textbox", { name: "Contact email" }),
  ).toHaveAccessibleDescription("Used for delivery updates.");
});

test("label clicks focus the physical control and relay guest focus events", async () => {
  await frame.locator('label[for="email"]').click();
  await expect(frame.getByRole("textbox", { name: "Email address" })).toBeFocused();
  const focused = await frame.evaluate((element) => {
    const view = (element as VFrameElement).contentWindow!;
    return {
      id: view.document.activeElement?.id,
      focused: view.document.hasFocus(),
      events: (view as Window & { interactions: unknown[] }).interactions,
    };
  });
  expect(focused.id).toBe("email");
  expect(focused.focused).toBe(true);
  expect(focused.events).toContainEqual({ type: "focusin", target: "email" });
});

test("Tab enters and exits the guest without visiting hidden or inert controls", async ({
  page,
  browserName,
}) => {
  await page.getByRole("button", { name: "Before guest" }).focus();
  await page.keyboard.press("Tab");
  // Firefox includes scrollable containers themselves in sequential focus order.
  if (browserName === "firefox") {
    await expect(frame).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(frame.getByRole("textbox", { name: "Email address" })).toBeFocused();
  const names = [
    "Save settings",
    "Delivery updates",
    "Standard",
    "Region",
    "Delivery details",
    "Pinned details",
    "Edit delivery",
    "Advanced settings",
    "Last guest action",
  ];
  for (const name of names) {
    await page.keyboard.press("Tab");
    if (name === "Advanced settings") {
      await expect(frame.locator("summary")).toBeFocused();
      continue;
    }
    await expect(
      frame.getByRole(
        name === "Region"
          ? "combobox"
          : name === "Delivery updates"
            ? "switch"
            : name === "Standard"
              ? "radio"
              : "button",
        { name, exact: true },
      ),
    ).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "After guest" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(frame.getByRole("button", { name: "Last guest action" })).toBeFocused();
  await expect(frame.locator("iframe")).toHaveAttribute("aria-hidden", "true");
  await expect(frame.locator("iframe")).toHaveAttribute("tabindex", "-1");
});

test("Space and arrow keys retain native switch, radio and select behavior", async ({
  page,
}) => {
  const updates = frame.getByRole("switch", { name: "Delivery updates" });
  await updates.focus();
  await page.keyboard.press("Space");
  await expect(updates).toBeChecked();
  await frame.getByRole("radio", { name: "Standard", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(frame.getByRole("radio", { name: "Express", exact: true })).toBeChecked();
  await frame
    .getByRole("combobox", { name: "Region" })
    .selectOption({ label: "Americas" });
  await expect(frame.getByRole("combobox", { name: "Region" })).toHaveValue("Americas");
});

test("keyboard submission validates the native form and preserves live status updates", async () => {
  const email = frame.getByRole("textbox", { name: "Email address" });
  await email.fill("invalid");
  await email.press("Enter");
  await expect(frame.getByRole("status")).toHaveText("");
  await expect(email).toBeFocused();
  await email.fill("relay@example.com");
  await email.press("Enter");
  await expect(frame.getByRole("status")).toHaveText("Saved relay@example.com");
});

for (const key of ["Enter", "Space"]) {
  test(`native popover opens with ${key}, exposes names, and restores focus on Escape`, async ({
    page,
  }) => {
    const trigger = frame.getByRole("button", { name: "Delivery details", exact: true });
    await trigger.focus();
    await page.keyboard.press(key);
    const dialog = frame.getByRole("dialog", { name: "Delivery details", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription("Change delivery instructions.");
    await expect(frame.getByRole("textbox", { name: "Instructions" })).toBeFocused();
    await audit(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("popover close actions work without guest click handlers", async () => {
  await frame.getByRole("button", { name: "Delivery details", exact: true }).click();
  await frame.getByRole("button", { name: "Close details", exact: true }).click();
  await expect(
    frame.getByRole("dialog", { name: "Delivery details", exact: true }),
  ).toBeHidden();
});

for (const destination of ["host", "guest"]) {
  test(`auto popovers light-dismiss on an outside ${destination} pointer`, async ({
    page,
  }) => {
    await frame.getByRole("button", { name: "Delivery details", exact: true }).click();
    await (
      destination === "host"
        ? page.getByRole("button", { name: "Before guest" })
        : frame.getByRole("textbox", { name: "Email address" })
    ).click();
    await expect(
      frame.getByRole("dialog", { name: "Delivery details", exact: true }),
    ).toBeHidden();
  });
}

test("nested auto popovers close the inner surface first", async ({ page }) => {
  await frame.getByRole("button", { name: "Delivery details", exact: true }).click();
  await frame.getByRole("button", { name: "More details" }).click();
  await expect(
    frame.getByRole("dialog", { name: "Extra delivery details" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    frame.getByRole("dialog", { name: "Extra delivery details" }),
  ).toBeHidden();
  await expect(
    frame.getByRole("dialog", { name: "Delivery details", exact: true }),
  ).toBeVisible();
  await expect(frame.getByRole("button", { name: "More details" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    frame.getByRole("dialog", { name: "Delivery details", exact: true }),
  ).toBeHidden();
});

test("manual popovers remain open until their explicit close action", async ({
  page,
}) => {
  const trigger = frame.getByRole("button", { name: "Pinned details", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Before guest" }).click();
  await expect(
    frame.getByRole("dialog", { name: "Pinned delivery details" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Close pinned details" }).click();
  await expect(
    frame.getByRole("dialog", { name: "Pinned delivery details" }),
  ).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("canceling beforetoggle prevents a native popover opening", async () => {
  await frame.locator("#info").evaluate((element) =>
    element.addEventListener("beforetoggle", (event) => event.preventDefault(), {
      once: true,
    }),
  );
  await frame.getByRole("button", { name: "Delivery details", exact: true }).click();
  await expect(frame.locator("#info")).toBeHidden();
});

test("native modal autofocus and focus containment cross the shadow boundary", async ({
  page,
}) => {
  await frame.getByRole("button", { name: "Edit delivery", exact: true }).click();
  await expect(
    frame.getByRole("dialog", { name: "Edit delivery" }),
  ).toHaveAccessibleDescription("Confirm the delivery name.");
  const name = frame.getByRole("textbox", { name: "Delivery name" });
  await expect(name).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.getByRole("button", { name: "Cancel edit" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(frame.getByRole("button", { name: "Confirm edit" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(frame.getByRole("button", { name: "Cancel edit" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(name).toBeFocused();
  // Boundary traversal may focus the dialog or browser chrome, but never the inert host.
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Before guest", includeHidden: true }),
  ).not.toBeFocused();
  await expect(frame.locator("#email")).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await audit(page);
});

test("modal Escape closes and returns focus to its invoker", async ({ page }) => {
  const trigger = frame.getByRole("button", { name: "Edit delivery", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(frame.getByRole("dialog", { name: "Edit delivery" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a guest cancel listener can keep the modal open", async ({ page }) => {
  await frame.locator("#modal").evaluate((element) =>
    element.addEventListener("cancel", (event) => event.preventDefault(), {
      once: true,
    }),
  );
  await frame.getByRole("button", { name: "Edit delivery", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(frame.getByRole("dialog", { name: "Edit delivery" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(frame.getByRole("dialog", { name: "Edit delivery" })).toBeHidden();
});

test("dialog form submission closes with the correct return value", async () => {
  await frame.getByRole("button", { name: "Edit delivery", exact: true }).click();
  await frame.getByRole("button", { name: "Confirm edit" }).click();
  await expect(frame.locator("#modal")).toBeHidden();
  expect(
    await frame
      .locator("#modal")
      .evaluate((element) => (element as HTMLDialogElement).returnValue),
  ).toBe("confirm");
});

test("removing a modal frame restores the host interaction surface", async ({ page }) => {
  await frame.getByRole("button", { name: "Edit delivery", exact: true }).click();
  await frame.evaluate((element) => element.remove());
  await page.getByRole("button", { name: "After guest" }).click();
  await expect(page.getByRole("button", { name: "After guest" })).toBeFocused();
});

test("outside notifications cannot cancel the host pointer and click actions", async ({
  page,
}) => {
  await frame.evaluate((element) => {
    const view = (element as VFrameElement).contentWindow! as Window &
      typeof globalThis & { outsideTargetIsBody?: boolean; outsideTrusted?: boolean };
    view.document.addEventListener("pointerdown", (event) => {
      view.outsideTargetIsBody = event.target === view.document.body;
      view.outsideTrusted = event.isTrusted;
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  });
  await page
    .locator("#before")
    .evaluate((button) =>
      button.addEventListener("click", () => button.setAttribute("data-clicked", "true")),
    );
  await page.locator("#before").click();
  await expect(page.locator("#before")).toBeFocused();
  await expect(page.locator("#before")).toHaveAttribute("data-clicked", "true");
  expect(
    await frame.evaluate((element) => {
      const view = (element as VFrameElement).contentWindow! as Window & {
        outsideTargetIsBody?: boolean;
        outsideTrusted?: boolean;
      };
      return { targetIsBody: view.outsideTargetIsBody, trusted: view.outsideTrusted };
    }),
  ).toEqual({ targetIsBody: true, trusted: false });
});

test("outside notifications stay inside the physical shadow boundary", async ({
  page,
}) => {
  await page.evaluate(() => {
    const host = window as Window & typeof globalThis & { hostPointerTargets: string[] };
    host.hostPointerTargets = [];
    document.addEventListener(
      "pointerdown",
      (event) => host.hostPointerTargets.push((event.target as Element).id),
      true,
    );
  });
  await frame.evaluate((element) => {
    const view = (element as VFrameElement).contentWindow! as Window &
      typeof globalThis & { outsideCount: number };
    view.outsideCount = 0;
    view.document.addEventListener("pointerdown", () => view.outsideCount++);
  });
  await page.locator("#before").click();
  expect(
    await frame.evaluate(
      (element) =>
        ((element as VFrameElement).contentWindow as Window & { outsideCount: number })
          .outsideCount,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as Window & typeof globalThis & { hostPointerTargets: string[] })
          .hostPointerTargets,
    ),
  ).toEqual(["before"]);
});

test("sibling interactions notify the other guest without exposing foreign nodes", async ({
  page,
}) => {
  const sibling = await mountFrame(page, { src: `${fixture.origin}/lab`, id: "sibling" });
  await frame.evaluate((element) => {
    const view = (element as VFrameElement).contentWindow! as Window &
      typeof globalThis & { outsideTargets: boolean[] };
    view.outsideTargets = [];
    view.document.addEventListener("pointerdown", (event) =>
      view.outsideTargets.push(event.target === view.document.body),
    );
  });
  await sibling.getByRole("textbox", { name: "Email address" }).click();
  expect(
    await frame.evaluate(
      (element) =>
        (
          (element as VFrameElement).contentWindow as Window & {
            outsideTargets: boolean[];
          }
        ).outsideTargets,
    ),
  ).toEqual([true]);
  await expect(sibling.getByRole("textbox", { name: "Email address" })).toBeFocused();
});

test("retained, removed realms no longer receive outside interactions", async ({
  page,
}) => {
  await frame.evaluate((element) => {
    const view = (element as VFrameElement).contentWindow! as Window &
      typeof globalThis & { outsideCount: number };
    view.outsideCount = 0;
    view.document.addEventListener("pointerdown", () => view.outsideCount++);
    (window as Window & typeof globalThis & { retiredView: typeof view }).retiredView =
      view;
  });
  await page.locator("#before").click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & typeof globalThis & { retiredView: { outsideCount: number } })
          .retiredView.outsideCount,
    ),
  ).toBe(1);
  await frame.evaluate((element) => element.remove());
  await page.locator("#after").click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & typeof globalThis & { retiredView: { outsideCount: number } })
          .retiredView.outsideCount,
    ),
  ).toBe(1);
});
