export interface MicrofrontendTarget {
  label: string;
  url: string;
}

export const microfrontends = {
  angular: { label: "Angular", url: "http://localhost:5171/" },
  solid: { label: "Solid", url: "http://localhost:5172/" },
  qwik: { label: "Qwik", url: "http://localhost:5173/" },
} as const satisfies Record<string, MicrofrontendTarget>;

export type MicrofrontendKey = keyof typeof microfrontends;
