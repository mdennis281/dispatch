/**
 * McpCatalogView — the app-wide MCP catalog overlay. Visualizes every MCP tool
 * endpoint a project's agents can call: the in-process "manager" server, the
 * BUNDLED servers Dispatch injects on the project's behalf (playwright and
 * chrome-devtools), and any external/passthrough servers on the project's
 * config — each tool shown with its qualified name, description, and
 * input-parameter schema.
 *
 * The bundled pair used to be missing from here entirely, which made this
 * screen quietly dishonest: it claimed to list "every MCP endpoint available"
 * while 53 of the tools an agent actually gets were injected somewhere else and
 * never mentioned. They are ordinary rows now, with a `bundled` group of their
 * own so their provenance is still legible.
 *
 * Every server also carries an on/off SWITCH, resolved across two layers — this
 * install (`App`) and this repo's committed `.dispatch/project.yaml` (`Project`).
 * One scope picker decides which layer a click writes; the switch itself always
 * shows what actually happens, and the detail pane spells out which layer
 * decided that. A server switched off is still listed, because this is also the
 * only place to switch it back on.
 *
 * Mounted once in App; open state lives in the view store's `overlay` field
 * (see stores/view.ts). Left pane = server list (grouped Custom / Bundled /
 * External, each with a status dot and a switch); right pane = the selected
 * server's enablement block plus its tools as expandable endpoint cards (params
 * table + raw JSON Schema toggle). Pure REST via the `useMcp` store — fetched on
 * open, on project change, on Refresh, and re-returned by every toggle write.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Boxes,
  Cpu,
  Globe,
  Wrench,
  Copy,
  Check,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Code2,
  CircleSlash,
  PowerOff,
  RotateCcw,
} from "lucide-react";
import type {
  McpEnablementScope,
  McpServerCatalogEntry,
  McpServerStatus,
  McpToolInfo,
} from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Spinner } from "../ui/Spinner.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { Switch } from "../ui/Switch.js";
import { Tooltip } from "../ui/Tooltip.js";
import { useProjects } from "../../stores/projects.js";
import { useMcp, useMcpTogglePending, useProjectMcp } from "../../stores/mcp.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { useOverlay } from "../../stores/view.js";

/* --------------------------------------------------------------- status */

const STATUS_META: Record<McpServerStatus, { tone: DotTone; label: string }> = {
  ok: { tone: "success", label: "connected" },
  error: { tone: "danger", label: "error" },
  unconfigured: { tone: "muted", label: "unconfigured" },
  // Not an error and not a failure to connect — a deliberate choice, and the
  // one status where an empty tool list is the correct answer.
  disabled: { tone: "muted", label: "off" },
};

/* ------------------------------------------------------------- enablement */

const SCOPE_LABEL: Record<McpEnablementScope, string> = {
  app: "this install",
  project: "this repo",
};

/** Where a server's resolved state came from, as a sentence fragment. */
function sourceLabel(server: McpServerCatalogEntry): string {
  const { enablement } = server;
  if (enablement.alwaysOn) return "always on";
  if (enablement.source === "default") return enablement.byDefault ? "on" : "off";
  return `${enablement.effective ? "on" : "off"} · ${enablement.source}`;
}

/**
 * One server's switch, writing at the CURRENT scope.
 *
 * The switch shows the EFFECTIVE state, not the current scope's pin — what an
 * agent actually gets is the only thing worth reading at a glance. Flipping it
 * writes an explicit pin at this scope; the ↺ beside it removes that pin so the
 * server inherits again (from the app layer, then from its own default).
 */
