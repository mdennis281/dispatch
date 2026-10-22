// src/server.ts → server/index.js: one Node ES module with only `node:*`
// imports left, which is the shape the host can load from the plugin directory
// (no node_modules there). See packages/plugin-sdk/src/vite.ts.
import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";

export default dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" });
