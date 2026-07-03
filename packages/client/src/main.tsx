import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import {
  startLiveData,
  hydrateFromMock,
  useConnection,
  useChats,
} from "./stores/index.js";
import { ws } from "./lib/ws.js";
import "./index.css";

// Wire the reactive data spine (active chat → transcript, active project → panels)
// then open the WS. The backend's `hello` triggers the REST hydrate, so live data
// flows into the stores the moment we connect; a reconnect resyncs automatically.
startLiveData();
ws.connect();

// Dev-only fallback: if no backend ever opens the socket, seed the offline mock
// so the shell still renders (design work / screenshots). A real `hello` replaces
// it via hydrateFromServer, so this never masks live data.
if (import.meta.env.DEV) {
  setTimeout(() => {
    const connected = useConnection.getState().state === "open";
    const empty = useChats.getState().order.length === 0;
    if (!connected && empty) hydrateFromMock();
  }, 1200);
}

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
