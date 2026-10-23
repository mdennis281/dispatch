/**
 * goose's provider descriptor — the static facts the rest of Dispatch labels,
 * picks and accounts it by. Registered with the host by `activate` in
 * `main.ts`. It moved here from `@dispatch/shared` when goose became a
 * shipped plugin, so the host compiles without knowing goose exists.
 */
import type { ModelOption, ProviderDescriptor } from "@dispatch/shared";

/**
 * Seed model list for an ACP agent running local models.
 *
 * Unlike Claude's aliases and Codex's catalogue, these ids belong to whatever
 * Ollama instance the agent is pointed at, so there is no list that is correct
 * for every install. `AcpHarness.listModels` therefore asks Ollama's `/api/tags`
 * for the REAL list and this is only what the picker shows when that endpoint
 * can't be reached — chosen as the models most commonly pulled for agentic
 * coding, so a stale entry degrades to "not on this box" rather than a
 * plausible-looking id that silently 404s at turn start.
 */
export const FALLBACK_MODELS_GOOSE: ModelOption[] = [
  {
    value: "qwen3-coder:30b",
    label: "qwen3-coder:30b",
    hint: "recommended",
    description: "MoE coding model; ~19GB at Q4, fits a 24GB card with room for context.",
  },
  {
    value: "qwen3:30b-a3b-instruct-2507-q4_K_M",
    label: "qwen3:30b-a3b",
    description: "General MoE instruct model with solid tool calling.",
  },
  { value: "devstral:24b", label: "devstral:24b", description: "Tuned for agentic edit loops." },
  { value: "qwen2.5:14b", label: "qwen2.5:14b", hint: "fast", description: "Smaller, quicker, weaker at long tool chains." },
];

export const GOOSE_PROVIDER: ProviderDescriptor = {
  id: "goose",
  label: "goose",
  shortLabel: "goose",
  blurb: "Open-source agent driven over the Agent Client Protocol. Runs local models via Ollama.",
  // No "default" alias: an Ollama model id is concrete, and which ids exist
  // is a fact about the box the models are pulled on. An unpinned chat sends
  // none and lets the agent's own configured model stand.
  fallbackModels: FALLBACK_MODELS_GOOSE,
  // ACP has NO reasoning-effort concept — there is no field on session/new or
  // session/prompt to carry one. Empty rather than a plausible ladder, so the
  // composer hides the control instead of rendering one that does nothing.
  efforts: [],
  subagents: false,
  // goose discovers skills in `.agents/skills` — the same directory Codex
  // uses, verified with `goose skills list`. So `materializeSkills` needs no
  // new branch for this provider.
  skillsDir: ".agents",
  account: {
    // goose resolves its config dir from the platform's config location and
    // honours no override env var (probed: GOOSE_CONFIG_DIR, GOOSE_HOME and
    // XDG_CONFIG_HOME all leave `goose info` pointing at the default). The
    // var below is therefore inert, which is harmless: a local model needs no
    // login, so a directory is not what a second goose account selects.
    //
    // The ENDPOINT is. See `endpointEnv` below: one account is the Ollama on
    // this machine, another is the box with the big GPU, and a chat picks
    // between them exactly the way it picks between two Claude logins.
    configDirEnv: "GOOSE_CONFIG_DIR",
    // Correct on Linux/macOS. Windows keeps it under
    // `AppData/Roaming/Block/goose/config`; the only thing that reads this is
    // the settings pane's "is there a login" dot, which is cosmetic here.
    defaultConfigDir: ".config/goose",
    loginFile: "config.yaml",
    endpointEnv: "OLLAMA_HOST",
    // Ollama's own default. Note this is the SERVER's loopback, not the
    // user's: an install that never sets a host talks to whatever is running
    // beside Dispatch, which is very often not the machine holding the
    // models they meant. That silent mismatch is what accounts fix.
    defaultEndpoint: "http://127.0.0.1:11434",
    endpointLabel: "Ollama host",
  },
};
