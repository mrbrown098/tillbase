import type { TillbaseApi } from "../../shared/api";

declare global {
  interface Window {
    tillbase: TillbaseApi;
  }
}

export const api: TillbaseApi = new Proxy({} as TillbaseApi, {
  get: (_t, name: string) => {
    if (!window.tillbase) {
      throw new Error("Tillbase must run inside the desktop app (window.tillbase is missing).");
    }
    return (window.tillbase as unknown as Record<string, unknown>)[name];
  },
});
