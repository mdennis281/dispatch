/**
 * Single mount point for the code-preview overlay. Rendered once at the app
 * root; shows the Monaco viewer whenever a surface has opened one. Renders
 * nothing (and imports no Monaco) until a file is requested.
 *
 * Two open paths converge here:
 *  - direct: `openCodeViewer(...)` (chat tool cards, via ./index helpers).
 *  - decoupled: the right-panel fires a `cm:open-file` window event
 *    (panelBus `OPEN_FILE_EVENT`) so panels never import this area; we listen
 *    for it here and enrich it with the worktree's branch.
 */
import { useEffect } from "react";
import { CodeViewer } from "./CodeViewer.js";
import { useCodeViewer, openCodeViewer } from "./store.js";
import { usePanels } from "../../stores/panels.js";
import { OPEN_FILE_EVENT, type OpenFileRequest } from "../panels/panelBus.js";

export function CodeViewerHost() {
  const request = useCodeViewer((s) => s.request);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const req = (e as CustomEvent<OpenFileRequest>).detail;
      if (!req?.worktreePath || !req.relPath) return;
      const branch = usePanels
        .getState()
        .worktrees.find((w) => w.path === req.worktreePath)?.branch;
      openCodeViewer({
        worktreePath: req.worktreePath,
        relPath: req.relPath,
        mode: "diff",
        base: req.base ?? "main",
        branch,
      });
    };
    window.addEventListener(OPEN_FILE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpen);
  }, []);

  if (!request) return null;
  return <CodeViewer request={request} />;
}
