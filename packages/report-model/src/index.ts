export interface EvidenceQuote {
  quoteId: string;
  sourceId: string;
  excerpt: string;
}

export interface ClusterSummary {
  clusterId: string;
  label: string;
  summary: string;
  evidenceQuotes: EvidenceQuote[];
}

export interface ThemeSummary {
  themeId: string;
  label: string;
  summary: string;
  clusterIds: string[];
}

export interface AnalysisViewReport {
  viewId: string;
  title: string;
  summary: string;
  themes?: ThemeSummary[];
  clusters: ClusterSummary[];
}

export interface ReviewBoundarySummary {
  configPath: string;
  configSha256: string;
  includeCommentStatuses: string[];
  includeOpinionStatuses: string[];
  totalOpinionsAvailable: number;
  includedOpinions: number;
  excludedOpinions: number;
  excludedByStatus: Record<string, number>;
}

export interface ReportBundle {
  reportId: string;
  createdAt: string;
  analysisRunId: string;
  projectName: string;
  questions: string[];
  primaryViewId: string;
  review?: ReviewBoundarySummary;
  views: AnalysisViewReport[];
}

export type StatementKind = "extracted" | "synthesized" | "seed" | "manual";

export type StatementModerationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "hidden_from_public"
  | "excluded_from_analysis";

export type StatementVisibilityStatus = "private" | "admin_only" | "public";

export interface StatementEvidenceRef {
  refId: string;
  refType: "report" | "view" | "theme" | "cluster" | "opinion" | "source";
  analysisRunId?: string;
  reportId?: string;
  viewId?: string;
  themeId?: string;
  clusterId?: string;
  opinionId?: string;
  sourceId?: string;
  quoteId?: string;
  artifactPath?: string;
  excerpt?: string;
}

export interface StatementGenerationProvenance {
  generatedAt: string;
  method: "deterministic-report-highlights" | "manual" | "model-assisted";
  analysisRunId?: string;
  reportId?: string;
  reportBundlePath?: string;
  reportBundleSha256?: string;
  sourceArtifactSha256s?: Record<string, string>;
  prompt?: {
    promptId: string;
    path?: string;
    sha256: string;
  };
  model?: {
    provider: string;
    modelId: string;
    alias?: string;
  };
}

export interface Statement {
  statementId: string;
  statementText: string;
  statementKind: StatementKind;
  moderationStatus: StatementModerationStatus;
  visibilityStatus: StatementVisibilityStatus;
  sourceOpinionIds: string[];
  sourceClusterIds: string[];
  sourceThemeIds: string[];
  evidenceRefs: StatementEvidenceRef[];
  generationRationale: string;
  duplicateOfStatementId?: string;
  createdAt: string;
  provenance: StatementGenerationProvenance;
}

export interface StatementBank {
  statementBankId: string;
  statementRunId: string;
  createdAt: string;
  projectName: string;
  analysisRunId: string;
  reportId: string;
  sourceReportPath: string;
  generationProvenance: StatementGenerationProvenance;
  statements: Statement[];
  counts: {
    total: number;
    byModerationStatus: Record<StatementModerationStatus, number>;
    duplicates: number;
  };
}

export interface StatementRunManifest {
  statementRunId: string;
  createdAt: string;
  updatedAt: string;
  status: "completed" | "completed-with-failures" | "reused";
  fingerprint: {
    sourceReportSha256: string;
    promptSha256: string;
    analysisRunId: string;
    generator: string;
  };
  input: {
    analysisRunId: string;
    reportBundlePath: string;
    reportBundleSha256: string;
  };
  output: {
    statementBankPath: string;
    statementsDir: string;
    statementsGenerated: number;
    statementsWritten: number;
    duplicateStatements: number;
    failedStatements: number;
  };
  failures: Array<{
    source: string;
    message: string;
  }>;
}

export type StatementQaDimension =
  | "evidence-support"
  | "neutral-wording"
  | "single-claim-clarity"
  | "duplicate-risk"
  | "scope-fit"
  | "participant-comprehensibility"
  | "vote-usefulness";

export interface StatementQaCheck {
  dimension: StatementQaDimension;
  status: "pass" | "warning" | "fail";
  score: number;
  rationale: string;
}

export interface StatementQaResult {
  statementId: string;
  statementText: string;
  checks: StatementQaCheck[];
  overallStatus: "pass" | "warning" | "fail";
  overallScore: number;
}

export interface StatementQaScorecard {
  qaRunId: string;
  statementRunId: string;
  createdAt: string;
  statementCount: number;
  totals: {
    pass: number;
    warning: number;
    fail: number;
  };
  results: StatementQaResult[];
}

export interface StatementReviewArtifact {
  statementId: string;
  updatedAt: string;
  actor: {
    type: "human" | "agent";
    name: string;
  };
  moderationStatus: StatementModerationStatus;
  visibilityStatus?: StatementVisibilityStatus;
  statementText?: string;
  note?: string;
}

export type ReactionValue = "agree" | "disagree" | "pass";

export interface ReactionEvent {
  eventId: string;
  createdAt: string;
  voteRoundId: string;
  participantId: string;
  statementId: string;
  reaction: ReactionValue;
  previousReaction?: ReactionValue;
}

export interface ReactionState {
  voteRoundId: string;
  updatedAt: string;
  statements: Array<{
    statementId: string;
    statementText: string;
  }>;
  participants: string[];
  reactions: Record<string, Record<string, ReactionValue>>;
}

export interface VoteRoundManifest {
  voteRoundId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "exported" | "analyzed";
  input: {
    statementBankPath: string;
    statementBankSha256: string;
    statementRunId: string;
    acceptedStatementCount: number;
  };
  output: {
    statementsPath: string;
    reactionEventsPath: string;
    reactionStatePath: string;
    exportsDir: string;
  };
  limits: {
    localOnly: true;
    identity: "anonymous-or-named-local";
    productionUse: "not-production-civic-infrastructure";
  };
}

export interface VoteStatementSummary {
  statementId: string;
  statementText: string;
  evidenceRefs: StatementEvidenceRef[];
  totals: {
    agree: number;
    disagree: number;
    pass: number;
    total: number;
  };
  rates: {
    agree: number;
    disagree: number;
    pass: number;
  };
  classification: "high-consensus" | "high-contention" | "low-participation" | "mixed";
}

export interface VoteRoundSummary {
  voteRoundId: string;
  statementRunId: string;
  createdAt: string;
  participantCount: number;
  statementCount: number;
  statements: VoteStatementSummary[];
  highConsensusStatementIds: string[];
  highContentionStatementIds: string[];
  lowParticipationStatementIds: string[];
  bridgeCandidatePlaceholders: string[];
}

export interface AttestationArtifactRecord {
  artifactId: string;
  artifactKind:
    | "report-bundle"
    | "statement-bank"
    | "source-dataset"
    | "ingest-manifest"
    | "opinion-manifest"
    | "analysis-manifest"
    | "prompt"
    | "generated-artifact";
  path: string;
  sha256: string;
  required: boolean;
}

export interface AttestationManifest {
  attestationId: string;
  createdAt: string;
  subject:
    | {
        kind: "report";
        reportId: string;
        analysisRunId: string;
      }
    | {
        kind: "statements";
        statementRunId: string;
        analysisRunId: string;
      };
  codeVersion: string;
  publicationTimestamp: string;
  modelRefs: Array<{
    alias: string;
    provider: string;
    modelId: string;
    region: string;
  }>;
  artifacts: AttestationArtifactRecord[];
}
