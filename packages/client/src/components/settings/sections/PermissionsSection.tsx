import { useEffect, useState, type FormEvent } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { DEFAULT_AUTO_ALLOW_TOOLS, SHELL_TOOLS } from "@dispatch/shared";
import { Field, InlineError, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Spinner } from "../../ui/Spinner.js";
import { api } from "../../../lib/api.js";

/**
 * The tools that run without a permission card, in every chat.
 *
 * Saves on every change rather than through the Settings draft, and that is the
 * point of the pane: the permission card's "Always allow" appends to this same
 * list from any chat at any moment, so a draft loaded before that click and
 * saved after it would silently put the prompt back. Each add or remove here is
 * one request against the server's current list.
 */
export function PermissionsSection() {
  // `undefined` = never customised (the shared defaults apply); `null` = loading.
  const [stored, setStored] = useState<string[] | undefined | null>(null);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings
      .get()
      .then((s) => live && setStored(s.autoAllowTools))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const save = async (tools: string[] | null) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.settings.setAutoAllowTools(tools);
      setStored(saved.autoAllowTools);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (stored === null && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  const tools = stored ?? [...DEFAULT_AUTO_ALLOW_TOOLS];
  const isDefault = stored === undefined;
  const pending = entry.trim();
  const isShell = SHELL_TOOLS.includes(pending);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!pending || tools.includes(pending)) return;
    setEntry("");
    void save([...tools, pending]);
  };

  return (
    <div className="space-y-3">
      <form onSubmit={add} className="space-y-1.5">
        <Field label="Add a tool" hint="exact name, prefix*, or an MCP server">
          <div className="flex gap-1.5">
            <TextInput
              mono
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="mcp__dispatch-chat__chat_find"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <Button type="submit" size="sm" leftIcon={<Plus />} disabled={!pending || busy}>
              Add
            </Button>
          </div>
        </Field>
        {/* Said where the shell is being typed, not in the blurb: this is the one
            entry that turns "fewer prompts" into "an agent can run anything". */}
        {isShell && (
          <p className="text-xs text-warn">
            {pending} on this list runs ANY command without asking, in every chat and project. A
            mode&apos;s blocked tools still win, so the global chat stays shell-free.
          </p>
        )}
      </form>

      <InlineError message={error} />

      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-secondary">
            Never ask about ({tools.length})
          </span>
          <span className="text-2xs text-faint">{isDefault ? "defaults" : "customised"}</span>
          {!isDefault && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RotateCcw />}
              className="ml-auto"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Reset to defaults
            </Button>
          )}
        </div>
        {tools.length === 0 ? (
          <p className="rounded-md border border-line-soft px-2.5 py-2 text-xs text-muted">
            Empty — every tool the permission mode doesn&apos;t already allow will ask.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-md border border-line-soft">
            {tools.map((tool) => (
              <li key={tool} className="flex items-center gap-2 px-2.5 py-1">
                <code className="min-w-0 flex-1 truncate cm-mono text-xs text-primary">{tool}</code>
                <IconButton
                  tip={`Ask about ${tool} again`}
                  disabled={busy}
                  onClick={() => void save(tools.filter((t) => t !== tool))}
                >
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        &ldquo;Always allow&rdquo; on a permission card adds to this list. A mode can add more of
        its own (<code className="text-fg">autoAllowTools</code> in a mode file, or{" "}
        <code className="text-fg">mode_write</code>), on top of this list, never instead of it. This
        only skips the question: a tool a mode blocks stays blocked, and plan mode still asks
        before anything that writes.
      </p>
    </div>
  );
}
