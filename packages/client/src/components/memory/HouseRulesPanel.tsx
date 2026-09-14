import { useEffect, useState, type ReactNode } from "react";
import { Check, Globe, FolderGit2, RotateCcw } from "lucide-react";
import type { HouseRules, HouseRulesFile, HouseRulesScope } from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { cn } from "../../lib/cn.js";
import { MemoryListRow } from "./MemoryListRow.js";

const SCOPE_META: Record<HouseRulesScope, { label: string; hint: string; icon: ReactNode }> = {
  global: {
    label: "Everywhere",
    hint: "Every chat in every project on this machine.",
    icon: <Globe className="size-3.5" />,
  },
  project: {
    label: "This project",
    hint: "Every chat in this project, after the global rules.",
    icon: <FolderGit2 className="size-3.5" />,
  },
};

/**
 * House rules: the only guidance injected into EVERY chat unconditionally.
 * Two capped files, so what's always-on is a deliberate, visible choice rather
 * than whatever memories happened to be typed `user`/`feedback`.
 */
export function HouseRulesPanel({ projectId, header }: { projectId: string; header: ReactNode }) {
  const [rules, setRules] = useState<HouseRules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<HouseRulesScope>("project");

  useEffect(() => {
    let live = true;
    setRules(null);
    setLoadError(null);
    api.houseRules
      .get(projectId)
      .then((r) => live && setRules(r))
      .catch((err) => live && setLoadError(err instanceof ApiError ? err.message : "Failed to load."));
    return () => {
      live = false;
    };
  }, [projectId]);

  const file = rules ? (scope === "global" ? rules.global : rules.project) : null;

  return (
    <div className="flex min-w-0 flex-1 bg-app">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-surface">
        {header}
        <div className="space-y-0.5 p-2">
          {(["global", "project"] as const).map((s) => {
            const f = rules ? (s === "global" ? rules.global : rules.project) : null;
            return (
              <MemoryListRow key={s} active={s === scope} onClick={() => setScope(s)}>
                <div className="flex items-center gap-2 text-primary">
                  {SCOPE_META[s].icon}
                  <span className="flex-1 text-sm font-medium">{SCOPE_META[s].label}</span>
                  {f && (
                    <span className="cm-mono !text-2xs text-faint">
                      {f.text.length}/{f.limit}
                    </span>
                  )}
                </div>
                <span className="truncate text-2xs text-faint">{SCOPE_META[s].hint}</span>
              </MemoryListRow>
            );
          })}
        </div>
        <p className="px-4 pb-3 text-2xs leading-relaxed text-faint">
          House rules are the only thing every chat always gets. Project memory is a lookup
          catalogue: it surfaces when relevant instead.
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {loadError ? (
          <p className="p-6 text-sm text-danger">{loadError}</p>
        ) : file ? (
          <HouseRulesEditor
            key={`${projectId}:${file.scope}`}
            projectId={projectId}
            file={file}
            onSaved={(saved) =>
              setRules((r) => (r ? { ...r, [saved.scope]: saved } : r))
            }
          />
        ) : (
          <p className="p-6 text-sm text-faint">Loading…</p>
        )}
      </div>
    </div>
  );
}

function HouseRulesEditor({
  projectId,
  file,
  onSaved,
}: {
  projectId: string;
  file: HouseRulesFile;
  onSaved: (saved: HouseRulesFile) => void;
}) {
  const [text, setText] = useState(file.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const length = text.trim().length;
  const over = length > file.limit;
  const dirty = text.trim() !== file.text;
  const meta = SCOPE_META[file.scope];

  const save = async () => {
    if (over || saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.houseRules.save(
        file.scope,
        text,
        file.scope === "project" ? projectId : undefined,
      );
      onSaved(saved);
      setText(saved.text);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save house rules.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-muted">{meta.icon}</span>
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-primary">
          House rules · {meta.label}
        </span>
        {dirty && (
          <Button size="sm" variant="ghost" leftIcon={<RotateCcw />} onClick={() => setText(file.text)}>
            Revert
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Check />}
          disabled={over || saving || !dirty}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="text-sm text-secondary">{meta.hint}</p>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSavedAt(null);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
            rows={14}
            spellCheck={false}
            placeholder={
              file.scope === "global"
                ? "- Be terse in peer messages.\n- Never upgrade the stable install without asking."
                : "- Ship through a reviewed PR, never push to main.\n- Verify UI changes by looking at them."
            }
            className={cn(
              "min-h-64 w-full resize-y rounded-md border bg-inset px-2.5 py-2 cm-mono !text-xs leading-relaxed " +
                "text-primary outline-none placeholder:text-faint",
              over ? "border-danger" : "border-line focus:border-line-strong",
            )}
          />
          <div className="flex items-center gap-2 text-2xs">
            <span className={cn("cm-mono", over ? "text-danger" : "text-faint")}>
              {length}/{file.limit}
            </span>
            {over && <span className="text-danger">Over the limit by {length - file.limit}.</span>}
            {savedAt && !dirty && <span className="text-success">Saved — applies to new turns.</span>}
            {error && <span className="text-danger">{error}</span>}
            <span className="ml-auto truncate cm-mono !text-2xs text-faint" title={file.path}>
              {file.path}
            </span>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
