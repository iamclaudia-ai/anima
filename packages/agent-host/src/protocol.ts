/**
 * Back-compat re-export.
 *
 * Canonical agent-host protocol types now live in @anima/shared.
 */

export type {
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
  AgentHostTaskEventMessage as TaskEventMessage,
  AgentHostServerMessage as ServerMessage,
} from "@anima/shared";
