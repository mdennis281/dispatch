/**
 * The globals shim: `window.__dispatch.deps`.
 *
 * REACT IS A SINGLETON. A plugin bundle that carried its own copy of React
 * would render into the host's tree with a second dispatcher, and every hook
 * it called would throw "Invalid hook call" — the one failure that cannot be
 * caught per plugin, because it happens inside the host's render. So the
 * host exposes its own React (and the three libraries a slot is likely to
 * reach for) on a global, and the SDK's Vite preset marks those packages
 * external and resolves them here. The example at examples/plugins/hello-slot
 * proves the pattern in its own vite config.
 *
 * Loaded on demand, not at boot: the full `lucide-react` namespace is every
 * icon in the set, which the SPA itself tree-shakes down to the few dozen it
 * uses. Pulling the whole thing into the main chunk would cost every install
 * ~1 MB for a feature most have no plugin for, so this module is imported
 * dynamically by the loader, the moment it finds a plugin with a client
 * entry — and the namespace becomes its own chunk that only then downloads.
 */
import type { DispatchClientGlobals } from "@dispatch/shared";
import * as react from "react";
import * as reactDom from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as zustand from "zustand";
import * as lucide from "lucide-react";

declare global {
  interface Window {
    __dispatch?: DispatchClientGlobals;
  }
}

/** Install the shim. Idempotent; returns the installed globals. */
export function installPluginDeps(): DispatchClientGlobals {
  const existing = window.__dispatch;
  if (existing) return existing;
  const globals: DispatchClientGlobals = {
    deps: { react, reactDom, jsxRuntime, zustand, lucide },
  };
  window.__dispatch = globals;
  return globals;
}
