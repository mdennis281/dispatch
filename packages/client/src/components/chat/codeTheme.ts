import type { CSSProperties } from "react";

/**
 * A Zed-flavoured Prism theme, hand-tuned to the app tokens. Exported as the
 * style-object shape react-syntax-highlighter expects (token class → CSS).
 *
 * Every colour is a `var()` rather than a hex. Two reasons, and the second is
 * the important one:
 *   - this object is built ONCE at module scope, so a hex here would survive a
 *     theme switch and leave dark-mode syntax colours on a white code block;
 *   - the same `--p-syn-*` tokens drive Monaco (`components/monaco/setup.ts`),
 *     which is the only way a file keeps its colours when you open it in the
 *     other pane.
 */
type PrismStyle = Record<string, CSSProperties>;

const c = {
  bg: "transparent",
  text: "var(--p-syn-text)",
  comment: "var(--p-syn-comment)",
  punct: "var(--p-syn-punct)",
  keyword: "var(--p-syn-keyword)",
  fn: "var(--p-syn-fn)",
  string: "var(--p-syn-string)",
  number: "var(--p-syn-number)",
  const: "var(--p-syn-const)",
  tag: "var(--p-syn-tag)",
  prop: "var(--p-syn-prop)",
  operator: "var(--p-syn-operator)",
};

export const codeTheme: PrismStyle = {
  'code[class*="language-"]': {
    color: c.text,
    background: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.5",
    whiteSpace: "pre",
    tabSize: 2,
  },
  'pre[class*="language-"]': {
    color: c.text,
    background: c.bg,
    margin: 0,
    padding: 0,
    overflow: "auto",
  },
  comment: { color: c.comment, fontStyle: "italic" },
  prolog: { color: c.comment },
  doctype: { color: c.comment },
  cdata: { color: c.comment },
  punctuation: { color: c.punct },
  property: { color: c.prop },
  tag: { color: c.tag },
  boolean: { color: c.number },
  number: { color: c.number },
  constant: { color: c.const },
  symbol: { color: c.const },
  deleted: { color: c.tag },
  selector: { color: c.string },
  "attr-name": { color: c.prop },
  string: { color: c.string },
  char: { color: c.string },
  builtin: { color: c.const },
  inserted: { color: c.string },
  operator: { color: c.operator },
  entity: { color: c.prop },
  url: { color: c.fn },
  variable: { color: c.text },
  atrule: { color: c.keyword },
  "attr-value": { color: c.string },
  keyword: { color: c.keyword },
  function: { color: c.fn },
  "class-name": { color: c.const },
  regex: { color: c.string },
  important: { color: c.tag, fontWeight: "bold" },
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
};
