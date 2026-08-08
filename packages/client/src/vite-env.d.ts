/// <reference types="vite/client" />

/** Build stamp (`yyyy.mm.dd.sssss`, UTC) injected by `define` in vite.config.ts. */
declare const __BUILD_VERSION__: string;

/** Deep ESM language imports from react-syntax-highlighter lack bundled types. */
declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const language: unknown;
  export default language;
}
declare module "react-syntax-highlighter/dist/esm/prism-light" {
  import type { ComponentType } from "react";
  const PrismLight: ComponentType<Record<string, unknown>> & {
    registerLanguage: (name: string, language: unknown) => void;
  };
  export default PrismLight;
}