function ServerToggle({
  projectId,
  server,
  scope,
  compact,
}: {
  projectId: string;
  server: McpServerCatalogEntry;
  scope: McpEnablementScope;
  compact?: boolean;
}) {
  const pending = useMcpTogglePending(projectId, server.name);
  const { enablement } = server;
  const pinned = scope === "app" ? enablement.app : enablement.project;

  if (enablement.alwaysOn) {
    return (
      <Tooltip
        label={`${server.name} is how agents create PRs, record memory and write this very setting — it can't be switched off.`}
      >
        <Chip tone="muted">always on</Chip>
      </Tooltip>
    );
  }

  const set = (enabled: boolean | null) =>
    void useMcp.getState().setEnabled(projectId, server.name, scope, enabled);

  return (
    <span
      className="flex shrink-0 items-center gap-1"
      // The row behind this is a select-this-server button; without stopping
      // here, every toggle would also change the selection under the cursor.
      onClick={(e) => e.stopPropagation()}
    >
      {typeof pinned === "boolean" && (
        <IconButton
          onClick={() => set(null)}
          disabled={pending}
          tip={`Pinned ${pinned ? "on" : "off"} for ${SCOPE_LABEL[scope]} — clear to inherit`}
          aria-label={`Clear the ${scope} override for ${server.name}`}
          className="size-5 text-faint [&_svg]:size-3"
        >
          <RotateCcw />
        </IconButton>
      )}
      {pending ? (
        <Spinner size={12} />
      ) : (
        <Switch
          checked={enablement.effective}
          onChange={(v) => set(v)}
          label=""
          ariaLabel={`${enablement.effective ? "Disable" : "Enable"} ${server.name} for ${SCOPE_LABEL[scope]}`}
        />
      )}
      {!compact && (
        <span className="text-2xs text-faint">{enablement.effective ? "on" : "off"}</span>
      )}
    </span>
  );
}

/** The detail pane's "why is it on/off, and what would change it" block. */
function EnablementPanel({
  projectId,
  server,
  scope,
}: {
  projectId: string;
  server: McpServerCatalogEntry;
  scope: McpEnablementScope;
}) {
  const { enablement } = server;
  const rows: Array<{ label: string; value: string; won: boolean }> = [
    {
      label: "Project",
      value: pinText(enablement.project),
      won: enablement.source === "project",
    },
    { label: "App", value: pinText(enablement.app), won: enablement.source === "app" },
    {
      label: "Default",
      value: enablement.byDefault ? "on" : "off",
      won: enablement.source === "default",
    },
  ];
  return (
    <div className="rounded-md border border-line bg-panel-2/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-secondary">
          {enablement.effective
            ? "Running in every session in this project"
            : "Not handed to any session — its tools cost nothing"}
        </span>
        <ServerToggle projectId={projectId} server={server} scope={scope} />
      </div>
      {!enablement.alwaysOn && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {rows.map((r) => (
              <span key={r.label} className="inline-flex items-center gap-1 text-2xs">
                <span className="text-faint">{r.label}</span>
                <span className={r.won ? "font-medium text-accent-hi" : "text-muted"}>
                  {r.value}
                </span>
                {r.won && <span className="text-2xs text-faint">← wins</span>}
              </span>
            ))}
          </div>
          {server.defaultReason && (
            <p className="mt-1.5 text-2xs leading-snug text-faint">{server.defaultReason}</p>
          )}
        </>
      )}
    </div>
  );
}

/** A layer's pin as text — the empty case is "inherit", not "off". */
function pinText(pin: boolean | undefined): string {
  if (pin === undefined) return "—";
  return pin ? "on" : "off";
}

/* ------------------------------------------------------------- copy button */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Copy qualified name"
      className="shrink-0 text-faint transition-colors hover:text-secondary [&_svg]:size-3"
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </button>
  );
}

/* ------------------------------------------------------------- params table */

