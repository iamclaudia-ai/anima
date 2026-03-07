/**
 * Back-compat re-export.
 *
 * Canonical agent-host protocol types now live in @claudia/shared.
 */

export type {
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
  AgentHostTaskEventMessage as TaskEventMessage,
  AgentHostServerMessage as ServerMessage,
} from "@claudia/shared";
