# SSR with independent framework applications

This example shows a host composing four independently built guest documents
into server-rendered `v-frame` elements:

- React Router renders and hydrates with its framework-mode SSR build;
- Qwik renders and resumes with the Qwik Vite optimizer;
- Angular renders and hydrates with the Angular application builder; and
- Solid renders and hydrates with SolidStart.

The guests are ordinary applications. Each owns its routes, HTML document,
browser entry, framework dependencies, Worker, and asset paths. None imports a
host API or emits `v-frame` markup. The host is the only application that knows
about composition.

## Run it

From the repository root:

Use Node.js 24.15 or newer in the 24.x line, or Node.js 26, as required by the
Angular toolchain. Older Node.js 24 releases cannot build this example.

```sh
pnpm install
pnpm --filter example-ssr dev
```

Open http://localhost:43500. The command builds `v-frame` and all five
applications, then runs the host with the four guests as local auxiliary
Workers.

The host exposes standalone guest documents at these same-origin paths:

```text
/widgets/react-router/activity
/widgets/qwik/inventory
/widgets/angular/dashboard
/widgets/solid/signals
```

Direct visits return complete documents. Visits to `/`, `/usage`, `/angular`,
and `/solid` return host documents whose guest markup is already present in
Declarative Shadow DOM.

## Application layout

```text
examples/ssr/
├── apps/
│   ├── host/           Vite + Cloudflare Worker
│   ├── react-router/   React Router framework mode + Cloudflare Vite plugin
│   ├── qwik/           Qwik + Vite + Cloudflare Worker
│   ├── angular/        Angular application builder + Angular SSR
│   └── solid/          SolidStart + Cloudflare module preset
├── tests/
└── package.json
```

Every directory under `apps` is a workspace package that can be built and
tested on its own. The top-level package only orchestrates them.

## Build the applications normally

The guests use their framework-owned production build commands:

```sh
pnpm --filter example-ssr-react-router build # react-router build
pnpm --filter example-ssr-qwik build         # vite client and SSR builds
pnpm --filter example-ssr-angular build      # ng build
pnpm --filter example-ssr-solid build        # vite build (SolidStart 2 + Nitro)
```

React Router uses `@cloudflare/vite-plugin`, so its deployable Worker
configuration is generated at `apps/react-router/build/server/wrangler.json`.
Angular writes browser and server output to `apps/angular/dist`. SolidStart
writes its Cloudflare module and browser assets to `apps/solid/.output`. Qwik
keeps its checked-in Worker configuration pointed at its Vite output.

Angular 22 uses TypeScript 6.0, its supported compiler API. The Vite applications
and the library use TypeScript 7.

Build the whole composition with:

```sh
pnpm --filter example-ssr build
```

## Connect the Workers

The host has one service binding for each guest. Local development supplies
the generated React Router configuration alongside the checked-in
configurations:

```sh
wrangler dev \
  -c apps/host/wrangler.jsonc \
  -c apps/react-router/build/server/wrangler.json \
  -c apps/qwik/wrangler.jsonc \
  -c apps/angular/wrangler.jsonc \
  -c apps/solid/wrangler.json
```

The first configuration is public. The others satisfy the host's service
bindings without making the guest deployments depend on host code.

## Compose a guest response

For a host route, the Worker requests the guest's ordinary HTML through its
service binding. `materializeVFrameDocument` from `@mewhhaha/v-frame/server` then:

- changes `html`, `head`, and `body` into materializable document elements;
- rewrites inline CSS selectors and URLs for the public guest URL;
- makes guest scripts inert while the host response is parsed; and
- preserves framework hydration and resume metadata.

The host inserts that transformed stream into Declarative Shadow DOM:

```html
<v-frame adopt src="/widgets/angular/dashboard">
  <template shadowrootmode="open" shadowrootserializable>
    <v-html>
      <v-head><!-- Angular document head --></v-head>
      <v-body><!-- Angular SSR output and client entry --></v-body>
    </v-html>
  </template>
</v-frame>
```

When `@mewhhaha/v-frame/register` loads, the element activates the preserved scripts in
the guest realm. React Router hydrates, Qwik resumes, Angular hydrates with
event replay, and SolidStart hydrates its signals through their normal client
entries.

The example keeps critical guest CSS inline so the server-rendered shadow tree
is styled before activation. Browser bundles use explicit mounted bases so
their hashed chunks remain same-origin and pass through the host proxy.

## Routing

Each guest's Location and History APIs remain scoped to that guest, and no guest
imports a host routing API. The shell coordinates routes with the element itself:

- it moves a frontend onto the route the current page owns with
  `frame.navigate(route, { replace: true })`, which the guest sees as a
  same-document navigation and an ordinary `popstate`; and
- it follows a frontend that routes itself by listening for `v-frame-navigated`
  and switching to whichever page owns the route the guest moved to.

The Qwik application handles `popstate` the way any client-side router does, so
the shell can drive it. React Router, Angular, and Solid need nothing at all;
they simply run at their mounted base paths.

## Verify and deploy

```sh
pnpm --filter example-ssr check
pnpm --filter example-ssr deploy
```

`check` builds all applications, regenerates Worker binding types, type-checks,
runs Chromium and Firefox integration tests, and performs a dry-run deploy for
every Worker. The browser tests exercise server composition, routing, interactive
hydration, and WCAG accessibility in all four guest frameworks. Desktop and mobile
first-paint checks hold back the host and guest scripts, sample layout at paint
boundaries, and compare server-preview pixels with the activated content. They
also verify useful rendering without JavaScript and nonblank navigation commits.

`deploy` publishes the guest Workers before the public host so every service
binding resolves when the host becomes active.
