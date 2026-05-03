export type ArtifactKind =
  | "raw"
  | "normalized"
  | "opinion"
  | "run"
  | "report"
  | "statement"
  | "vote"
  | "attestation";

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  sha256: string;
  createdAt: string;
  sourcePath?: string;
}

export interface PromptRunRecord {
  task: string;
  packId: string;
  modelId: string;
  temperature?: number;
}

export interface RunTimingRecord {
  stage: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface RunManifest {
  id: string;
  projectName: string;
  datasetId: string;
  createdAt: string;
  timings: RunTimingRecord[];
  prompts: PromptRunRecord[];
  notes?: string[];
}
