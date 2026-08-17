import { Moon, Sun, Monitor } from "lucide-react";
import { Field } from "../../sidebar/Modal.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useTheme } from "../../../stores/theme.js";
import type { AppPaneProps } from "./types.js";

/**
 * Theme, and only theme.
 *
 * The picker applies LIVE — you cannot judge a palette from the word "dark" —
 * which is why the save bar's Discard puts the saved theme back rather than just
 * dropping the draft field.
 */
export function AppearanceSection({ draft, patch }: AppPaneProps) {
  const setTheme = useTheme((s) => s.setTheme);
  return (
    <Field label="Theme" hint="previews live, saved for all devices">
      <SegmentedControl
        size="md"
        value={draft.theme}
        onChange={(v) => {
          patch({ theme: v });
          setTheme(v);
        }}
        segments={[
          { value: "dark", label: "Dark", icon: <Moon /> },
          { value: "light", label: "Light", icon: <Sun /> },
          { value: "system", label: "System", icon: <Monitor /> },
        ]}
      />
    </Field>
  );
}
