import assert from "node:assert/strict";
import { test } from "node:test";
import { installNetworkPatches } from "../../src/network.js";
import type { VFrameWindow } from "../../src/types.js";

// Keep finished connections reachable, so a weak map alone cannot satisfy the
// test: completion must unregister them instead of disposing them a second time.
function networkHarness() {
  class Upload extends EventTarget {}
  class XHR extends EventTarget {
    upload = new Upload();
    withCredentials = false;
    open() {}
    send() {}
    abort() {}
  }
  class Socket extends EventTarget {
    closes = 0;
    close() {
      this.closes++;
    }
  }
  class Stream extends Socket {
    static readonly CLOSED = 2;
    readyState = 0;
  }
  class Worker {
    terminations = 0;
    terminate() {
      this.terminations++;
    }
  }
  class SharedWorker {
    port = new Socket();
  }
  const window = {
    URL,
    Request,
    fetch,
    AbortController,
    AbortSignal,
    DOMException,
    TypeError,
    XMLHttpRequest: XHR,
    XMLHttpRequestUpload: Upload,
    WebSocket: Socket,
    EventSource: Stream,
    Worker,
    SharedWorker,
    navigator: {},
  } as unknown as VFrameWindow;
  const controller = new AbortController();
  const dispose = installNetworkPatches({
    window,
    signal: controller.signal,
    credentials: "same-origin",
    getBaseURL: () => "https://host.test/guest/",
  });
  return { window, controller, dispose };
}

test("finished sockets, streams and workers leave teardown tracking", () => {
  const { window, controller, dispose } = networkHarness();
  const socket = new window.WebSocket("socket") as unknown as {
    close(): void;
    closes: number;
  };
  const stream = new window.EventSource("events") as unknown as {
    close(): void;
    closes: number;
  };
  const worker = new window.Worker("worker.js") as unknown as {
    terminate(): void;
    terminations: number;
  };
  const shared = new window.SharedWorker("shared.js") as unknown as {
    port: { close(): void; closes: number };
  };
  const active = new window.Worker("active.js") as unknown as { terminations: number };
  socket.close();
  stream.close();
  worker.terminate();
  shared.port.close();
  controller.abort();
  dispose();
  assert.deepEqual(
    [
      socket.closes,
      stream.closes,
      worker.terminations,
      shared.port.closes,
      active.terminations,
    ],
    [1, 1, 1, 1, 1],
  );
});

test("remote socket close and terminal stream errors unregister, reconnecting streams do not", () => {
  const { window, dispose } = networkHarness();
  const socket = new window.WebSocket("socket") as unknown as EventTarget & {
    closes: number;
  };
  const terminal = new window.EventSource("closed") as unknown as EventTarget & {
    readyState: number;
    closes: number;
  };
  const retrying = new window.EventSource("retrying") as unknown as EventTarget & {
    closes: number;
  };
  socket.dispatchEvent(new Event("close"));
  terminal.readyState = 2;
  terminal.dispatchEvent(new Event("error"));
  retrying.dispatchEvent(new Event("error"));
  dispose();
  assert.deepEqual([socket.closes, terminal.closes, retrying.closes], [0, 0, 1]);
});
