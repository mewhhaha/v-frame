# Server-composed SSR widgets

This example composes independently deployed SSR applications into `<v-frame>`
widgets before the page is delivered. A React Router Worker and a Qwik Worker
render their own markup. The public host requests both through Cloudflare
service bindings and streams each response into a declarative shadow root.

```text
                          ┌─ React Router SSR Worker ─┐
browser ← host HTML ← host Worker                     ├─ service bindings
                          └─ Qwik SSR Worker ─────────┘
```

The delivered HTML already contains both widget bodies:

```html
<v-frame adopt src="/widgets/react-router">
  <template shadowrootmode="open">
    <v-html>
      <v-head>…prepared widget styles…</v-head>
      <v-body>…React Router SSR output…</v-body>
    </v-html>
  </template>
</v-frame>
```

Declarative Shadow DOM makes that content visible while the document is still
being parsed. When the `v-frame` client module arrives, `adopt` uses `src` as the
widget's virtual URL but does not fetch it. It builds the isolated execution
realm from the server content and activates any inert scripts. A scoped View
Transition covers the preview-to-live handoff when the browser supports it, so
the two widgets can activate concurrently without transitioning the host page.
A later `reload()` or `src` change uses the ordinary network path.

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

The framework Workers in this example expose `/preview` for server composition
and `/document` for later network reloads. In a larger application, the same
split can be produced by a React Router resource route, a Qwik City endpoint,
or a small adapter beside an existing SSR entry point.

## Run locally

From the repository root:

```sh
pnpm install
pnpm --filter example-workers-composition run dev
```

Open http://localhost:43500. The host runs on port 43500, the React Router
widget on 43501, and the Qwik widget on 43502. Their inspector ports are
43600–43602.

## Validate and deploy

```sh
pnpm --filter example-workers-composition run check
pnpm --filter example-workers-composition run deploy
```

`check` regenerates binding types, type-checks all three Workers, and performs a
dry-run deployment for each configuration. `deploy` publishes the two widget
Workers first and then the public host.
