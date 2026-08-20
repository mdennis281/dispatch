import { useContext, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";
import {
  CodeRefContext,
  CodeRefChip,
  linkifyChildren,
  resolveWholeRef,
  type CodeRefResolver,
} from "./codeRefs.js";
import { MarkdownImage, MediaRefContext, linkifyMediaChildren } from "./mediaRefs.js";
import { cn } from "../../lib/cn.js";

/**
 * Pull a filename out of a code-fence info string's meta, so ```ts src/foo.ts,
 * ```ts title="foo.ts", or ```ts filename=foo.ts all surface in the code header.
 */
function fenceFilename(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const kv = /(?:title|file|filename|name)\s*=\s*["']?([^"'\s]+)["']?/i.exec(meta);
  if (kv) return kv[1];
  const tok = meta.trim().split(/\s+/)[0];
  if (tok && (tok.includes("/") || /\.[A-Za-z0-9]+$/.test(tok))) return tok;
  return undefined;
}

/**
 * Linkify string leaves of a prose element's children — first into clickable
 * code pointers, then into media chips for any `out/chart.png` left over.
 *
 * Order matters and the passes are disjoint: a code pointer must carry a line
 * number and a source extension, a media path carries neither, so nothing is
 * eligible for both. Media runs second so it only ever sees the string leaves
 * the code pass declined to claim.
 *
 * Both are no-ops without their context in scope (a live streaming row has no
 * resolver; a preview pane has no chat), which is why each is guarded
 * separately rather than behind one flag.
 */
function Linkify({ children }: { children?: ReactNode }) {
  const resolve = useContext(CodeRefContext);
  const chatId = useContext(MediaRefContext);
  const withCode = resolve ? linkifyChildren(children, resolve) : children;
  return <>{chatId ? linkifyMediaChildren(withCode, chatId) : withCode}</>;
}

/** Assistant markdown → tokenised HTML with our code blocks + quiet typography. */
const components: Components = {
  p: ({ children }) => (
    <p className="my-2 leading-[1.6] first:mt-0 last:mb-0"><Linkify>{children}</Linkify></p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-hi underline decoration-accent-line underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-primary"><Linkify>{children}</Linkify></strong>
  ),
  em: ({ children }) => <em className="italic text-secondary"><Linkify>{children}</Linkify></em>,
  ul: ({ children }) => <ul className="my-2 space-y-1 pl-4 [&>li]:list-disc marker:text-faint">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 space-y-1 pl-4 [&>li]:list-decimal marker:text-faint">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-[1.55]"><Linkify>{children}</Linkify></li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-xl font-semibold text-primary"><Linkify>{children}</Linkify></h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-lg font-semibold text-primary"><Linkify>{children}</Linkify></h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-base font-semibold text-primary"><Linkify>{children}</Linkify></h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-accent-line pl-3 text-secondary"><Linkify>{children}</Linkify></blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto cm-scroll cm-scroll-x">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 text-left font-semibold text-secondary"><Linkify>{children}</Linkify></th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1 text-secondary"><Linkify>{children}</Linkify></td>,
  code(props) {
    const { children, className, node } = props as {
      children?: React.ReactNode;
      className?: string;
      node?: { data?: { meta?: string } };
    };
    // eslint-disable-next-line react-hooks/rules-of-hooks -- react-markdown renders this as a component
    const resolve = useContext(CodeRefContext);
    const match = /language-(\w+)/.exec(className ?? "");
    const raw = String(children ?? "").replace(/\n$/, "");
    // Inline code (no language + single line) renders as a chip.
    if (!match && !raw.includes("\n")) {
      // A backticked code pointer (`src/foo.ts:69`) becomes clickable instead.
      const request = resolve ? resolveWholeRef(raw, resolve) : null;
      if (request) return <CodeRefChip label={raw.trim()} request={request} />;
      return (
        <code className="rounded-[4px] border border-line-soft bg-active px-1 py-px cm-mono !text-xs text-accent-hi">
          {children}
        </code>
      );
    }
    return (
      <CodeBlock code={raw} language={match?.[1] ?? "text"} filename={fenceFilename(node?.data?.meta)} />
    );
  },
  pre: ({ children }) => <>{children}</>,
  // Without this, `![chart](out/chart.png)` rendered a bare <img> pointed at the
  // SPA's own origin — a guaranteed 404 and the broken-image glyph. See
  // mediaRefs.tsx for how a working-tree path is actually served.
  img: ({ src, alt }) => (
    <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />
  ),
};

export function Markdown({
  children,
  className,
  resolve,
  chatId,
}: {
  children: string;
  className?: string;
  /** When set, code pointers (path:line) in prose/inline-code become clickable. */
  resolve?: CodeRefResolver;
  /**
   * When set, image paths resolve against this chat's worktree — both explicit
   * `![…](…)` embeds and bare media paths mentioned in prose. Omitted for
   * previews that have no chat to resolve against, where a path is just text.
   */
  chatId?: string;
}) {
  return (
    <div className={cn("text-base text-primary/95", className)}>
      <CodeRefContext.Provider value={resolve ?? null}>
        <MediaRefContext.Provider value={chatId ?? null}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {children}
          </ReactMarkdown>
        </MediaRefContext.Provider>
      </CodeRefContext.Provider>
    </div>
  );
}
