import { startLiveData, useConnection } from "../stores/index.js";
import { ws } from "./ws.js";

let started = false;

/** Idempotent because first-run setup can enable auth after the open shell booted. */
export function startLiveApp(): void {
  if (started) return;
  started = true;
  // Published to the store so `ConnectingScreen` can tell "we're trying and
  // failing" from "we haven't started" — the latter is what sitting on the
  // sign-in form looks like, and diagnosing a connection nobody asked for yet
  // would put a fault screen over a healthy server.
  useConnection.getState().noteLiveStarted();
  startLiveData();
  ws.connect();
}
