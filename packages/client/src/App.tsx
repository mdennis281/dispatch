import { MessageSquareDashed } from "lucide-react";
import { TopBar } from "./components/layout/TopBar.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { ChatView } from "./components/chat/ChatView.js";
import { CodeViewerHost } from "./components/monaco/index.js";
import { ProjectPRsView } from "./components/prs/ProjectPRsView.js";
import { McpCatalogView } from "./components/mcp/McpCatalogView.js";
import { ProjectConfigView } from "./components/config/ProjectConfigView.js";
import { Toasts } from "./components/Toasts.js";
import { useChats } from "./stores/chats.js";

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app text-primary antialiased">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1">
          {chat ? (
            <>
              <ChatView chat={chat} />
              <RightPanel chat={chat} />
            </>
          ) : (
            <NoChat />
          )}
        </main>
      </div>
      <CodeViewerHost />
      <ProjectPRsView />
      <McpCatalogView />
      <ProjectConfigView />
      <Toasts />
    </div>
  );
}
