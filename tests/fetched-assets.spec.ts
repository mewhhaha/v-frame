import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

const guestPath = "/mounted/gallery/index.html";
const assetPath = "/mounted/collections/summer/";
const svg = {
  type: "image/svg+xml",
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>',
};
let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<main id="host"></main>'),
      "/dist/index.js": bundleRoute,
      [guestPath]: htmlDocument(
        `<img id="cover" src="photos/cover.svg?color=blue&amp;size=small">
        <img id="responsive" src="photos/fallback.svg" srcset="photos/detail.svg 1x">
        <picture>
          <source srcset="photos/picture.svg 1x">
          <img id="picture" src="photos/fallback.svg">
        </picture>
        <template id="preview"><img id="cloned" src="photos/template.svg"></template>`,
        '<base href="../collections/summer/">',
      ),
      [assetPath + "photos/cover.svg"]: svg,
      [assetPath + "photos/detail.svg"]: svg,
      [assetPath + "photos/fallback.svg"]: svg,
      [assetPath + "photos/picture.svg"]: svg,
      [assetPath + "photos/template.svg"]: svg,
    },
  });
});
test.afterAll(() => fixture.close());

test("relative images load from the guest base on first load and reload", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + guestPath });
  const assertImages = async () => {
    const urls = await frame.evaluate(async (element: VFrameElement) => {
      const guest = element.contentWindow!.document;
      const cover = guest.querySelector<HTMLImageElement>("#cover")!;
      const responsive = guest.querySelector<HTMLImageElement>("#responsive")!;
      const picture = guest.querySelector<HTMLImageElement>("#picture")!;
      await Promise.all([cover.decode(), responsive.decode(), picture.decode()]);
      return {
        authoredSrc: cover.getAttribute("src"),
        authoredSrcset: responsive.getAttribute("srcset"),
        selected: [cover.currentSrc, responsive.currentSrc, picture.currentSrc],
      };
    });
    expect(urls).toEqual({
      authoredSrc: "photos/cover.svg?color=blue&size=small",
      authoredSrcset: "photos/detail.svg 1x",
      selected: [
        fixture.origin + assetPath + "photos/cover.svg?color=blue&size=small",
        fixture.origin + assetPath + "photos/detail.svg",
        fixture.origin + assetPath + "photos/picture.svg",
      ],
    });
  };
  await assertImages();
  await frame.evaluate((element: VFrameElement) => element.reload());
  await assertImages();

  const requests = () => fixture.requests.filter((path) => path.endsWith(".svg"));
  expect(requests().filter((path) => !path.startsWith(assetPath))).toEqual([]);
  expect(requests()).not.toContain(assetPath + "photos/template.svg");
  await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!.document;
    const preview = guest.querySelector<HTMLTemplateElement>("#preview")!;
    guest.body.append(preview.content.cloneNode(true));
  });
  await expect
    .poll(() =>
      frame.locator("#cloned").evaluate((image: HTMLImageElement) => ({
        currentSrc: image.currentSrc,
        naturalWidth: image.naturalWidth,
      })),
    )
    .toEqual({
      currentSrc: fixture.origin + assetPath + "photos/template.svg",
      naturalWidth: 32,
    });
  expect(requests().filter((path) => !path.startsWith(assetPath))).toEqual([]);
});
