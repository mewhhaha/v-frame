import { expect, test } from "@playwright/test";
import {
  type ContractFixtureServers,
  startContractFixtureServers,
} from "./support/fixture-server";
import { installBundle } from "./support/mount-frame";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("registers one launchpad constructor across the side-effect and API entry points", async ({
  page,
}) => {
  await page.goto(fixture.origin);

  const registration = await page.evaluate(
    async ({ apiURL, registerURL }) => {
      await import(registerURL);
      const registered = customElements.get("v-frame");
      const api = await import(apiURL);
      return {
        // The shipped bundle is minified, so the constructor's own `name` is
        // mangled; its identity and its prototype chain are the contract.
        registeredElement: registered !== undefined,
        extendsHTMLElement: registered?.prototype instanceof HTMLElement,
        exportedConstructor: api.VFrameElement === registered,
        sharedConstructor: api.defineVFrame() === registered,
      };
    },
    {
      apiURL: `${fixture.origin}/dist/index.js`,
      registerURL: `${fixture.origin}/dist/register.js`,
    },
  );

  expect(registration).toEqual({
    registeredElement: true,
    extendsHTMLElement: true,
    exportedConstructor: true,
    sharedConstructor: true,
  });
});

test("keeps a missing source idle and recreates its realm after reconnection", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);

  const state = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      currentURL: string | null;
      status: string;
      src: string;
    };
    document.querySelector("#host")?.append(frame);
    const initially = {
      status: frame.status,
      currentURL: frame.currentURL,
      hasContentWindow: frame.contentWindow !== null,
    };
    const firstLoaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/reconnect.html`;
    await firstLoaded;
    const firstWindow = frame.contentWindow;
    frame.remove();
    const disconnected = {
      status: frame.status,
      currentURL: frame.currentURL,
      hasContentWindow: frame.contentWindow !== null,
      internalStyleSheets: frame.shadowRoot?.adoptedStyleSheets.length,
    };
    const reconnected = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    document.querySelector("#host")?.append(frame);
    await reconnected;
    return {
      initially,
      disconnected,
      status: frame.status,
      currentURL: frame.currentURL,
      recreatedWindow: frame.contentWindow !== firstWindow,
    };
  }, fixture.origin);

  expect(state).toEqual({
    initially: { status: "idle", currentURL: null, hasContentWindow: false },
    disconnected: {
      status: "idle",
      currentURL: null,
      hasContentWindow: false,
      internalStyleSheets: 0,
    },
    status: "ready",
    currentURL: `${fixture.origin}/documents/reconnect.html`,
    recreatedWindow: true,
  });
});

test("settles reload() with the load it starts, and rejects when there is nothing to load or it fails", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);

  const outcomes = await page.evaluate(async (origin) => {
    const settle = async (reload: Promise<void>) => {
      try {
        await reload;
        return "resolved";
      } catch (error) {
        return `rejected: ${(error as Error).message}`;
      }
    };
    const frame = document.createElement("v-frame") as HTMLElement & {
      reload(): Promise<void>;
      src: string;
      status: string;
    };
    // A cross-origin source is refused before the fetch, so the event it fails
    // with is dispatched inside the assignment; listen ahead of it either way.
    const assignFailingSource = async (source: string) => {
      const failure = new Promise<void>((resolve) =>
        frame.addEventListener("v-frame-error", () => resolve(), { once: true }),
      );
      frame.src = source;
      await failure;
    };

    // Nothing to reload: no source, and then a source but no host to load into.
    const disconnectedWithoutSource = await settle(frame.reload());
    document.querySelector("#host")?.append(frame);
    const connectedWithoutSource = await settle(frame.reload());

    await assignFailingSource("mailto:someone@example.com");
    const nonHTTPSource = await settle(frame.reload());

    await assignFailingSource(`${origin}/documents/absent.html`);
    const absentDocument = await settle(frame.reload());
    const statusAfterAbsentDocument = frame.status;

    await assignFailingSource("https://other.invalid/documents/reconnect.html");
    const crossOriginSource = await settle(frame.reload());

    frame.src = `${origin}/documents/reconnect.html`;
    await new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    const liveGuest = await settle(frame.reload());
    frame.remove();
    const disconnectedWithSource = await settle(frame.reload());

    return {
      disconnectedWithoutSource,
      connectedWithoutSource,
      nonHTTPSource,
      absentDocument,
      statusAfterAbsentDocument,
      crossOriginSource,
      liveGuest,
      disconnectedWithSource,
    };
  }, fixture.origin);

  expect(outcomes).toEqual({
    disconnectedWithoutSource:
      "rejected: v-frame cannot reload without a connected frame that has a src",
    connectedWithoutSource:
      "rejected: v-frame cannot reload without a connected frame that has a src",
    nonHTTPSource:
      'rejected: v-frame src "mailto:someone@example.com" must use http: or https:, received mailto:',
    absentDocument: `rejected: v-frame entry ${fixture.origin}/documents/absent.html returned 404 Not Found`,
    statusAfterAbsentDocument: "error",
    crossOriginSource: `rejected: v-frame route https://other.invalid/documents/reconnect.html must share host origin ${fixture.origin}`,
    liveGuest: "resolved",
    disconnectedWithSource:
      "rejected: v-frame cannot reload without a connected frame that has a src",
  });
});

