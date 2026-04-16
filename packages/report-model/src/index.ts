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

export interface ReportBundle {
  reportId: string;
  createdAt: string;
  analysisRunId: string;
  projectName: string;
  questions: string[];
  primaryViewId: string;
  views: AnalysisViewReport[];
}
