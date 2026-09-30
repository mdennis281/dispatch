/**
 * The house-rules editor — ONE implementation, mounted in two places.
 *
 * It lives here rather than beside either of its call sites because both App
 * settings → Agent context and Project settings → Agent context edit the SAME
 * two files, and two editors over one file is how you get a lost edit: each
 * holds its own unsaved draft, neither knows the other exists, and the last
 * Save wins silently. (It used to live in the Memory view; that tab is gone for
 * exactly this reason.)
 *
 * The scopes are deliberately not interchangeable in the UI even though they
 * share this component: the global file is shown everywhere and the project one
 * only where a project is in scope, so each pane passes the file it owns.
 */
import { useState } from "react";
import { Check, Globe, FolderGit2, RotateCcw, type LucideIcon } from "lucide-react";
import type { HouseRulesFile, HouseRulesScope } from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/cn.js";

export const HOUSE_RULES_SCOPE_META: Record<
  HouseRulesScope,
  { label: string; hint: string; icon: LucideIcon; placeholder: string }
> = {
  global: {
    label: "Everywhere",
    hint: "Every chat in every project on this machine.",
    icon: Globe,
    placeholder:
      "- Be terse in peer messages.\n- Never upgrade the stable install without asking.",
  },
  project: {
    label: "This project",
    hint: "Every chat in this project, after the global rules.",
    icon: FolderGit2,
    placeholder:
      "- Ship through a reviewed PR, never push to main.\n- Verify UI changes by looking at them.",
  },
};

export function HouseRulesEditor({
  projectId,
  file,
  onSaved,
  /** Shown instead of the scope's own hint — e.g. to say the global file is being replaced. */
  hint,
  rows = 14,
}: {
  projectId?: string;
  file: HouseRulesFile;
  onSaved: (saved: HouseRulesFile) => void;
  hint?: string;
  rows?: number;
}) {
  const [text, setText] = useState(file.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const length = text.trim().length;
  const over = length > file.limit;
  const dirty = text.trim() !== file.text;
  const meta = HOUSE_RULES_SCOPE_META[file.scope];
  const Icon = meta.icon;

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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary">
          {meta.label}
        </span>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<RotateCcw />}
            onClick={() => setText(file.text)}
          >
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
      <p className="text-xs leading-snug text-faint">{hint ?? meta.hint}</p>
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
        rows={rows}
        spellCheck={false}
        placeholder={meta.placeholder}
        className={cn(
          "w-full resize-y rounded-md border bg-inset px-2.5 py-2 cm-mono !text-xs leading-relaxed " +
            "text-primary outline-none placeholder:text-faint",
          over ? "border-danger" : "border-line focus:border-line-strong",
        )}
      />
      <div className="flex flex-wrap items-center gap-2 text-2xs">
        <span className={cn("cm-mono", over ? "text-danger" : "text-faint")}>
          {length}/{file.limit}
        </span>
        {/* Says how to FIX it, not just that it's broken: the cap is a setting
            now, and the whole reason it became one is that hitting it used to
            leave you with nowhere to put the overflow but an instruction file. */}
        {over && (
          <span className="text-danger">
            Over by {length - file.limit}. Raise the cap below, or move the overflow into a
            skill.
          </span>
        )}
        {savedAt && !dirty && <span className="text-success">Saved — applies to new turns.</span>}
        {error && <span className="text-danger">{error}</span>}
        <span className="ml-auto truncate cm-mono !text-2xs text-faint" title={file.path}>
          {file.path}
        </span>
      </div>
    </div>
  );
}
