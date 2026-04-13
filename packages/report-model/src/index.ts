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

export interface PerspectiveReport {
  perspectiveId: string;
  title: string;
  summary: string;
  clusters: ClusterSummary[];
}

export interface ReportBundle {
  reportId: string;
  projectName: string;
  guidingQuestions: string[];
  primaryPerspectiveId: string;
  perspectives: PerspectiveReport[];
}
