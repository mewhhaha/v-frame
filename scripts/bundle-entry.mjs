import { rolldown } from "rolldown";

export function bundleEntry(input, platform, external = []) {
  return rolldown({
    input,
    platform,
    external,
    transform: { target: "es2022" },
  });
}
