import { startLiveData } from "../stores/index.js";
import { ws } from "./ws.js";

let started = false;

/** Idempotent because first-run setup can enable auth after the open shell booted. */
export function startLiveApp(): void {
  if (started) return;
  started = true;
  startLiveData();
  ws.connect();
}
