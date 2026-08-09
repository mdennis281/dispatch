import { MessageSquareDashed } from "lucide-react";
import { TopBar } from "./components/layout/TopBar.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { ChatView } from "./components/chat/ChatView.js";
import { CodeViewerHost } from "./components/monaco/index.js";
import { AgentRunHost } from "./components/agents/AgentRunHost.js";
import { ProjectPRsView } from "./components/prs/ProjectPRsView.js";
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
import { useView } from "./stores/view.js";

/** Empty state when no chat is selected. */
function NoChat() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-5">
        <MessageSquareDashed />
      </span>
      <p className="text-[13px] font-medium text-secondary">No chat selected</p>
      <p className="mt-0.5 text-[11.5px] text-muted">Pick a chat from the sidebar or start a new one.</p>
    </div>
  );
}

export default function App() {
  const activeChatId = useChats((s) => s.activeChatId);
  const chat = useChats((s) => (activeChatId ? s.byId[activeChatId] : undefined));
  const view = useView((s) => s.view);
  // Project setup is the one surface that isn't ABOUT the active project — it's
  // how a project comes to exist — so it takes the whole window under the top
  // bar. A sidebar listing some other project's chats beside it is noise at
  // best, and at worst reads as "you're editing that one".
  const fullBleed = view === "new-project";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app text-primary antialiased">
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
      <McpCatalogView />
      <ProjectConfigView />
      <SettingsPanel />
      <ManageConfigDialog />
      <Toasts />
      <ShutdownScreen />
    </div>
  );
}
