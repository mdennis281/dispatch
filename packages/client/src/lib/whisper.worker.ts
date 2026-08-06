/**
 * Whisper inference, off the UI thread.
 *
 * Everything it loads is same-origin and vendored into `public/` by
 * `scripts/fetch-whisper.mjs` — weights under `/models/`, the ONNX runtime under
 * `/ort/`. `allowRemoteModels` is false so a missing asset fails loudly at build
 * time instead of silently reaching for a CDN at runtime, which is the whole
 * point of the app being portable.
 *
 * Transcription is a hard block of CPU/GPU work measured in seconds; on the main
 * thread it would freeze the composer mid-dictation, so it lives here and talks
 * over postMessage.
 */
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { WhisperRequest, WhisperResponse } from "./whisperProtocol.js";

/** Must match MODEL in scripts/fetch-whisper.mjs. */
const MODEL = "whisper-base.en";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";
// Typed optional because the onnx backend is only populated once a runtime is
// selected; in a worker it always is, but the guard keeps the build honest.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = "/ort/";

const post = (msg: WhisperResponse): void => self.postMessage(msg);

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let device = "unknown";

/**
 * WebGPU is several times faster than WASM for this model and Electron's
 * Chromium has it — but it fails on some drivers/headless contexts, so a refusal
 * falls back to CPU rather than taking dictation down with it. Both runtimes are
 * vendored, so the fallback costs no download.
 */
async function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr) return asr;
  if (loading) return loading;

  loading = (async () => {
    const opts = {
      dtype: "q8" as const,
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          post({ type: "progress", pct: Math.round(p.progress) });
        }
      },
    };
    try {
      const p = await pipeline("automatic-speech-recognition", MODEL, {
        ...opts,
        device: "webgpu",
      });
      device = "webgpu";
      return p;
    } catch (err) {
      post({
        type: "progress",
        pct: 0,
      });
      console.warn("[whisper] WebGPU unavailable, falling back to wasm:", err);
      const p = await pipeline("automatic-speech-recognition", MODEL, { ...opts, device: "wasm" });
      device = "wasm";
      return p;
    }
  })();

  try {
    asr = await loading;
    return asr;
  } finally {
    loading = null;
  }
}

self.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      await load();
      post({ type: "ready", device });
      return;
    }
    if (msg.type === "transcribe") {
      const model = await load();
      // Dictation is one utterance at a time, so no chunking/striding: the audio
      // is short enough to go through whole, which is both faster and more
      // accurate than windowing it.
      //
      // No `language`/`task` options: this is an English-ONLY checkpoint, and
      // transformers.js throws outright ("Cannot specify `task` or `language`
      // for an English-only model") rather than ignoring them.
      const out = await model(msg.audio);
      const text = Array.isArray(out)
        ? out.map((o) => o.text ?? "").join(" ")
        : (out.text ?? "");
      post({ type: "result", id: msg.id, text: text.trim() });
    }
  } catch (err) {
    post({
      type: "error",
      id: msg.type === "transcribe" ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
