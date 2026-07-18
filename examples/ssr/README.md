# Server-composed SSR widgets

This example uses a server-rendered host sidebar to compose independently
deployed SSR applications into `<v-frame>` page and widget surfaces before the
page is delivered. The dark Relay shell exposes three recent threads, Plugins,
and Usage through host-owned SPA navigation. React Router owns the transcript
and plugins routes. Each transcript includes a nested Qwik Wikipedia preview
shown from an annotated term on hover or keyboard focus. A sibling Qwik
composer or usage frontend and a Qwik account menu remain independent surfaces.

The workspace reads as one product by default. **Show composition** reveals
the host, React Router, and Qwik ownership boundaries and keeps that view active
while moving between the server-rendered host pages.

The Wikipedia preview uses a manual native popover. Its nested Qwik
`<v-frame>` is promoted into the browser's top layer, so the preview can
cross the outer React frame's clipping boundary without moving overlay
ownership into the host.

The React Router application uses its
normal `StaticRouter`/`hydrateRoot` lifecycle, and the Qwik application uses its
normal optimizer-generated snapshot, Qwikloader, and resumable QRLs. The public
host requests both Workers through Cloudflare service bindings and streams each
response into a declarative shadow root. The React Router Worker requests a
second Qwik preview through its own service binding and nests it one level
deeper.

The hydrated React surface uses the headless `@comp0/react` button primitive;
the host and Qwik surfaces remain framework-native.

```text
                          ┌─ React Router SSR Worker ── Qwik SSR Worker
browser ← host HTML ← host Worker
                          └─ Qwik SSR Worker
```

The delivered HTML already contains all three widget bodies:

```html
<v-frame adopt src="/widgets/react-router/activity">
  <template shadowrootmode="open">
    <v-html>
      <v-head>…prepared widget styles…</v-head>
      <v-body>…React Router SSR output…</v-body>
    </v-html>
  </template>
</v-frame>
```

It also contains the minified `v-frame` runtime, so neither widget preview nor
the web component requires a follow-up request before activation. Serializable
declarative shadow roots preserve the nested Qwik preview while the outer React
Router widget is adopted into its live tree.

Declarative Shadow DOM makes that content visible while the document is still
being parsed. The host response also contains a self-registering `v-frame`
runtime immediately after the composed markup, so activation does not wait for
an external component-module request. `adopt` uses `src` as the widget's virtual
URL but does not fetch it. It keeps the server preview visible while a laid-out,
non-interactive live tree starts in the isolated realm. React hydrates that tree
and Qwik installs its loader before `v-frame` reveals it with a single
synchronous swap. The staged tree matches the preview, so the reveal does not
repaint and the widgets can activate concurrently. A later `reload()` or `src`
change uses the ordinary network path.

## Why the preview is materialized

An adopted response is not an arbitrary full HTML document. It is the
materialized shadow representation that `v-frame` normally creates in the
browser:

- `html`, `head`, and `body` are represented by `v-html`, `v-head`, and
  `v-body`.
- CSS is already scoped for those shell elements.
- Asset URLs should be absolute, or resolvable against `src` during activation.
- Client scripts are inert during HTML parsing. Mark them with
  `type="application/vnd.v-frame" data-v-frame-script`; if the authored script
  was a module, also set `data-v-frame-type="module"`. `v-frame` restores the
  authored type only inside its private execution realm.

The framework Workers expose `/preview` for server composition and `/document`
for mounted network reloads. Their ordinary standalone routes remain available
at `/activity`, `/research`, `/brief`, and `/plugins` for React Router and at
`/inventory` and `/catalog`
for Qwik. In a larger application, the preview form can be produced by a
resource route, a Qwik City endpoint, or a small adapter beside an existing SSR
entry point.

## Routing communication

`BroadcastChannel` is origin/storage-partition scoped, not browser-tab scoped.
The host therefore creates a fresh random ID for each top-level document,
stores it in `sessionStorage` under `v-frame:routing-session`, and names the
channel `v-frame:routing:v1:<session-id>`. The child applications only join an
existing ID, so they remain ordinary standalone applications when opened
directly. A fresh ID also avoids inheriting a copied `sessionStorage` value from
an opener tab.

Messages use a small versioned protocol. A top-level child sends
`navigate-request`; the host validates the frame and route, updates its own URL,
and responds with a targeted `route-change`. A `hello` handshake gives a newly
activated frame the current host route, including after browser history
traversal. The nested Qwik widget intentionally has no host routing identity, so
its Wikipedia preview cannot change the sibling Qwik widget's route. The ID
prevents unrelated tabs from receiving one
another's messages, but it is coordination rather than an authorization
boundary. If the session or channel APIs are unavailable, host links fall back
to ordinary document navigation.

## Run locally

From the repository root:

```sh
pnpm install
pnpm --filter example-ssr run dev
```

Open http://localhost:43500. The host runs on port 43500. The same applications
run standalone at http://localhost:43501/activity and
http://localhost:43502/inventory. Their inspector ports are 43600–43602.

The development command first builds the inline `v-frame` runtime, the
browser-side React bundle, and Qwik's client and server optimizer outputs, then
starts all three Workers.

## Validate and deploy

```sh
pnpm --filter example-ssr run check
pnpm --filter example-ssr run deploy
```

`check` regenerates binding types, type-checks all three Workers, and performs a
dry-run deployment for each configuration. `deploy` publishes the two widget
Workers first and then the public host.
