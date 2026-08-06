/**
 * The one thing the renderer cannot do for itself.
 *
 * A browser is never told the path of a file dragged in from the OS file
 * manager — `DataTransfer.files` carries the CONTENT and a bare basename, and
 * that is the whole security boundary. Electron is allowed to cross it:
 * `webUtils.getPathForFile` maps a dropped `File` back to its real path.
 *
 * That call only exists in the renderer's Electron context, so it has to be
 * bridged from here. Everything else the SPA needs it already gets over HTTP,
 * which is why this bridge stays deliberately tiny: one function, no ipc, no
 * node. `contextIsolation` stays on and the exposed surface is a single pure
 * lookup, so widening it later has to be a deliberate act.
 *
 * The renderer feature-detects `window.cmDesktop` and degrades to basename
 * resolution when it's absent — the same bundle still runs in a plain browser.
 */
import { contextBridge, webUtils } from "electron";

/**
 * `File` as Electron's own typings spell it. Taken from the function rather than
 * the DOM lib because this package compiles with `lib: ES2022` (it's a Node
 * process; pulling in DOM globals to name one parameter would be worse).
 */
type DroppedFile = Parameters<typeof webUtils.getPathForFile>[0];

contextBridge.exposeInMainWorld("cmDesktop", {
  /**
   * Real filesystem path for a dropped file, or "" when the object isn't one
   * the OS can place (a synthesized File from a paste, a directory entry on
   * some platforms). Never throws: the caller's fallback is the basename
   * lookup it would have done anyway.
   */
  getPathForFile: (file: DroppedFile): string => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
});
