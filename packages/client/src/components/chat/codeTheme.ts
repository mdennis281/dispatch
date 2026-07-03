import type { CSSProperties } from "react";

/**
 * A Zed-flavoured Prism theme, hand-tuned to the app tokens. Exported as the
 * style-object shape react-syntax-highlighter expects (token class → CSS).
 */
type PrismStyle = Record<string, CSSProperties>;

const c = {
  bg: "transparent",
  text: "#c9d1d9",
  comment: "#5c6470",
  punct: "#8a929c",
  keyword: "#7c8aff",
  fn: "#79b8ff",
  string: "#8ddb9b",
  number: "#e5b567",
  const: "#d7a0ff",
  tag: "#f0616d",
  prop: "#9aa5ff",
  operator: "#8a929c",
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
