import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ShellTranscriptFilter } from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { ShellFilterPanel } from "./ShellFilterPanel.js";
import { api } from "../../lib/api.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { useSettings } from "../../stores/settings.js";
import {
  SHELL_FILTER_OPTIONS,
  shellFilterSourceLabel,
  type ResolvedShellFilter,
} from "../../lib/shellFilter.js";

type Scope = "chat" | "project" | "app";

export function ShellFilterModal({
  open,
  onClose,
  chatId,
  resolved,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  resolved: ResolvedShellFilter;
}) {
  const [scope, setScope] = useState<Scope>("chat");
  const [chat, setChat] = useState<ShellTranscriptFilter | undefined>();
  const [project, setProject] = useState<ShellTranscriptFilter | undefined>();
  const [app, setApp] = useState<ShellTranscriptFilter>(resolved.app);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChat(resolved.chat);
    setProject(resolved.project);
    setApp(resolved.app);
    setError(null);
  }, [open, resolved.chat, resolved.project, resolved.app]);

  // Same array, different identity, is not an edit. Without this the Save wrote
  // all three layers every time — including a full `PUT /api/settings` and a
  // manifest write for scopes you never opened.
  const same = (a: ShellTranscriptFilter | undefined, b: ShellTranscriptFilter | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);
  const chatDirty = !same(chat, resolved.chat);
  const projectDirty = !same(project, resolved.project);
  const appDirty = !same(app, resolved.app);
  const dirty = chatDirty || projectDirty || appDirty;

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      if (appDirty) {
        // Read-modify-write: `PUT /api/settings` is a full replace, so the
        // fetch is what keeps every other app setting alive.
        const currentSettings = await api.settings.get();
        const savedSettings = await api.settings.update({ ...currentSettings, shellFilter: app });
        useSettings.getState().apply(savedSettings);
      }
      if (projectDirty && resolved.projectId) {
        const savedProject = await api.projectConfig.saveShellFilter(resolved.projectId, project);
        useProjects.getState().upsertProject(savedProject.project);
      }
      if (chatDirty) {
        const savedChat = await api.chats.update(chatId, { shellFilter: chat ?? null });
        useChats.getState().upsertChat(savedChat);
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const parentForProject = app;
  const parentForChat = project ?? app;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={500}
      icon={<SlidersHorizontal />}
      title="Transcript visibility"
      description="Choose which tool exchanges and reasoning stay in the transcript."
      footer={
        <>
          {error && <div className="mr-auto min-w-0 flex-1"><InlineError message={error} /></div>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save filters"}</Button>
        </>
      }
    >
      {/* Which layer is actually answering. Three panels that each look
          authoritative is how you end up editing App defaults for an hour while
          a project pin quietly wins — the chain only resolves in one direction
          and the UI has to say which end of it you are looking at. */}
      <p className="mb-2 text-xs text-muted">
        This chat shows{" "}
        <span className="text-secondary">
          {resolved.enabled.length} of {SHELL_FILTER_OPTIONS.length}
        </span>
        , {shellFilterSourceLabel(resolved.source)}.
        {resolved.source === "app" && " A project or chat pin would override it."}
      </p>
      <SegmentedControl
        className="mb-3 w-full"
        size="md"
        value={scope}
        onChange={setScope}
        segments={[
          { value: "chat", label: "This chat" },
          { value: "project", label: "This project" },
          { value: "app", label: "App defaults" },
        ]}
      />
      {scope === "chat" && <ShellFilterPanel value={chat} inherited={parentForChat} onChange={setChat} parentLabel="project defaults" />}
      {scope === "project" && <ShellFilterPanel value={project} inherited={parentForProject} onChange={setProject} parentLabel="app defaults" />}
      {scope === "app" && <ShellFilterPanel value={app} inherited={app} onChange={(next) => setApp(next ?? app)} />}
    </Modal>
  );
}
