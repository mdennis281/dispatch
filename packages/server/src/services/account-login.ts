/**
 * Provider sign-ins started from Settings → Accounts — at most one per account.
 *
 * The provider owns the flow (`Harness.startLogin` runs its real CLI); this is
 * only the bookkeeping the routes need: which account a flow is for, what it
 * has shown so far, and what happens when it ends. A finished flow re-probes
 * that account through `ProviderLogins`, so the "not logged in" banner on its
 * chats clears the moment the CLI exits rather than on the next 15 s re-check.
 *
 * In memory on purpose. A restart kills the CLI with the server, so a
 * persisted "running" would be a flow nothing is driving.
 */
import type {
  AccountLoginFlow,
  HarnessLoginFlow,
  HarnessLoginProgress,
  SubscriptionSettings,
} from "@dispatch/shared";
import type { HarnessRegistry } from "../harness/index.js";
import type { ProviderLogins } from "./provider-logins.js";
import { accountOf, subscriptionStatuses } from "./subscriptions.js";

/** How long a finished flow's outcome stays readable, so a poll sees it. */
const KEEP_FINISHED_MS = 5 * 60_000;

export class AccountLoginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Running {
  view: AccountLoginFlow;
  flow?: HarnessLoginFlow;
  finishedAt?: number;
}

export interface AccountLoginsOpts {
  harnesses: HarnessRegistry;
  logins?: ProviderLogins;
  settings: () => Promise<SubscriptionSettings | null | undefined>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class AccountLogins {
  private readonly flows = new Map<string, Running>();
  private readonly now: () => number;

  constructor(private readonly opts: AccountLoginsOpts) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether this provider can sign in from here at all: it brings a flow, and
   * its CLI is on this machine — a button that can only answer "not installed"
   * is not worth offering.
   */
  supports(provider: string): boolean {
    const harness = this.opts.harnesses.find(provider);
    if (typeof harness?.startLogin !== "function") return false;
    const rt = harness.runtime();
    return rt.available && !!rt.path;
  }

  /**
   * Start a sign-in for an account. One already running for it is cancelled
   * first — a second click is "start over", and two CLIs writing one
   * directory's credentials would race.
   */
  async start(subscriptionId: string): Promise<AccountLoginFlow> {
    const settings = await this.opts.settings().catch(() => null);
    // Implicit accounts are not in the stored list, so resolve through the
    // same status list the pane renders from.
    const status = subscriptionStatuses(settings).find((s) => s.id === subscriptionId);
    if (!status) throw new AccountLoginError(404, `No account "${subscriptionId}".`);
    const harness = this.opts.harnesses.find(status.provider);
    if (!harness) throw new AccountLoginError(409, `${status.provider} is not installed or is switched off.`);
    if (!harness.startLogin) {
      throw new AccountLoginError(409, `${status.provider} has no sign-in to run from here.`);
    }
    const rt = harness.runtime();
    if (!rt.available || !rt.path) {
      throw new AccountLoginError(409, `No ${status.provider} executable was found on this machine.`);
    }

    this.cancel(subscriptionId);
    const account = accountOf(status);
    const env = { ...(this.opts.env ?? process.env), ...account.env };
    const view: AccountLoginFlow = {
      subscriptionId,
      provider: status.provider,
      state: "running",
      startedAt: this.now(),
    };
    const entry: Running = { view };
    this.flows.set(subscriptionId, entry);

    const flow = harness.startLogin(rt.path, env);
    entry.flow = flow;
    flow.onProgress((p: HarnessLoginProgress) => {
      if (this.flows.get(subscriptionId) !== entry || view.state !== "running") return;
      Object.assign(view, {
        url: p.url,
        userCode: p.userCode,
        awaitingCode: p.awaitingCode,
        hint: p.hint,
      });
      for (const k of ["url", "userCode", "awaitingCode", "hint"] as const) {
        if (view[k] === undefined) delete view[k];
      }
    });
    void flow.done.then(async (result) => {
      if (view.state === "running") {
        view.state = result.ok ? "succeeded" : "failed";
        if (!result.ok && result.error) view.error = result.error;
      }
      delete view.awaitingCode;
      entry.finishedAt = this.now();
      // The CLI's exit says nothing a probe cannot confirm; ask, so the cache
      // every send is judged by learns the new answer now.
      await this.opts.logins?.refresh(status.provider, account).catch(() => undefined);
    });
    return { ...view };
  }

  /** The flow for an account, or undefined when none ran recently. */
  get(subscriptionId: string): AccountLoginFlow | undefined {
    const entry = this.flows.get(subscriptionId);
    if (!entry) return undefined;
    if (entry.finishedAt !== undefined && this.now() - entry.finishedAt > KEEP_FINISHED_MS) {
      this.flows.delete(subscriptionId);
      return undefined;
    }
    return { ...entry.view };
  }

  /** Relay a code pasted from the sign-in page. */
  submitCode(subscriptionId: string, code: string): AccountLoginFlow {
    const entry = this.flows.get(subscriptionId);
    if (!entry || entry.view.state !== "running") {
      throw new AccountLoginError(409, "No sign-in is running for this account.");
    }
    if (!entry.flow?.submitCode) {
      throw new AccountLoginError(409, "This provider's sign-in does not take a code.");
    }
    entry.flow.submitCode(code);
    return { ...entry.view };
  }

  /** Abandon a running flow. A no-op when none is running. */
  cancel(subscriptionId: string): void {
    const entry = this.flows.get(subscriptionId);
    if (!entry || entry.view.state !== "running") return;
    entry.view.state = "cancelled";
    entry.flow?.cancel();
  }

  /** Kill every CLI still running — the server is going away. */
  dispose(): void {
    for (const id of [...this.flows.keys()]) this.cancel(id);
  }
}
