import { useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import tsLang from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsxLang from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import jsLang from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsonLang from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bashLang from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import diffLang from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { codeTheme } from "./codeTheme.js";

SyntaxHighlighter.registerLanguage("typescript", tsLang);
SyntaxHighlighter.registerLanguage("ts", tsLang);
SyntaxHighlighter.registerLanguage("tsx", tsxLang);
SyntaxHighlighter.registerLanguage("javascript", jsLang);
SyntaxHighlighter.registerLanguage("js", jsLang);
SyntaxHighlighter.registerLanguage("json", jsonLang);
SyntaxHighlighter.registerLanguage("bash", bashLang);
SyntaxHighlighter.registerLanguage("sh", bashLang);
SyntaxHighlighter.registerLanguage("shell", bashLang);
SyntaxHighlighter.registerLanguage("diff", diffLang);

const LABELS: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  diff: "Diff",
};

export interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
}

/** A framed, syntax-highlighted code block with a header + copy button. */
export function CodeBlock({ code, language = "ts", filename, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lang = language.toLowerCase();
  const label = filename ?? LABELS[lang] ?? lang.toUpperCase();

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div
      className={cn(
        "group my-2 overflow-hidden rounded-md border border-line bg-inset",
        className,
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-line-soft bg-hover px-3">
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="cm-mono !text-2xs text-muted">{label}</span>
        {filename && (
          <span className="cm-mono !text-2xs text-faint">{LABELS[lang] ?? lang}</span>
        )}
        <button
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-2xs text-faint opacity-0 transition-opacity hover:bg-active hover:text-secondary group-hover:opacity-100 [&_svg]:size-3"
        >
          {copied ? <Check className="text-success" /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="cm-scroll overflow-x-auto px-3.5 py-2.5">
        <SyntaxHighlighter
          language={lang}
          style={codeTheme}
          PreTag="div"
          customStyle={{ background: "transparent", margin: 0, padding: 0 }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
