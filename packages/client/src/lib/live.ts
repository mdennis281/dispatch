import { startLiveData, useConnection } from "../stores/index.js";
import { ws } from "./ws.js";
import { startClientPlugins } from "../plugins/start.js";
import { startTtsFeeder } from "./ttsFeeder.js";

let started = false;

/**
 * Idempotent because first-run setup can enable auth after the open shell booted.
 *
 * `shell` is the full app, as opposed to the detached log popup, which calls
 * this too (it needs the socket) and must load neither plugins nor the TTS
 * feeder: it has no composer, no settings rail and no chat to read aloud,
 * and a plugin control registering into a window with nowhere to draw it is
 * a toast about nothing. Both only run once the auth gate has let the app
 * through — this is the chokepoint for boot and for sign-in alike.
 */
export function startLiveApp(opts: { shell?: boolean } = {}): void {
  if (started) return;
  started = true;
  if (opts.shell) {
    startTtsFeeder();
    startClientPlugins();
  }
  // Published to the store so `ConnectingScreen` can tell "we're trying and
  // failing" from "we haven't started" — the latter is what sitting on the
  // sign-in form looks like, and diagnosing a connection nobody asked for yet
  // would put a fault screen over a healthy server.
  useConnection.getState().noteLiveStarted();
  startLiveData();
  ws.connect();
}
