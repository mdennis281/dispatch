/// <reference types="vite/client" />

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
