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
import { RunnerLogWindow } from "./components/panels/RunnerLogWindow.js";
import "./index.css";

// A detached log window (opened via openRunnerLogWindow) loads this same bundle
// with `?logs=<runnerId>` — render only the read-only log terminal for it.
const isLogWindow = new URLSearchParams(location.search).has("logs");

// Wire the reactive data spine (active chat → transcript, active project → panels)
// then open the WS. The backend's `hello` triggers the REST hydrate, so live data
// flows into the stores the moment we connect; a reconnect resyncs automatically.
startLiveData();
ws.connect();

// Dev-only fallback: if no backend ever opens the socket, seed the offline mock
// so the shell still renders (design work / screenshots). A real `hello` replaces
// it via hydrateFromServer, so this never masks live data. Skipped for a log
// window, which must reflect the real backend (never mock output).
if (import.meta.env.DEV && !isLogWindow) {
  setTimeout(() => {
    const connected = useConnection.getState().state === "open";
    const empty = useChats.getState().order.length === 0;
    if (!connected && empty) hydrateFromMock();
  }, 1200);
}

// Register the service worker that makes this installable (see public/sw.js).
// Production only: in dev it would sit in front of Vite's module graph and serve
// a stale shell after an HMR-triggered reload. A log window is a child popup of
// an already-registered client and has nothing to add.
if (import.meta.env.PROD && !isLogWindow && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      // Not fatal — the app runs fine unregistered, it just isn't installable.
      console.warn("[dispatch] service worker registration failed:", err);
    });
  });
}

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>{isLogWindow ? <RunnerLogWindow /> : <App />}</StrictMode>,
);
