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
    url: "http://localhost:43171/",
  },
  solid: {
    label: "Plugins",
    owner: "Solid plugins frontend",
    url: "http://localhost:43172/",
  },
  qwik: {
    label: "Usage",
    owner: "Qwik usage frontend",
    composerUrl: "http://localhost:43173/?surface=composer",
    profileUrl: "http://localhost:43173/?surface=profile",
    url: "http://localhost:43173/",
  },
} as const satisfies Record<string, MicrofrontendTarget>;

export type MicrofrontendKey = keyof typeof microfrontends;
