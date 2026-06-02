export type ShellCommand = {
  id: number;
  name: string;
  argv: string[];
  raw: string;
  startIndex: number;
  endIndex: number;
  pipelineId: number | null;
  pipelineIndex: number | null;
  pipelineLength: number | null;
};

export type ParseResult = {
  ok: boolean;
  hasError: boolean;
  commands: ShellCommand[];
  error?: string;
};

export type PolicyResult = {
  ok: boolean;
  denyReason: string | null;
  skipTokf: boolean;
  fallback?: string;
  warnings: string[];
};
