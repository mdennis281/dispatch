import { MessageSquareDashed } from "lucide-react";
import { TopBar } from "./components/layout/TopBar.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { ChatView } from "./components/chat/ChatView.js";
import { CodeViewerHost } from "./components/monaco/index.js";
import { AgentRunHost } from "./components/agents/AgentRunHost.js";
import { ProjectPRsView } from "./components/prs/ProjectPRsView.js";
import { ProcessesOverlay } from "./components/panels/ProcessesOverlay.js";
import { McpCatalogView } from "./components/mcp/McpCatalogView.js";
import { ProjectConfigView } from "./components/config/ProjectConfigView.js";
import { NewProjectView } from "./components/project/NewProjectView.js";
import { MemoryView } from "./components/memory/MemoryView.js";
import { GitView } from "./components/git/GitView.js";
import { SettingsPanel } from "./components/settings/SettingsPanel.js";
import { ManageConfigDialog } from "./components/sidebar/ManageConfigDialog.js";
import { Toasts } from "./components/Toasts.js";
import { ShutdownScreen } from "./components/ShutdownScreen.js";
import { useChats } from "./stores/chats.js";
import { useProjects, useActiveProject } from "./stores/projects.js";
import { visibleChat } from "./stores/navigation.js";
import { useView } from "./stores/view.js";
import { AuthGate } from "./components/auth/AuthGate.js";

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

  return (
    <AuthGate>
      {/* `100dvh`, not `100vh`. On mobile Safari `vh` is pinned to the LARGEST
          viewport (URL bar retracted), so a `h-screen` app column is taller than
          the window whenever the bar is showing — and since this column is
          `overflow-hidden` with the composer at its bottom, the difference isn't
          a scroll, it's the composer being cut off the bottom of the screen.
          `dvh` tracks the live viewport. */}
      <div className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-app text-primary antialiased">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {!fullBleed && <Sidebar />}
        <main className="flex min-w-0 flex-1">
          {view === "new-project" ? (
            <NewProjectView />
          ) : view === "memory" ? (
            <MemoryView />
          ) : view === "git" ? (
            <GitView />
          ) : chat ? (
            <>
              <ChatView chat={chat} />
              <RightPanel chat={chat} />
            </>
          ) : (
            <NoChat />
          )}
        </main>
      </div>
      {/* Overlays. Every one of these is open/closed by a single field in the
          view store (see stores/view.ts) rather than by the three bespoke
          window-event buses and two stray useStates this used to take. */}
      <CodeViewerHost />
      <AgentRunHost />
      <ProjectPRsView />
      <ProcessesOverlay />
      <McpCatalogView />
      <ProjectConfigView />
      <SettingsPanel />
      <ManageConfigDialog />
      <Toasts />
      <ShutdownScreen />
      </div>
    </AuthGate>
  );
}
