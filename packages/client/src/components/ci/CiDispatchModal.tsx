/**
 * "Run workflow" — trigger a `workflow_dispatch` from the CI/CD page.
 *
 * The picker lists every file-backed, enabled workflow, but whether one can
 * actually be run by hand is only knowable from its YAML. So on open every
 * candidate's YAML is read in parallel: the picker marks the ones without a
 * manual trigger, the default lands on one that has one, and a push-only
 * workflow says so in place of a form — rather than letting the human fill one
 * in and eat a 422 on submit. Each read lands on its own, so a slow workflow
 * file never holds up the one you picked.
 */
import { useEffect, useState } from "react";
import { GitBranch, Play, Workflow } from "lucide-react";
import type { CiDispatchInfo, CiWorkflow } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { useNotices } from "../../stores/notices.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { Field, InlineError, Modal, TextInput } from "../sidebar/Modal.js";
import {
  DispatchInputField,
  collectInputValues,
  missingInputs,
  seedInputValues,
} from "./DispatchInputs.js";

/** Workflows worth offering: a file we can read, and not switched off — in rail order. */
export function runnableWorkflows(workflows: CiWorkflow[]): CiWorkflow[] {
  return workflows
    .filter((w) => !w.managed && w.state === "active")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function CiDispatchModal({
  open,
  onClose,
  projectId,
  workflows,
  initialWorkflowId,
  defaultRef,
  onDispatched,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  workflows: CiWorkflow[];
  initialWorkflowId: number | null;
  defaultRef: string;
  onDispatched: (workflowId: number) => void;
}) {
  const options = runnableWorkflows(workflows);
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  // Picked by the human (or the caller), so a late-arriving read must not move it.
  const [pinned, setPinned] = useState(false);
  const [ref, setRef] = useState(defaultRef);
  const [infos, setInfos] = useState<Record<number, CiDispatchInfo | { error: string }>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Each opening starts from what the page had selected, and re-reads every
  // candidate — a workflow file may have changed since last time.
  useEffect(() => {
    if (!open) return;
    const initial = options.find((w) => w.id === initialWorkflowId)?.id ?? null;
    setWorkflowId(initial ?? options[0]?.id ?? null);
    setPinned(initial !== null);
    setRef(defaultRef);
    setSubmitError(null);
    setInfos({});
    let cancelled = false;
    for (const w of options) {
      api.ci
        .dispatchInfo(projectId, w.id)
        .then((i) => !cancelled && setInfos((m) => ({ ...m, [w.id]: i })))
        .catch(
          (err) =>
            !cancelled &&
            setInfos((m) => ({ ...m, [w.id]: { error: err instanceof Error ? err.message : String(err) } })),
        );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Unpinned, settle on the first workflow (in list order) that can be run by
  // hand — but only once everything above it has answered, or the choice would
  // depend on which request happened to come back first.
  useEffect(() => {
    if (pinned) return;
    for (const w of options) {
      const i = infos[w.id];
      if (!i) return;
      if ("dispatchable" in i && i.dispatchable) {
        setWorkflowId(w.id);
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infos, pinned]);

  const entry = workflowId !== null ? infos[workflowId] : undefined;
  const info = entry && "dispatchable" in entry ? entry : null;
  const infoError = entry && "error" in entry ? entry.error : null;

  // Fresh form values whenever the workflow (or its inputs) changes.
  useEffect(() => {
    setValues(info ? seedInputValues(info.inputs) : {});
  }, [info]);

  const inputs = info?.inputs ?? [];
  const missing = missingInputs(inputs, values);
  const ready =
    !busy && workflowId !== null && !!info?.dispatchable && ref.trim().length > 0 && missing.length === 0;
  const hint = !info
    ? null
    : !ref.trim()
      ? "Enter a branch or tag"
      : missing.length
        ? `${missing.length} required input${missing.length > 1 ? "s" : ""} left`
        : null;

  const submit = async () => {
    if (!ready || workflowId === null) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const collected = collectInputValues(inputs, values);
      await api.ci.dispatch(projectId, workflowId, {
        ref: ref.trim(),
        inputs: Object.keys(collected).length ? collected : undefined,
      });
      const name = options.find((w) => w.id === workflowId)?.name ?? "Workflow";
      useNotices.getState().push({ level: "info", text: `Started ${name} on ${ref.trim()}` });
      onDispatched(workflowId);
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run workflow"
      icon={<Play />}
      description="Trigger a workflow_dispatch run"
      width={460}
      footer={
        <>
          {hint && <span className="text-2xs text-faint">{hint}</span>}
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            leftIcon={busy ? <Spinner size={12} /> : <Play />}
            disabled={!ready}
            onClick={() => void submit()}
          >
            Run
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="text-sm text-muted">This repository has no workflows that can be run by hand.</p>
      ) : (
        <div className="space-y-3.5">
          <Field label="Workflow">
            <Select
              options={options.map((w) => {
                const i = infos[w.id];
                return {
                  value: String(w.id),
                  label: w.name,
                  hint: !i
                    ? "checking…"
                    : "error" in i
                      ? "unreadable"
                      : i.dispatchable
                        ? w.path.split("/").pop()
                        : "no manual trigger",
                };
              })}
              value={String(workflowId ?? "")}
              onChange={(v) => {
                setWorkflowId(Number(v));
                setPinned(true);
              }}
              leftIcon={<Workflow />}
              width={320}
              className="w-full justify-start"
            />
          </Field>
          <Field label="Branch or tag" required>
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <TextInput
                mono
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder={defaultRef}
                spellCheck={false}
                className="pl-8"
              />
            </div>
          </Field>

          {infoError ? (
            <InlineError message={`Couldn't read this workflow: ${infoError}`} />
          ) : !info ? (
            <div className="flex items-center gap-2 text-xs text-faint">
              <Spinner size={12} /> Reading workflow…
            </div>
          ) : !info.dispatchable ? (
            <p className="rounded-md border border-line bg-panel-2/40 px-3 py-2 text-xs text-muted">
              This workflow has no <code className="cm-mono text-secondary">workflow_dispatch</code>{" "}
              trigger, so it can only run from the events it listens for.
            </p>
          ) : inputs.length > 0 ? (
            <div className="space-y-3 border-t border-line-soft pt-3">
              {inputs.map((inp) => (
                <DispatchInputField
                  key={inp.name}
                  input={inp}
                  value={values[inp.name] ?? ""}
                  onChange={(v) => setValues((s) => ({ ...s, [inp.name]: v }))}
                  onEnter={() => void submit()}
                />
              ))}
            </div>
          ) : null}

          <InlineError message={submitError} />
        </div>
      )}
    </Modal>
  );
}
