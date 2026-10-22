// Builds src/index.tsx into client/index.js — ONE ES module that imports
// nothing — through the SDK's client preset. The preset resolves `react`,
// `react-dom`, `react/jsx-runtime`, `zustand` and `lucide-react` to the
// host's copies on `window.__dispatch.deps` instead of bundling them: React
// is a singleton, and a second copy breaks every hook. See
// packages/plugin-sdk/src/vite.ts for the mechanism and the measurements.
import { dirOf, dispatchClientBuild } from "@dispatch/plugin-sdk/vite";

export default dispatchClientBuild({ root: dirOf(import.meta.url), entry: "src/index.tsx" });
