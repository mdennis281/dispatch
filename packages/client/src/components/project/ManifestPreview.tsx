/**
 * ManifestPreview — the right half of the setup page: the `.dispatch/project.yaml`
 * this form is about to write, re-rendered on every keystroke.
 *
 * Not a decoration. The manifest is the committable source of truth for a
 * project's Dispatch config, and the single best way to teach someone what these
 * fields ARE is to show the file changing under their hands — you learn that
 * `worktreeRoot` is one line of YAML by watching the line appear. It also means
 * nothing is hidden: a form that quietly writes keys you never saw is a form you
 * can't trust with a committed file.
 *
 * It renders `renderManifestYaml(projectToManifest(draft))` — the SAME pair of
 * functions the server calls when it scaffolds the real file (they live in
 * `@dispatch/shared` for exactly this reason), so this is a preview in the
 * strict sense rather than an approximation of one.
 */
import { useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import yamlLang from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { Check, Copy, FileCode2 } from "lucide-react";
import { codeTheme } from "../chat/codeTheme.js";
import { cn } from "../../lib/cn.js";

SyntaxHighlighter.registerLanguage("yaml", yamlLang);

export function ManifestPreview({
  yaml,
  path,
  existing,
  className,
}: {
  yaml: string;
  /** Where this file will land (or already lives), shown under the header. */
  path: string;
  /**
   * This is the repo's OWN committed manifest, not a preview of one about to be
   * written. The distinction is the whole point of the pane: a file that is
   * already in force and will be left alone reads identically to one this form
   * is about to create, and confusing the two is how someone assumes their
   * edits landed.
   */
  existing?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(yaml).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden bg-inset", className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-soft px-4 [&_svg]:size-3.5">
        <FileCode2 className={cn("shrink-0", existing ? "text-accent" : "text-muted")} />
        <span className="cm-mono !text-[11px] font-medium text-secondary">project.yaml</span>
        {existing && (
          <span className="shrink-0 rounded-[4px] bg-accent-ghost px-1.5 py-px text-[10px] font-medium text-accent">
            already in this repo
          </span>
        )}
        <span className="min-w-0 truncate text-[10.5px] text-faint" title={path}>
          {path}
        </span>
        <button
          onClick={copy}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] text-faint transition-colors hover:bg-active hover:text-secondary [&_svg]:size-3"
        >
          {copied ? <Check className="text-success" /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="cm-scroll min-h-0 flex-1 overflow-auto px-4 py-3">
        <SyntaxHighlighter
          language="yaml"
          style={codeTheme}
          PreTag="div"
          customStyle={{
            background: "transparent",
            margin: 0,
            padding: 0,
            fontSize: "12px",
            lineHeight: 1.65,
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {yaml}
        </SyntaxHighlighter>
      </div>

      <p className="shrink-0 border-t border-line-soft px-4 py-2 text-[10.5px] leading-snug text-faint">
        {existing ? (
          <>
            This repo already carries this file, and it stays exactly as it is — it&rsquo;s the
            source of truth for the project&rsquo;s config, and it overrides anything the form
            could set. The agent extends it rather than rewriting it.
          </>
        ) : (
          <>
            Written into the repo on create — committable, and the source of truth for this
            project&rsquo;s config from then on. The agent picks up where this file stops.
          </>
        )}
      </p>
    </div>
  );
}
