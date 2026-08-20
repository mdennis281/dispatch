import { useEffect } from "react";
import { MessageSquareDashed } from "lucide-react";
import { TopBar } from "./components/layout/TopBar.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { Drawer } from "./components/layout/Drawer.js";
import { BottomNav } from "./components/layout/BottomNav.js";
import { ChatView } from "./components/chat/ChatView.js";
import { CodeViewerHost } from "./components/monaco/index.js";
import { AgentRunHost } from "./components/agents/AgentRunHost.js";
import { WorkspaceView } from "./components/workspace/WorkspaceView.js";
import { ProcessesOverlay } from "./components/panels/ProcessesOverlay.js";
import { McpCatalogView } from "./components/mcp/McpCatalogView.js";
import { ProjectSettingsView } from "./components/config/ProjectSettingsView.js";
import { NewProjectView } from "./components/project/NewProjectView.js";
import { MemoryView } from "./components/memory/MemoryView.js";
import { GitView } from "./components/git/GitView.js";
import { FilesView } from "./components/files/FilesView.js";
import { MetricsView } from "./components/metrics/MetricsView.js";
import { FilePickerHost } from "./components/files/FilePickerModal.js";
import { AppSettingsView } from "./components/settings/AppSettingsView.js";
import { ManageConfigDialog } from "./components/sidebar/ManageConfigDialog.js";
import { Toasts } from "./components/Toasts.js";
import { ShutdownScreen } from "./components/ShutdownScreen.js";
import { UpdatingScreen } from "./components/update/UpdatingScreen.js";
import { ConnectingScreen } from "./components/connection/ConnectingScreen.js";
import { useChats } from "./stores/chats.js";
import { useProjects, useActiveProject } from "./stores/projects.js";
import { visibleChat } from "./stores/navigation.js";
import { useView } from "./stores/view.js";
import { useLayout } from "./stores/layout.js";
import { AuthGate } from "./components/auth/AuthGate.js";
import { ViewportDebug } from "./components/layout/ViewportDebug.js";
import { startViewportTracking } from "./stores/viewport.js";
import { cn } from "./lib/cn.js";

/**
 * Empty state when no chat is open — including right after a project switch,
 * which closes the previous project's chat rather than leaving it on screen
 * beside the new project's sidebar.
 */
function NoChat() {
  const project = useActiveProject();
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-5">
        <MessageSquareDashed />
      </span>
      <p className="text-base font-medium text-secondary">No chat selected</p>
      <p className="mt-0.5 text-xs text-muted">
        {project
          ? `Pick a chat from the sidebar, or start a new one in ${project.name}.`
          : "Pick a project from the sidebar to get started."}
      </p>
    </div>
  );
}

