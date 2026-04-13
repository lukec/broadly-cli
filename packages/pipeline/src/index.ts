export type SynthesisMode = "balanced" | "consensus" | "dissent";

export interface PerspectiveCandidate {
  id: string;
  title: string;
  clusterCount: number;
  reductionMethod: string;
  synthesisMode: SynthesisMode;
  notes: string[];
}

export interface PerspectiveScorecard {
  perspectiveId: string;
  relevanceToGuidingQuestions: number;
  evidenceCoverage: number;
  narrativeLegibility: number;
  dissentVisibility: number;
  novelty: number;
}
