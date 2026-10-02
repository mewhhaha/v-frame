import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium, firefox, webkit } from "@playwright/test";

const consumer = await mkdtemp(join(tmpdir(), "v-frame-package-smoke-"));
let server;
try {
  await cp(resolve("tests/package-consumer"), consumer, { recursive: true });
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--cache",
        join(consumer, "cache"),
        "--pack-destination",
        consumer,
      ],
      { encoding: "utf8", maxBuffer: 4_000_000 },
    ),
  );
  const artifact = join(consumer, packed[0].filename);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      consumer,
      "--cache",
      join(consumer, "cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    { stdio: "inherit" },
  );
  execFileSync(process.execPath, ["ssr.mjs"], { cwd: consumer, stdio: "inherit" });
  execFileSync(
    resolve("node_modules/.bin/tsc"),
    ["-p", join(consumer, "tsconfig.json")],
    { cwd: consumer, stdio: "inherit" },
  );
  const dist = join(consumer, "node_modules/@mewhhaha/v-frame/dist");
  const index = await readFile(join(dist, "index.js"));
  const register = await readFile(join(dist, "register.js"));
  server = createServer((request, response) => {
    if (request.url === "/index.js" || request.url === "/register.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(request.url === "/index.js" ? index : register);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      request.url === "/guest"
        ? `<!doctype html><html lang="en"><head><style>body{margin:0;color:rgb(18,52,86)}</style></head><body><label>Name<input id="name" value="server"></label><button id="button">Count</button><output id="count">0</output><script>document.querySelector('#button').onclick=()=>document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)</script></body></html>`
        : `<!doctype html><html><body><v-frame src="/guest" aria-label="Package guest" style="display:block;width:320px;height:240px"></v-frame><script type="module" src="/register.js"></script></body></html>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch(
      name === "webkit" && process.env.VFRAME_WEBKIT_EXECUTABLE_PATH
        ? { executablePath: process.env.VFRAME_WEBKIT_EXECUTABLE_PATH }
        : {},
    );
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(
        () => document.querySelector("v-frame")?.status === "ready",
      );
      await page.locator("v-frame #name").fill("installed artifact");
      await page.locator("v-frame #button").click();
      if ((await page.locator("v-frame #count").textContent()) !== "1")
        throw new Error(`${name}: installed guest events failed`);
      const color = await page
        .locator("v-frame v-body")
        .evaluate((element) => getComputedStyle(element).color);
      if (color !== "rgb(18, 52, 86)" || errors.length)
        throw new Error(`${name}: installed guest CSS/runtime failed: ${errors}`);
      console.log(
        `${name}: installed artifact boots, renders CSS and handles interactions`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  if (server)
    await new Promise((resolveClose) => {
      server.closeAllConnections();
      server.close(resolveClose);
    });
  await rm(consumer, { recursive: true, force: true });
}