export default function App() {
  const activeProjectId = useProjects((s) => s.activeProjectId);
  // Only ever the active project's own chat — see visibleChat. Anything else
  // (another project's chat, an id that hasn't hydrated) falls through to the
  // empty state.
  const chat = useChats((s) => visibleChat(s, activeProjectId));
  const view = useView((s) => s.view);
  // Project setup is the one surface that isn't ABOUT the active project — it's
  // how a project comes to exist — so it takes the whole window under the top
  // bar. A sidebar listing some other project's chats beside it is noise at
  // best, and at worst reads as "you're editing that one".
  const fullBleed = view === "new-project";

  // Breakpoint (see lib/useBreakpoint + stores/layout). `lg` is the layout this
  // app has always had and must stay pixel-identical: both `Drawer`s are
  // `enabled={false}` there, which renders them as `display: contents` — no box,
  // no transform, the columns hand themselves straight back to the flex row.
  const mode = useLayout((s) => s.mode);
  const leftOpen = useLayout((s) => s.leftOpen);
  const pane = useLayout((s) => s.pane);
  const setLeftOpen = useLayout((s) => s.setLeftOpen);
  const setPane = useLayout((s) => s.setPane);

  // Publishes `--cm-kb` (see below) and the raw readings behind `ViewportDebug`.
  useEffect(startViewportTracking, []);

  return (
    <>
      {/* OUTSIDE the auth gate, deliberately. An update restarts the server, so
          for part of it there is no session to authenticate against — inside the
          gate this screen was replaced by a login form partway through the very
          process it exists to narrate. It renders over everything either way,
          and watching your own update finish is not a privileged operation. */}
      <UpdatingScreen />
      {/* Outside the gate for the same reason, and a stronger one: a server this
          tab cannot reach is a server it cannot authenticate against either, so
          inside the gate the diagnosis would be replaced by a login form for the
          very host it is trying to tell you is unreachable. It stands down on
          its own whenever the shutdown or updating screens have a more specific
          answer — see its guards. */}
      <ConnectingScreen />
      <AuthGate>
      {/* `100dvh`, not `100vh`. On mobile Safari `vh` is pinned to the LARGEST
          viewport (URL bar retracted), so a `h-screen` app column is taller than
          the window whenever the bar is showing — and since this column is
          `overflow-hidden` with the composer at its bottom, the difference isn't
          a scroll, it's the composer being cut off the bottom of the screen.
          `dvh` tracks the live viewport.

          …but only the URL bar. A soft keyboard shrinks the VISUAL viewport
          and leaves the layout viewport (and therefore `dvh`) alone, so the
          bottom of this column would sit behind the keyboard. `--cm-kb` is how
          much the keyboard is covering; padding it off the column shrinks the
          whole shell to what you can actually see, which puts the composer
          directly on top of the keyboard instead of stranding it mid-screen.
          It is 0px whenever no keyboard is up, so desktop is untouched.

          …and it is JUST `100dvh`. This used to be `var(--cm-vh, 100dvh)`,
          where `--cm-vh` was the tallest the window had ever been — an attempt
          to out-guess the iOS standalone bug that shrinks the window by ~59px
          on first keyboard open and never restores it. It cannot work, in
          either direction. On iOS, paint is clipped to the layout viewport, so
          a shell pinned past it isn't taller, it's cut off — the bottom nav's
          labels landed in a band the device never draws. And an installed
          DESKTOP window is `standalone` too: drag its bottom edge up and the
          width never changes, so the remembered maximum never resets and the
          shell stayed pinned at a height the window no longer had, cutting off
          everything below the fold until you happened to resize sideways.
          The shell follows the window. See docs/ios-pwa-viewport-findings.md. */}
      {/* `fixed`, not in flow. `overflow: hidden` on html/body does not stop iOS
          touch-panning a document that overflows, and this box used to overflow
          it — you could drag the whole app up and down, which slid the bottom
          nav around and let Safari's URL bar collapse and expand under you. It
          no longer overflows, but `fixed` is still what guarantees that: a fixed
          box contributes no scrollable overflow at all, whatever its height, so
          there is nothing to pan even if this is mis-sized again.
          `inset-x-0` rather than `w-screen` for the same reason horizontally —
          `100vw` includes a scrollbar the shell doesn't have. */}
      <div
        // Measured by `stores/viewport` so the readout can report where this
        // box's bottom edge actually LANDS rather than what it was asked for.
        data-cm-shell=""
        className="fixed inset-x-0 top-0 flex flex-col overflow-hidden bg-app text-primary antialiased"
        style={{ height: "100dvh", paddingBottom: "var(--cm-kb, 0px)" }}
      >
      <TopBar />
      {/* `relative` so the two side drawers can be `absolute` to THIS box rather
          than the viewport — they slide in below the top bar, not over it. It
          adds no layout of its own, so `lg` is untouched. */}
      {/* No bottom-nav reservation here: the bar is a flex SIBLING of this row
          rather than a `fixed` overlay, so the row already stops where the bar
          starts. A reservation plus a `fixed bottom: 0` bar was two independent
          guesses at the same edge — and they disagreed by whatever the layout
          viewport and the dynamic viewport differed by, which is the dead band
          that used to show up between the composer and the bar. */}
      <div className="relative flex min-h-0 flex-1">
        {!fullBleed && (
          <Drawer
            open={leftOpen}
            enabled={mode === "sm"}
            onClose={() => setLeftOpen(false)}
            side="left"
            position="absolute"
            label="Chats and projects"
            className="w-[86vw] max-w-[320px] cm-safe-x"
          >
            <Sidebar />
          </Drawer>
        )}
        <main className="flex min-w-0 flex-1">
          {view === "new-project" ? (
            <NewProjectView />
          ) : view === "memory" ? (
            <MemoryView />
          ) : view === "git" ? (
            <GitView />
          ) : view === "files" ? (
            <FilesView />
          ) : view === "metrics" ? (
            <MetricsView />
          ) : view === "project-settings" ? (
            <ProjectSettingsView />
          ) : view === "app-settings" ? (
            <AppSettingsView />
          ) : chat ? (
            <>
              <ChatView chat={chat} />
              {/* Below `lg` the right panel is off-canvas: a 360px sheet over the
                  transcript at `md`, the full main area at `sm`. It stays MOUNTED
                  either way — it holds scroll positions and a live orphan scan,
                  and unmount-on-close throws both away every time you glance at a
                  worktree. */}
              <Drawer
                open={pane !== "chat"}
                enabled={mode !== "lg"}
                onClose={() => setPane("chat")}
                side="right"
                position="absolute"
                // At `sm` this fills the main area and the bottom nav switches
                // away from it, so it is a PANE, not modal chrome — a scrim you
                // can't see and a focus trap you can't escape would both be
                // furniture.
                modal={mode === "md"}
                label="Ship and run"
                className={cn("cm-safe-x", mode === "sm" ? "w-full" : "w-[360px] max-w-full")}
              >
                <RightPanel chat={chat} />
              </Drawer>
            </>
          ) : (
            <NoChat />
          )}
        </main>
      </div>
      {/* Outside `<main>`, and outside the `<aside>`s: it switches between all
          three of them, so it can't live inside any one. In FLOW as the column's
          last row, so the space it occupies and the space it's given are the
          same measurement rather than two that can drift apart. */}
      <BottomNav chat={chat ?? null} />
      {/* Overlays. Every one of these is open/closed by a single field in the
          view store (see stores/view.ts) rather than by the three bespoke
          window-event buses and two stray useStates this used to take. */}
      <CodeViewerHost />
      <AgentRunHost />
      {/* The file dialog the browser won't give us. Mounted here so `pickPath()`
          works from anywhere without each call site rendering a modal. */}
      <FilePickerHost />
      <WorkspaceView />
      <ProcessesOverlay />
      <McpCatalogView />
      <ManageConfigDialog />
      <Toasts />
      <ViewportDebug />
      {/* An update also stops the server, and "Dispatch has stopped, start it
          from the Start menu" is both wrong and unhelpful halfway through one.
          ShutdownScreen stands down on its own while an update is in flight
          (see its guard) rather than being out-stacked by a screen that now
          lives outside this tree entirely. */}
      <ShutdownScreen />
      </div>
    </AuthGate>
    </>
  );
}
