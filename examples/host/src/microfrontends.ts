export interface MicrofrontendTarget {
  label: string;
  url: string;
}

export const microfrontends = {
  angular: { label: "Angular", url: "http://localhost:43171/" },
  solid: { label: "Solid", url: "http://localhost:43172/" },
  qwik: { label: "Qwik", url: "http://localhost:43173/" },
} as const satisfies Record<string, MicrofrontendTarget>;

export type MicrofrontendKey = keyof typeof microfrontends;