function ParamsTable({ params }: { params: McpToolInfo["params"] }) {
  if (params.length === 0) {
    return <p className="text-xs text-faint">No parameters.</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-line-soft">
      <div className="grid grid-cols-[1.2fr_0.9fr_auto] gap-x-3 bg-panel-2/60 px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
        <span>Name</span>
        <span>Type</span>
        <span>Req</span>
      </div>
      {params.map((p) => (
        <div
          key={p.name}
          className="grid grid-cols-[1.2fr_0.9fr_auto] items-start gap-x-3 border-t border-line-soft px-2.5 py-1.5"
        >
          <span className="min-w-0">
            <span className="block cm-mono !text-xs text-primary">{p.name}</span>
            {p.description && (
              <span className="mt-0.5 block text-2xs leading-snug text-muted">
                {p.description}
              </span>
            )}
          </span>
          <span className="cm-mono !text-2xs text-accent-hi">{p.type}</span>
          <span className="text-2xs">
            {p.required ? (
              <span className="text-danger">yes</span>
            ) : (
              <span className="text-faint">no</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ endpoint card */

function EndpointCard({ tool }: { tool: McpToolInfo }) {
  const [open, setOpen] = useState(false);
  const [showSchema, setShowSchema] = useState(false);

  return (
    <div
      className={cn(
        "rounded-md border border-line bg-panel-2/40 transition-colors hover:border-line-strong",
        !tool.available && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-faint" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
          )}
          <Wrench className="size-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate cm-mono !text-xs font-medium text-primary">
              {tool.qualifiedName}
            </span>
            {tool.description && !open && (
              <span className="block truncate text-2xs text-faint">{tool.description}</span>
            )}
          </span>
        </button>
        {!tool.available && <Chip tone="muted">unavailable</Chip>}
        <Chip tone="muted" mono>
          {tool.params.length} param{tool.params.length === 1 ? "" : "s"}
        </Chip>
        <CopyButton text={tool.qualifiedName} />
      </div>

      {open && (
        <div className="space-y-2.5 border-t border-line-soft px-3 py-2.5">
          {tool.description && (
            <p className="text-xs leading-relaxed text-secondary">{tool.description}</p>
          )}
          <ParamsTable params={tool.params} />
          <div>
            <button
              onClick={() => setShowSchema((v) => !v)}
              className="inline-flex items-center gap-1 text-2xs font-medium text-muted transition-colors hover:text-secondary [&_svg]:size-3"
            >
              <Code2 />
              {showSchema ? "Hide raw schema" : "Raw schema"}
            </button>
            {showSchema && (
              <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-line-soft bg-inset px-2.5 py-2 cm-mono !text-2xs leading-relaxed text-secondary">
                {JSON.stringify(tool.inputSchema, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- server list */

function ServerButton({
  projectId,
  server,
  active,
  scope,
  onSelect,
}: {
  projectId: string;
  server: McpServerCatalogEntry;
  active: boolean;
  scope: McpEnablementScope;
  onSelect: () => void;
}) {
  const meta = STATUS_META[server.status];
  const off = !server.enablement.effective;
  return (
    // A row, not one big button: the switch on the right is itself a control, and
    // a button inside a button is invalid markup that keyboard users can't reach.
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
        active ? "border-accent-line bg-accent-ghost" : "border-transparent hover:bg-hover",
      )}
    >
      <button
        onClick={onSelect}
        className={cn("flex min-w-0 flex-1 items-center gap-2 text-left", off && "opacity-60")}
      >
        <StatusDot tone={meta.tone} size={7} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate cm-mono !text-xs font-medium",
              active ? "text-accent-hi" : "text-primary",
            )}
          >
            {server.name}
          </span>
          <span className="block truncate text-2xs text-faint">
            {server.status === "ok"
              ? `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
              : server.status === "disabled"
                ? sourceLabel(server)
                : meta.label}
          </span>
        </span>
      </button>
      <ServerToggle projectId={projectId} server={server} scope={scope} compact />
    </div>
  );
}

function ServerGroup({
  projectId,
  label,
  icon,
  servers,
  selected,
  scope,
  onSelect,
}: {
  projectId: string;
  label: string;
  icon: React.ReactNode;
  servers: McpServerCatalogEntry[];
  selected: string | null;
  scope: McpEnablementScope;
  onSelect: (name: string) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 pt-1 text-2xs font-semibold uppercase tracking-[0.09em] text-faint [&_svg]:size-3">
        {icon}
        {label}
      </div>
      {servers.map((s) => (
        <ServerButton
          key={s.name}
          projectId={projectId}
          server={s}
          active={selected === s.name}
          scope={scope}
          onSelect={() => onSelect(s.name)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ overlay */

export function McpCatalogView() {
  const { open, close } = useOverlay("mcp");
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const projectId = project?.id ?? null;
  const { catalog, loading, error } = useProjectMcp(projectId);

  const [selected, setSelected] = useState<string | null>(null);
  // Project-scoped by default: this overlay is about one project, and a decision
  // that belongs to the repo should be the one you make without thinking. App
  // scope is the deliberate step, because it silently changes every project.
  const [scope, setScope] = useState<McpEnablementScope>("project");

  const load = useCallback(
    (fresh?: boolean) => {
      if (projectId) void useMcp.getState().load(projectId, { fresh });
    },
    [projectId],
  );

  // (Re)fetch whenever the overlay opens or the active project changes while open.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const servers = catalog?.servers ?? [];
  const custom = useMemo(() => servers.filter((s) => s.kind === "custom"), [servers]);
  const bundled = useMemo(() => servers.filter((s) => s.kind === "bundled"), [servers]);
  const external = useMemo(() => servers.filter((s) => s.kind === "external"), [servers]);

  // Keep a valid selection: default to the first server; clear if it vanished.
  useEffect(() => {
    if (servers.length === 0) return;
    setSelected((cur) => (cur && servers.some((s) => s.name === cur) ? cur : servers[0]!.name));
  }, [servers]);

  const activeServer = servers.find((s) => s.name === selected) ?? null;
  const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);
  const offCount = servers.filter((s) => !s.enablement.effective).length;

  return (
    <Modal
      open={open}
      onClose={close}
      width={920}
      icon={<Blocks />}
      title="MCP tools"
      description={
        project ? `Every MCP endpoint available in ${project.name}` : "No project selected"
      }
      footer={
        <>
          {error ? (
            <div className="mr-auto min-w-0 flex-1">
              <InlineError message={error} />
            </div>
          ) : (
            <span className="mr-auto text-xs text-muted tabular-nums">
              {loading && servers.length === 0
                ? "Loading…"
                : `${servers.length} server${servers.length === 1 ? "" : "s"} · ${toolCount} tool${
                    toolCount === 1 ? "" : "s"
                  }${offCount ? ` · ${offCount} off` : ""}`}
            </span>
          )}
          <Button
            variant="default"
            leftIcon={loading ? <Spinner size={12} /> : <RefreshCw />}
            disabled={loading || !projectId}
            onClick={() => load(true)}
          >
            Refresh
          </Button>
        </>
      }
    >
      {!projectId ? (
        <div className="rounded-md border border-dashed border-line px-3 py-10 text-center">
          <Blocks className="mx-auto mb-1.5 size-5 text-faint" />
          <p className="text-sm text-muted">No active project.</p>
          <p className="mt-0.5 text-xs text-faint">Pick a project to see its MCP tools.</p>
        </div>
      ) : loading && servers.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner size={14} /> Probing MCP servers…
        </div>
      ) : (
        <div className="flex h-[60vh] gap-3">
          {/* left — server list */}
          <div className="cm-scroll w-64 shrink-0 space-y-2 overflow-y-auto border-r border-line-soft pr-2">
            {/* One picker for every switch below it: which LAYER a click writes.
                Per-row scope pickers would mean reading the scope off each row
                to know what you were about to change. */}
            <div className="space-y-1 px-1 pb-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
                  Toggles apply to
                </span>
              </div>
              <SegmentedControl
                segments={[
                  { value: "project", label: "Project" },
                  { value: "app", label: "App" },
                ]}
                value={scope}
                onChange={setScope}
                className="w-full [&>button]:flex-1"
              />
              <p className="text-2xs leading-snug text-faint">
                {scope === "project"
                  ? "Committed to .dispatch/project.yaml — everyone on this repo."
                  : "Saved to this install only, across every project. Never committed."}
              </p>
            </div>
            <ServerGroup
              projectId={projectId}
              label="Custom"
              icon={<Cpu />}
              servers={custom}
              selected={selected}
              scope={scope}
              onSelect={setSelected}
            />
            <ServerGroup
              projectId={projectId}
              label="Bundled"
              icon={<Globe />}
              servers={bundled}
              selected={selected}
              scope={scope}
              onSelect={setSelected}
            />
            <ServerGroup
              projectId={projectId}
              label="External"
              icon={<Boxes />}
              servers={external}
              selected={selected}
              scope={scope}
              onSelect={setSelected}
            />
            {external.length === 0 && (
              // The catalog is where you come to check whether a server is wired
              // up, so it's also where you find out how to wire one up. Both
              // supported paths write the same `.dispatch/project.yaml`.
              <div className="space-y-1 px-1 pt-1">
                <p className="text-2xs leading-snug text-faint">
                  No external MCP servers configured for this project.
                </p>
                <p className="text-2xs leading-snug text-faint">
                  Add one from a terminal at the repo root:
                </p>
                <code className="block break-all rounded-md border border-line-soft bg-inset px-1.5 py-1 cm-mono !text-2xs leading-snug text-secondary">
                  cm mcp add &lt;name&gt; -- &lt;command&gt;
                </code>
                <p className="text-2xs leading-snug text-faint">
                  …or just ask an agent in this project to add it.
                </p>
              </div>
            )}
          </div>

          {/* right — the selected server's enablement, then its tools */}
          <div className="cm-scroll min-w-0 flex-1 space-y-2 overflow-y-auto">
            {!activeServer ? (
              <div className="pt-16 text-center text-sm text-muted">Select a server.</div>
            ) : (
              <EnablementPanel projectId={projectId} server={activeServer} scope={scope} />
            )}
            {!activeServer ? null : activeServer.status === "disabled" ? (
              <div className="rounded-md border border-dashed border-line px-3 py-8 text-center">
                <PowerOff className="mx-auto mb-1.5 size-5 text-faint" />
                <p className="text-sm text-muted">“{activeServer.name}” is switched off.</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-faint">
                  It isn’t started for any session here, so its tools cost no context and
                  weren’t listed. Switch it on to see them.
                </p>
              </div>
            ) : activeServer.status === "error" ? (
              <div className="rounded-md border border-danger/30 bg-danger-ghost px-3 py-8 text-center">
                <CircleSlash className="mx-auto mb-1.5 size-5 text-danger" />
                <p className="text-sm text-danger">Could not connect to “{activeServer.name}”.</p>
                {activeServer.error && (
                  <p className="mx-auto mt-1 max-w-md break-words text-xs text-muted">
                    {activeServer.error}
                  </p>
                )}
              </div>
            ) : activeServer.tools.length === 0 ? (
              <div className="pt-16 text-center text-sm text-muted">
                {activeServer.status === "unconfigured"
                  ? "This server has no transport configured."
                  : "This server exposes no tools."}
              </div>
            ) : (
              <div className="space-y-2 pr-0.5">
                {activeServer.transport && (
                  <div className="flex flex-wrap items-center gap-1.5 pb-0.5">
                    <Chip tone="info" mono>
                      {activeServer.transport.type}
                    </Chip>
                    {activeServer.transport.command && (
                      <span className="cm-mono !text-2xs text-faint">
                        {activeServer.transport.command}
                        {activeServer.transport.args?.length
                          ? ` ${activeServer.transport.args.join(" ")}`
                          : ""}
                      </span>
                    )}
                    {activeServer.transport.url && (
                      <span className="cm-mono !text-2xs text-faint">
                        {activeServer.transport.url}
                      </span>
                    )}
                  </div>
                )}
                {activeServer.tools.map((t) => (
                  <EndpointCard key={t.qualifiedName} tool={t} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