test("exposes each lifecycle value as an exclusive custom element state", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);

  const states = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      src: string;
      status: string;
    };
    const matchingStates = () =>
      ["idle", "loading", "ready", "error"].filter((state) =>
        frame.matches(`:state(${state})`),
      );
    frame.src = "";
    document.querySelector("#host")?.append(frame);
    const idle = matchingStates();

    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.src = `${origin}/documents/slow.html`;
    const loading = matchingStates();
    await loaded;
    const ready = matchingStates();

    const failed = new Promise<void>((resolveFailed) => {
      frame.addEventListener("v-frame-error", () => resolveFailed(), { once: true });
    });
    // A failed replacement keeps its live guest. Clear it to exercise a fatal
    // load failure with no guest available for rollback.
    frame.src = "";
    frame.src = "https://cross-origin.invalid/application";
    await failed;
    return { idle, loading, ready, error: matchingStates(), status: frame.status };
  }, fixture.origin);

  expect(states).toEqual({
    idle: ["idle"],
    loading: ["loading"],
    ready: ["ready"],
    error: ["error"],
    status: "error",
  });
});

test("keeps only the latest rapid source load and exposes redirect final URLs", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);

  const result = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      currentURL: string | null;
      src: string;
    };
    const loadedURLs: string[] = [];
    frame.addEventListener("v-frame-load", (event) => {
      loadedURLs.push((event as CustomEvent<{ url: string }>).detail.url);
    });
    document.querySelector("#host")?.append(frame);
    const fastLoad = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/slow.html`;
    frame.src = `${origin}/documents/fast.html`;
    await fastLoad;
    const redirectLoad = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/redirect.html`;
    await redirectLoad;
    return { currentURL: frame.currentURL, loadedURLs };
  }, fixture.origin);

  expect(result).toEqual({
    currentURL: `${fixture.origin}/documents/redirected.html`,
    loadedURLs: [
      `${fixture.origin}/documents/fast.html`,
      `${fixture.origin}/documents/redirected.html`,
    ],
  });
});

test("preserves an entry fragment in currentURL and the load event", async ({ page }) => {
  await installBundle(page, fixture.origin);

  const result = await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      currentURL: string | null;
      src: string;
    };
    const loaded = new Promise<string>((resolve) => {
      frame.addEventListener(
        "v-frame-load",
        (event) => {
          resolve((event as CustomEvent<{ url: string }>).detail.url);
        },
        { once: true },
      );
    });
    frame.src = source;
    document.querySelector("#host")?.append(frame);
    return { eventURL: await loaded, currentURL: frame.currentURL };
  }, `${fixture.origin}/documents/history.html#blocked-link`);

  expect(result).toEqual({
    eventURL: `${fixture.origin}/documents/history.html#blocked-link`,
    currentURL: `${fixture.origin}/documents/history.html#blocked-link`,
  });
});

test("emits bubbling composed lifecycle details and a fatal entry error", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);

  const events = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame");
    const lifecycle: Array<{
      type: string;
      bubbles: boolean;
      composed: boolean;
      cancelable: boolean;
      url: string;
    }> = [];
    for (const type of ["v-frame-loadstart", "v-frame-load"]) {
      frame.addEventListener(type, (event) => {
        lifecycle.push({
          type,
          bubbles: event.bubbles,
          composed: event.composed,
          cancelable: event.cancelable,
          url: (event as CustomEvent<{ url: string }>).detail.url,
        });
      });
    }
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.setAttribute("src", `${origin}/documents/redirect.html`);
    document.querySelector("#host")?.append(frame);
    await loaded;

    const invalid = document.createElement("v-frame") as HTMLElement & { status: string };
    const failed = new Promise<{
      phase: string;
      fatal: boolean;
      bubbles: boolean;
      composed: boolean;
      cancelable: boolean;
    }>((resolve) => {
      invalid.addEventListener(
        "v-frame-error",
        (event) => {
          const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
          resolve({
            phase: detail.phase,
            fatal: detail.fatal,
            bubbles: event.bubbles,
            composed: event.composed,
            cancelable: event.cancelable,
          });
        },
        { once: true },
      );
    });
    invalid.setAttribute("src", "data:text/html,unsupported");
    document.querySelector("#host")?.append(invalid);
    return { lifecycle, failure: await failed, invalidStatus: invalid.status };
  }, fixture.origin);

  expect(events).toEqual({
    lifecycle: [
      {
        type: "v-frame-loadstart",
        bubbles: true,
        composed: true,
        cancelable: false,
        url: `${fixture.origin}/documents/redirect.html`,
      },
      {
        type: "v-frame-load",
        bubbles: true,
        composed: true,
        cancelable: false,
        url: `${fixture.origin}/documents/redirected.html`,
      },
    ],
    failure: {
      phase: "entry",
      fatal: true,
      bubbles: true,
      composed: true,
      cancelable: false,
    },
    invalidStatus: "error",
  });
});
