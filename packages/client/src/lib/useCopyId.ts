/**
 * Copying an id to the clipboard, with the toast that says it landed.
 *
 * Shared because the chat header's menu and the sidebar row's menu now offer
 * the same item, and a SILENT copy is indistinguishable from a failed one:
 * `navigator.clipboard.writeText` rejects on an insecure context or a denied
 * permission, and the only place that shows is in the confirmation that never
 * came. Anyone who copies an id is about to paste it somewhere that will fail
 * confusingly with the previous clipboard contents.
 */
import { useCallback } from "react";
import { copyToClipboard } from "./clipboard.js";
import { useNotices } from "../stores/notices.js";

/** `copy(value, label)` — copies, then reports. `label` names it in the toast. */
export function useCopyId(): (value: string, label: string) => void {
  const push = useNotices((s) => s.push);
  return useCallback(
    (value: string, label: string) => {
      void copyToClipboard(value).then((ok) => {
        push(
          ok
            ? { level: "info", text: `${label} copied`, detail: value }
            : { level: "error", text: `Couldn't copy ${label.toLowerCase()}`, detail: value },
        );
      });
    },
    [push],
  );
}
