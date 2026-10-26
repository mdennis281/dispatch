/**
 * The harness interface now lives in `@dispatch/shared` (`harness.ts`), because
 * a provider PLUGIN implements it and a plugin cannot import the server. This
 * re-export keeps the host's own imports where they were.
 */
export type { Harness, HarnessAccount, HarnessAgentSpec, HarnessAssistantEvent, HarnessCapabilities, HarnessCompactedEvent, HarnessDeltaEvent, HarnessEvent, HarnessGuardBlockedEvent, HarnessInitEvent, HarnessInput, HarnessLimitHit, HarnessLimitReadOpts, HarnessLimitWindow, HarnessLimits, HarnessNoticeEvent, HarnessPermissionEvent, HarnessPermissionResolution, HarnessQuestion, HarnessQuestionAnswer, HarnessQuestionEvent, HarnessRuntimeInfo, HarnessSession, HarnessSessionSpec, HarnessSkillSpec, HarnessTaskNotificationEvent, HarnessTextRequest, HarnessToolGuard, HarnessToolGuardContext, HarnessToolPolicy, HarnessToolResultEvent, HarnessToolUseEvent, HarnessTurnEndEvent, HarnessUsageEvent } from "@dispatch/shared";
