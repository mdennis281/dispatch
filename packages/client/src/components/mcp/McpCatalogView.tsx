/**
 * McpCatalogView — the app-wide MCP catalog overlay. Visualizes every MCP tool
 * endpoint a project's agents can call: the in-process "manager" server plus any
 * external/passthrough servers on the project's config, each tool shown with its
 * qualified name, description, and input-parameter schema.
 *
 * Mounted once in App; open state lives in the view store's `overlay` field
 * (see stores/view.ts). Left pane = server list (grouped Custom vs
 * External, each with a status dot); right pane = the selected server's tools as
 * expandable endpoint cards (params table + raw JSON Schema toggle). Pure REST via
 * the `useMcp` store — fetched on open, on project change, and on Refresh.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Boxes,
  Cpu,
  Wrench,
  Copy,
  Check,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Code2,
  CircleSlash,
} from "lucide-react";
import type {
  McpServerCatalogEntry,
  McpServerStatus,
  McpToolInfo,
} from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { StatusDot, type DotTone } from "../ui/StatusDot.js";
import { useProjects } from "../../stores/projects.js";
import { useMcp, useProjectMcp } from "../../stores/mcp.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { useOverlay } from "../../stores/view.js";

/* --------------------------------------------------------------- status */

const STATUS_META: Record<McpServerStatus, { tone: DotTone; label: string }> = {
  ok: { tone: "success", label: "connected" },
  error: { tone: "danger", label: "error" },
  unconfigured: { tone: "muted", label: "unconfigured" },
};

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
  server,
  active,
  onSelect,
}: {
  server: McpServerCatalogEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = STATUS_META[server.status];
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-accent-line bg-accent-ghost"
          : "border-transparent hover:bg-hover",
      )}
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
            : meta.label}
        </span>
      </span>
    </button>
  );
}

function ServerGroup({
  label,
  icon,
  servers,
  selected,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  servers: McpServerCatalogEntry[];
  selected: string | null;
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
          server={s}
          active={selected === s.name}
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
  const external = useMemo(() => servers.filter((s) => s.kind === "external"), [servers]);

  // Keep a valid selection: default to the first server; clear if it vanished.
  useEffect(() => {
    if (servers.length === 0) return;
    setSelected((cur) => (cur && servers.some((s) => s.name === cur) ? cur : servers[0]!.name));
  }, [servers]);

  const activeServer = servers.find((s) => s.name === selected) ?? null;
  const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);

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
                  }`}
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
          <div className="cm-scroll w-52 shrink-0 space-y-2 overflow-y-auto border-r border-line-soft pr-2">
            <ServerGroup
              label="Custom"
              icon={<Cpu />}
              servers={custom}
              selected={selected}
              onSelect={setSelected}
            />
            <ServerGroup
              label="External"
              icon={<Boxes />}
              servers={external}
              selected={selected}
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

          {/* right — the selected server's tools */}
          <div className="cm-scroll min-w-0 flex-1 overflow-y-auto">
            {!activeServer ? (
              <div className="pt-16 text-center text-sm text-muted">Select a server.</div>
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
