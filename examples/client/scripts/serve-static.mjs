import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const [, , rootArg, portArg] = process.argv;
if (!rootArg || !portArg) {
  throw new Error(
    `usage: node serve-static.mjs <directory> <port>, got argv ${JSON.stringify(process.argv.slice(2))}`,
  );
}

const root = resolve(rootArg);
const port = Number(portArg);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`port must be a positive integer, got ${JSON.stringify(portArg)}`);
}
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`serve root ${root} is not a directory`);
}

function resolveFile(pathname) {
  const requested = resolve(root, `.${decodeURIComponent(pathname)}`);
  const pathFromRoot = relative(root, requested);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  )
    return null;
  if (existsSync(requested) && statSync(requested).isFile()) return requested;
  return null;
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  let file;
  try {
    const { pathname } = new URL(req.url ?? "/", `http://localhost:${port}`);
    file = resolveFile(pathname) ?? join(root, "index.html");
  } catch (error) {
    res.statusCode = 400;
    res.end(`invalid request URL: ${error.message}`);
    return;
  }

  res.setHeader(
    "Content-Type",
    CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
  );
  createReadStream(file)
    .on("error", (error) => {
      res.statusCode = 404;
      res.end(`not found: ${error.message}`);
    })
    .pipe(res);
});

server.listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`);
});
