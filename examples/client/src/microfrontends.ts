export interface MicrofrontendTarget {
  composerUrl?: string;
  label: string;
  owner: string;
  profileUrl?: string;
  url: string;
}

export const microfrontends = {
  angular: {
    label: "Transcript",
    owner: "Angular transcript frontend",
    url: "/frontends/angular/",
  },
  solid: {
    label: "Plugins",
    owner: "Solid plugins frontend",
    url: "/frontends/solid/",
  },
  qwik: {
    label: "Usage",
    owner: "Qwik usage frontend",
    composerUrl: "/frontends/qwik/?surface=composer",
    profileUrl: "/frontends/qwik/?surface=profile",
    url: "/frontends/qwik/",
  },
} as const satisfies Record<string, MicrofrontendTarget>;

export type MicrofrontendKey = keyof typeof microfrontends;
