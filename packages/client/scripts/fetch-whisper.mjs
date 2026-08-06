/**
 * Vendor the offline dictation assets into `public/`, so the built app carries
 * its own speech engine and never touches a CDN at runtime.
 *
 * Two sets of files land here:
 *   - public/models/<MODEL>/…  the Whisper weights + tokenizer, from HuggingFace
 *   - public/ort/…             onnxruntime-web's wasm, copied out of node_modules
 *
 * Runs as the client's prebuild. The desktop payload is a git CLONE that is built
 * in place (tools/desktop/publish.mjs), and the server serves the SPA out of
 * packages/client/dist — so vendoring at build time is what makes the installed
 * app self-contained without committing ~75MB of binaries to the repo.
 *
 * Idempotent: a file whose size already matches the server's is left alone, so
 * rebuilds are instant and an OFFLINE rebuild succeeds as long as a previous run
 * populated the directory.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat, copyFile, writeFile, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..");

/**
 * Whisper `base.en`, int8-quantized: ~75MB for markedly better dictation accuracy
 * than `tiny.en` (~39MB). English-only on purpose — the multilingual variants are
 * larger and measurably worse at English. Swap the id and re-run to change it.
 */
const MODEL = "whisper-base.en";
const REPO = `Xenova/${MODEL}`;
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

const modelDir = join(clientRoot, "public", "models", MODEL);
const ortDir = join(clientRoot, "public", "ort");

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

/**
 * Sidecar of file → byte size for what we last vendored. The skip decision reads
 * THIS rather than asking the network: HuggingFace serves the .onnx weights via
 * an LFS redirect that doesn't answer HEAD usefully, so a remote size check
 * re-downloaded the two largest files on every single build. Recording sizes
 * locally makes a rebuild instant and, more importantly, offline.
 */
const sidecarPath = join(modelDir, ".vendored.json");

async function readSidecar() {
  try {
    return JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch {
    return {};
  }
}

async function fetchFile(rel, sidecar) {
  const dest = join(modelDir, rel);
  await mkdir(dirname(dest), { recursive: true });

  const have = await sizeOf(dest);
  if (have > 0 && sidecar[rel] === have) {
    console.log(`  = ${rel} (${(have / 1e6).toFixed(1)}MB, vendored)`);
    return have;
  }

  const url = `https://huggingface.co/${REPO}/resolve/main/${rel}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${rel}: HTTP ${res.status}`);
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const size = await sizeOf(dest);
  console.log(`  ↓ ${rel} (${(size / 1e6).toFixed(1)}MB)`);
  return size;
}

/**
 * onnxruntime-web ships its wasm inside the npm package; transformers.js expects
 * to load it from a URL. Copying it into `public/ort/` keeps it same-origin and
 * offline, and avoids Vite trying to bundle a multi-megabyte binary.
 */
async function vendorOrt() {
  // Resolved through transformers.js and through onnxruntime-web's OWN export
  // map: it's a transitive dep, so under pnpm it sits in a version-stamped store
  // directory no hardcoded path survives, and its `exports` deliberately hides
  // `./package.json` — but it does publish each wasm as its own subpath.
  let fromOrt;
  try {
    const fromClient = createRequire(join(clientRoot, "package.json"));
    // Neither package exports "./package.json", so we resolve the main entry and
    // walk up to the package root rather than asking for a path they hide.
    let hfDir = dirname(fromClient.resolve("@huggingface/transformers"));
    while ((await sizeOf(join(hfDir, "package.json"))) === -1) {
      const up = dirname(hfDir);
      if (up === hfDir) throw new Error("no package root above the entry point");
      hfDir = up;
    }
    fromOrt = createRequire(join(hfDir, "package.json"));
  } catch (err) {
    console.warn(`  ! could not locate @huggingface/transformers (${err.message}) — run pnpm install`);
    return;
  }

  // The plain build is the CPU path; `jsep` is the WebGPU one. Both are vendored
  // so the engine can prefer the GPU and fall back without a second download.
  const wanted = [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ];

  await mkdir(ortDir, { recursive: true });
  let copied = 0;
  let bytes = 0;
  for (const n of wanted) {
    let from;
    try {
      from = fromOrt.resolve(`onnxruntime-web/${n}`);
    } catch {
      console.warn(`  ! ort: ${n} is not exported by this onnxruntime-web — skipped`);
      continue;
    }
    const to = join(ortDir, n);
    const size = await sizeOf(from);
    bytes += size;
    if ((await sizeOf(to)) === size) continue;
    await copyFile(from, to);
    copied += 1;
  }
  console.log(`  ↓ ort: ${wanted.length} file(s), ${copied} copied (${(bytes / 1e6).toFixed(0)}MB)`);
}

async function main() {
  console.log(`[whisper] vendoring ${REPO} → public/models/${MODEL}`);
  await mkdir(modelDir, { recursive: true });
  const sidecar = await readSidecar();
  try {
    for (const f of FILES) sidecar[f] = await fetchFile(f, sidecar);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    await vendorOrt();
  } catch (err) {
    // Offline with a populated cache is a legitimate build; offline WITHOUT one
    // is not, and shipping a half-vendored model would fail at first dictation.
    const present = await Promise.all(FILES.map((f) => sizeOf(join(modelDir, f))));
    if (present.every((s) => s > 0)) {
      console.warn(`[whisper] ${err.message} — using the vendored copy already on disk`);
      await vendorOrt().catch(() => {});
      return;
    }
    console.error(`[whisper] could not vendor the model: ${err.message}`);
    console.error("[whisper] a first build needs network access to huggingface.co");
    process.exit(1);
  }
  // Lets the client assert at runtime that it's loading what this build vendored.
  await writeFile(join(clientRoot, "public", "models", "manifest.json"), `${JSON.stringify({ model: MODEL, files: FILES }, null, 2)}\n`);
  console.log("[whisper] done");
}

await main();
