/**
 * Compatibility re-export.
 *
 * The Anthropic Agent SDK runtime lives in agent-host. The session extension
 * keeps this module temporarily so older tests and legacy imports continue to
 * resolve while the provider boundary is being cleaned up.
 */

export {
  SDKSession,
  createSDKSession,
  resumeSDKSession,
} from "../../../packages/agent-host/src/providers/anthropic/sdk-session";

export type {
  CreateSessionOptions,
  ResumeSessionOptions,
  StreamEvent,
} from "../../../packages/agent-host/src/providers/anthropic/sdk-session";
