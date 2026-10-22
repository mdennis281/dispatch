/**
 * `loadClientPlugins` against the real app. Split from loader.ts so the
 * loader's logic stays importable in the node test environment: this module
 * pulls in the host, which pulls in the kit, the API client and the socket.
 */
import { api } from "../lib/api.js";
import { useNotices } from "../stores/notices.js";
import { createClientHost } from "./host.js";
import { loadClientPlugins } from "./loader.js";

let started = false;

/** Idempotent: `startLiveApp` may be reached twice (boot, then sign-in). */
export function startClientPlugins(): void {
  if (started) return;
  started = true;
  void loadClientPlugins({
    list: () => api.plugins.list(),
    importModule: (url) => import(/* @vite-ignore */ url),
    installDeps: async () => {
      const { installPluginDeps } = await import("./deps.js");
      installPluginDeps();
    },
    toast: (text, detail) => useNotices.getState().push({ level: "error", text, detail }),
    makeHost: createClientHost,
  });
}
