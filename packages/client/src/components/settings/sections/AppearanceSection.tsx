import { Moon, SunMoon, Sun, Monitor } from "lucide-react";
import { Field } from "../../sidebar/Modal.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { useTheme } from "../../../stores/theme.js";
import type { AppPaneProps } from "./types.js";

/**
 * Theme, and only theme.
 *
 * Per browser and applied immediately — deliberately NOT part of the settings
 * draft. Routed through the server-side draft it was shared by every device, so
 * opening Settings on one repainted it with another's choice (see stores/theme).
 */
export function AppearanceSection(_props: AppPaneProps) {
  const pref = useTheme((s) => s.pref);
  const setTheme = useTheme((s) => s.setTheme);
  return (
    <Field label="Theme" hint="applies instantly, this browser only">
      <SegmentedControl
        size="md"
        value={pref}
        onChange={setTheme}
        segments={[
          { value: "dark", label: "Dark", icon: <Moon /> },
          { value: "dim", label: "Dim", icon: <SunMoon /> },
          { value: "light", label: "Light", icon: <Sun /> },
          { value: "system", label: "System", icon: <Monitor /> },
        ]}
      />
    </Field>
  );
}
