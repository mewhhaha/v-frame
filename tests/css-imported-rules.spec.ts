import { expect, test, type Locator, type Page } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

function mountDocument(page: Page, path: string): Promise<Locator> {
  return mountFrame(page, { src: `${fixture.origin}${path}`, settle: "none" });
}

test("applies imported supports rules and preserves root selector specificity", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/import-and-root.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#root-colour")).toHaveCSS("color", "rgb(8, 9, 10)");
  await expect(frame.locator("#imported-colour")).toHaveCSS("color", "rgb(13, 14, 15)");
});
