export type SelectionConfidence = "high" | "medium" | "low";

export interface FileSelection {
  file: string;
  ranges?: { start: number; end: number }[];
  symbols?: string[];
  reason: string;
  confidence?: SelectionConfidence;
}

export interface ToolExecution {
  name: string;
  args: any;
  durationMs?: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface TurboreadDetails {
  query: string;
  hints?: string;
  iterations: number;
  maxIterations: number;
  toolCalls: ToolExecution[];
  usage: UsageStats;
  model: string;
  status: "running" | "done" | "error";
  summary?: string[];
  rangeCount?: number;
  fileCount?: number;
  selections?: { file: string; reason: string }[];
  notFound?: string[];
}

export interface FileSelectionMeta {
  file: string;
  totalLines: number;
  selectedLines?: number;
  estimatedTokens: number;
  ranges?: { start: number; end: number }[];
  symbols?: string[];
  reason: string;
  confidence?: SelectionConfidence;
  queryCount?: number;
  shared?: boolean;
  fallbackUsed?: boolean;
  fullFile?: boolean;
}

export interface MiniAgentResult {
  summary: string[];
  files: FileSelection[];
  notFound?: string[];
  usage: UsageStats;
  iterations: number;
  toolCalls: ToolExecution[];
}
