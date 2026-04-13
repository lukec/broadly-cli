export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type AuthorKind =
  | "participant"
  | "facilitator"
  | "staff"
  | "account"
  | "unknown";

export interface SourceAuthorRef {
  authorId?: string;
  displayName?: string;
  kind: AuthorKind;
}

export interface SourceTextBody {
  rawText: string;
  translatedText?: string;
  subject?: string;
  translatedSubject?: string;
  sourceLanguage?: string;
  translatedLanguage?: string;
}

export interface ImportedSourceAnnotations {
  theme?: string;
  subTheme?: string;
  workingCommitment?: string;
  votes?: number;
  quotable?: boolean;
}

export interface ImportedSourceProvenance {
  sourceSystem: string;
  datasetId: string;
  importPath: string;
  importEncoding?: string;
  externalId?: string;
  sourceRowNumber?: number | string;
  sourceType?: string;
  event?: string;
  prompt?: string;
}

export interface NormalizedSourceRecord {
  sourceId: string;
  submittedAt?: string;
  author?: SourceAuthorRef;
  body: SourceTextBody;
  annotations?: ImportedSourceAnnotations;
  provenance: ImportedSourceProvenance;
  metadata: Record<string, JsonValue>;
  rawRow: Record<string, string>;
}

export type SourceRecord = NormalizedSourceRecord;

export interface SourceColumnMapping {
  rawTextColumn: string;
  metadataColumns: string[];
  externalIdColumn?: string;
  rowNumberColumn?: string;
  submittedAtColumn?: string;
  subjectColumn?: string;
  translatedTextColumn?: string;
  translatedSubjectColumn?: string;
  authorIdColumn?: string;
  authorNameColumn?: string;
  authorKind?: AuthorKind;
  sourceTypeColumn?: string;
  eventColumn?: string;
  promptColumn?: string;
  sourceLanguageColumn?: string;
  translatedLanguageColumn?: string;
  votesColumn?: string;
  quotableColumn?: string;
  themeColumn?: string;
  subThemeColumn?: string;
  workingCommitmentColumn?: string;
}

export interface IngestPlan {
  datasetPath: string;
  datasetId: string;
  sourceSystem: string;
  encoding?: string;
  mapping: SourceColumnMapping;
}

export interface IngestBoundary {
  plan: IngestPlan;
  records: NormalizedSourceRecord[];
}
