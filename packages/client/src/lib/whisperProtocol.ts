/**
 * The contract between the composer and the Whisper worker.
 *
 * Deliberately its own module with NO transformers.js import. The engine needs
 * the sample rate and the message shapes; if it took them from the worker file
 * it would pull transformers into the main bundle's import graph, and every page
 * load would ship a megabyte of ML runtime to a user who never dictates. Keeping
 * the shared pieces here is what lets the worker chunk stay lazy.
 */

/** Whisper is trained on 16 kHz mono; anything else transcribes badly or not at all. */
export const TARGET_SAMPLE_RATE = 16_000;

export type WhisperRequest =
  | { type: "load" }
  | { type: "transcribe"; id: number; audio: Float32Array };

export type WhisperResponse =
  | { type: "ready"; device: string }
  | { type: "progress"; pct: number }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id?: number; message: string };
