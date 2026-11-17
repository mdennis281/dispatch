import type { ReactNode } from "react";
import { Save, Undo2 } from "lucide-react";
import { InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";

/**
 * The Unsaved changes / Discard / Save bar at the foot of the app and project
 * settings views. Both carried the same 30 lines.
 *
 * A FUNCTION returning a node, not a component: `SettingsShell` decides whether
 * to draw its bordered footer row by testing `footer` for truthiness. A
 * `<SaveBar />` element is always truthy, so with nothing to say the shell
 * would draw an empty bordered strip.
 */
export function settingsSaveBar({
  error,
  dirty,
  busy,
  onDiscard,
  onSave,
}: {
  error: string | null | undefined;
  dirty: boolean;
  busy: boolean;
  onDiscard: () => void;
  onSave: () => void;
}): ReactNode {
  if (!error && !dirty) return null;
  return (
    <>
      {error ? (
        <div className="mr-auto min-w-0 flex-1">
          <InlineError message={error} />
        </div>
      ) : (
        <span className="mr-auto truncate text-2xs font-medium text-warn">Unsaved changes</span>
      )}
      {dirty && (
        <>
          <Button variant="ghost" leftIcon={<Undo2 />} disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            variant="primary"
            leftIcon={busy ? <Spinner size={12} /> : <Save />}
            disabled={busy}
            onClick={onSave}
          >
            Save
          </Button>
        </>
      )}
    </>
  );
}
