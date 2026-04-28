/**
 * Compatibility re-export for Anthropic provider image handling.
 */

export {
  processContent,
  processImage,
} from "../../../packages/agent-host/src/providers/anthropic/image-processor";

export type {
  ImageBlock,
  ProcessingResult,
} from "../../../packages/agent-host/src/providers/anthropic/image-processor";
