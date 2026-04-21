export const REVIEW_STATUS_VALUES = [
  "included",
  "excluded-non-substantive",
  "excluded-off-topic",
  "excluded-admin",
  "excluded-duplicate"
] as const;

export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number];

export const DEFAULT_INCLUDED_REVIEW_STATUSES: ReviewStatus[] = ["included"];

export interface ReviewActor {
  type: "human" | "machine";
  name: string;
}

export interface ReviewSuggestionActor extends ReviewActor {
  type: "machine";
}

export interface CommentReviewArtifact {
  subjectKind: "comment";
  subjectId: string;
  status: ReviewStatus;
  reasonCode: string;
  note: string;
  actor: ReviewActor;
  createdAt: string;
  updatedAt: string;
  provenance: {
    normalizedRecordPath: string;
  };
}

export interface OpinionReviewArtifact {
  subjectKind: "opinion";
  subjectId: string;
  status: ReviewStatus;
  reasonCode: string;
  note: string;
  actor: ReviewActor;
  createdAt: string;
  updatedAt: string;
  provenance: {
    opinionArtifactPath: string;
    sourceId: string;
    normalizedRecordPath: string;
  };
}

export interface CommentReviewSuggestionArtifact {
  subjectKind: "comment";
  subjectId: string;
  suggestedStatus: ReviewStatus;
  reasonCode: string;
  note: string;
  confidence: number;
  state: "proposed" | "accepted" | "rejected";
  actor: ReviewSuggestionActor;
  createdAt: string;
  updatedAt: string;
  provenance: {
    normalizedRecordPath: string;
  };
}

export interface OpinionReviewSuggestionArtifact {
  subjectKind: "opinion";
  subjectId: string;
  suggestedStatus: ReviewStatus;
  reasonCode: string;
  note: string;
  confidence: number;
  state: "proposed" | "accepted" | "rejected";
  actor: ReviewSuggestionActor;
  createdAt: string;
  updatedAt: string;
  provenance: {
    opinionArtifactPath: string;
    sourceId: string;
    normalizedRecordPath: string;
  };
}

export interface ReviewConfig {
  analysis: {
    includeCommentStatuses: ReviewStatus[];
    includeOpinionStatuses: ReviewStatus[];
  };
  report: {
    includeCommentStatuses: ReviewStatus[];
    includeOpinionStatuses: ReviewStatus[];
  };
  web: {
    defaultVisibleCommentStatuses: ReviewStatus[];
    defaultVisibleOpinionStatuses: ReviewStatus[];
  };
}

export function createDefaultReviewConfig(): ReviewConfig {
  return {
    analysis: {
      includeCommentStatuses: [...DEFAULT_INCLUDED_REVIEW_STATUSES],
      includeOpinionStatuses: [...DEFAULT_INCLUDED_REVIEW_STATUSES]
    },
    report: {
      includeCommentStatuses: [...DEFAULT_INCLUDED_REVIEW_STATUSES],
      includeOpinionStatuses: [...DEFAULT_INCLUDED_REVIEW_STATUSES]
    },
    web: {
      defaultVisibleCommentStatuses: [...DEFAULT_INCLUDED_REVIEW_STATUSES],
      defaultVisibleOpinionStatuses: [...REVIEW_STATUS_VALUES]
    }
  };
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && REVIEW_STATUS_VALUES.includes(value as ReviewStatus);
}
