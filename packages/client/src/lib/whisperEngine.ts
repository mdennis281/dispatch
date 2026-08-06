/**
 * Local Whisper dictation — the engine that works in the desktop app.
 *
 * Web Speech can't run in Electron (measured: the mic opens, then the recognition
 * request dies with `network`, because Electron ships without Chrome's speech
 * service key). This engine has no service to reach: it records, resamples, and
 * transcribes on-device against weights vendored into the app. Nothing leaves the
 * machine and nothing needs a key.
 *
 * The behavioural difference from Web Speech, which the UI has to be honest
 * about: there is no live interim text. Whisper transcribes a finished utterance,
 * so text lands when you stop talking, not while you talk.
 */
import type { DictationEngine, DictationHandlers } from "./speech.js";
// From the protocol module, NOT the worker: importing a value out of the worker
// file would pull transformers.js into the main bundle (see whisperProtocol.ts).
import {
  TARGET_SAMPLE_RATE,
  type WhisperRequest,
  type WhisperResponse,
} from "./whisperProtocol.js";

/**
 * Ignore anything shorter than this. A tap that starts and stops the mic in the
 * same gesture, or a stray push-to-talk key bounce, otherwise sends a fragment of
 * room tone to Whisper — which reliably hallucinates a "thank you" or a "you"
 * from pure silence.
 */
const MIN_CLIP_MS = 350;

/** Decode a recorded blob and resample it to the mono 16 kHz Whisper expects. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  // A plain AudioContext decodes whatever the recorder produced (webm/opus here);
  // the OfflineAudioContext below does the actual rate conversion on render.
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(bytes);
  } finally {
    void decoder.close();
  }

  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Create the local-Whisper engine. Unlike the Web Speech factory this can't fail
 * synchronously on capability grounds — the mic, the worker, and the model are
 * all checked when dictation actually starts.
 */
export function createWhisperDictation(handlers: DictationHandlers): DictationEngine {
  let worker: Worker | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  // The user's intent. A stop() that arrives before getUserMedia resolves has to
  // be able to cancel the session it never saw start.
  let wanted = false;
  let nextId = 1;
  let pending = 0;

  const status = (text: string | null): void => handlers.onStatus?.(text);

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL("./whisper.worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WhisperResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        status(msg.pct > 0 ? `Loading speech model… ${msg.pct}%` : "Loading speech model…");
        return;
      }
      if (msg.type === "ready") return;
      if (msg.type === "result") {
        pending = Math.max(0, pending - 1);
        if (!pending) status(null);
        if (msg.text) handlers.onFinal(msg.text);
        return;
      }
      if (msg.type === "error") {
        pending = Math.max(0, pending - 1);
        if (!pending) status(null);
        handlers.onError(`Transcription failed: ${msg.message}`);
      }
    };
    w.onerror = (e) => {
      pending = 0;
      status(null);
      handlers.onError(`The speech engine failed to start: ${e.message || "worker error"}`);
    };
    worker = w;
    return w;
  };

  const send = (msg: WhisperRequest, transfer?: Transferable[]): void => {
    ensureWorker().postMessage(msg, transfer ?? []);
  };

  /** Release the microphone. Leaving tracks live keeps the OS recording indicator on. */
  const releaseMic = (): void => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
  };

  const finish = async (): Promise<void> => {
    const blob = chunks.length ? new Blob(chunks, { type: chunks[0]!.type }) : null;
    const heldMs = Date.now() - startedAt;
    chunks = [];
    releaseMic();
    handlers.onStopped();

    if (!blob || heldMs < MIN_CLIP_MS) {
      if (!pending) status(null);
      return;
    }

    status("Transcribing…");
    try {
      const audio = await toMono16k(blob);
      pending += 1;
      // Transferred, not copied — the clip can be megabytes of Float32.
      send({ type: "transcribe", id: nextId++, audio }, [audio.buffer]);
    } catch (err) {
      if (!pending) status(null);
      handlers.onError(
        `Could not read the recording: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    start() {
      if (wanted) return;
      wanted = true;
      handlers.onInterim("");
      // Warm the model while they speak: first load is the slow one, and it
      // overlaps entirely with the recording if it starts now.
      send({ type: "load" });

      void (async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          });
          // Stopped during the permission round-trip — don't open a mic nobody asked for.
          if (!wanted) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = s;
          chunks = [];
          startedAt = Date.now();
          const rec = new MediaRecorder(s);
          rec.ondataavailable = (ev) => {
            if (ev.data.size) chunks.push(ev.data);
          };
          rec.onstop = () => void finish();
          rec.start();
          recorder = rec;
        } catch (err) {
          wanted = false;
          releaseMic();
          const name = err instanceof DOMException ? err.name : "";
          handlers.onError(
            name === "NotAllowedError"
              ? "Microphone access was blocked. Allow it and try again."
              : name === "NotFoundError"
                ? "No microphone found. Plug one in (or pick one in your sound settings) and try again."
                : `Could not open the microphone: ${err instanceof Error ? err.message : String(err)}`,
          );
          handlers.onStopped();
        }
      })();
    },

    stop() {
      if (!wanted) return;
      wanted = false;
      handlers.onInterim("");
      if (recorder && recorder.state !== "inactive") {
        // `onstop` runs finish(), which is what actually transcribes.
        recorder.stop();
        return;
      }
      // Never got as far as recording (permission pending, or it failed).
      releaseMic();
      handlers.onStopped();
    },
  };
}
