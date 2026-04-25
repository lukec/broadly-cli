import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import {
  parseProjectConfig,
  serializeProjectConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { runTextPromptWithModel, type RegisteredModel } from "../modelRuntime.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

const delimiterCandidates = [",", "\t", ";", "|"] as const;

export interface ConfigureDatasetOptions {
  file?: string;
  project?: string;
  model?: string;
  sampleRows: number;
  maxOutputTokens: number;
}

interface ParsedDatasetPreview {
  encoding: string;
  delimiter: string;
  format: "csv" | "tsv";
  headers: string[];
  rowCount: number;
  sampleRows: Array<Record<string, string>>;
  columnStats: ColumnStats[];
}

interface ColumnStats {
  header: string;
  nonEmptyCount: number;
  maxLength: number;
  samples: string[];
}

interface DatasetFieldClassification {
  idColumn: string | null;
  primaryTextFields: string[];
  contextFields: string[];
  sourceLabelFields: string[];
  languageFields: string[];
  metadataFields: string[];
  mutableMetricFields: string[];
  excludeFields: string[];
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export async function configureDataset(options: ConfigureDatasetOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "configure dataset",
    details: {
      file: options.file,
      model: options.model,
      sampleRows: options.sampleRows
    },
    summarizeResult: (result) => result,
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const datasetPath = resolveDatasetPath(projectRoot, options.file ?? config.dataset.path);
      const preview = await loadDatasetPreview(datasetPath, options.sampleRows);
      const model = resolveConfigurationModel(config, options.model);
      const classification =
        model === null
          ? buildHeuristicClassification(preview)
          : await classifyDatasetFields({
              config,
              datasetPath,
              maxOutputTokens: options.maxOutputTokens,
              model,
              preview,
              projectRoot
            });
      const sanitized = sanitizeClassification(classification, preview);
      const allowFields = buildAllowFields(sanitized);
      const relativeDatasetPath = toPortableRelativePath(projectRoot, datasetPath);

      config.dataset = {
        path: relativeDatasetPath,
        format: preview.format,
        encoding: preview.encoding,
        delimiter: preview.delimiter,
        ...(sanitized.idColumn === null ? {} : { idColumn: sanitized.idColumn }),
        allowFields,
        fieldMap: {
          primaryText: sanitized.primaryTextFields,
          context: sanitized.contextFields,
          sourceLabel: sanitized.sourceLabelFields,
          language: sanitized.languageFields,
          metadata: sanitized.metadataFields,
          mutableMetrics: sanitized.mutableMetricFields,
          exclude: sanitized.excludeFields
        }
      };

      await writeFile(projectPaths.configPath, serializeProjectConfig(config), "utf8");

      process.stdout.write(
        renderConfigureDatasetSummary({
          configPath: projectPaths.configPath,
          datasetPath,
          model,
          preview,
          classification: sanitized,
          allowFields
        })
      );

      return {
        datasetPath: relativeDatasetPath,
        model: model?.name ?? "heuristic",
        primaryTextFields: sanitized.primaryTextFields,
        allowFields: allowFields.length,
        excludedFields: sanitized.excludeFields.length,
        mutableMetricFields: sanitized.mutableMetricFields.length
      };
    }
  });
}

async function classifyDatasetFields(options: {
  config: BroadlyProjectConfig;
  datasetPath: string;
  maxOutputTokens: number;
  model: RegisteredModel;
  preview: ParsedDatasetPreview;
  projectRoot: string;
}): Promise<DatasetFieldClassification> {
  try {
    const prompt = buildDatasetClassificationPrompt(options);
    const result = await runTextPromptWithModel({
      model: options.model,
      prompt,
      maxOutputTokens: options.maxOutputTokens,
      projectRoot: options.projectRoot,
      temperature: 0
    });

    return parseClassificationJson(result.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Dataset field classification with model '${options.model.name}' failed; using deterministic heuristics. ${message}\n`
    );

    return buildHeuristicClassification(options.preview);
  }
}

function buildDatasetClassificationPrompt(options: {
  config: BroadlyProjectConfig;
  datasetPath: string;
  preview: ParsedDatasetPreview;
}): string {
  return `You classify tabular dataset columns for Broadly, a local civic feedback analysis tool.

Return only one JSON object. Do not wrap it in Markdown.

Choose column names only from the provided headers. Do not invent column names.

The JSON object must have exactly these keys:
{
  "idColumn": string | null,
  "primaryTextFields": string[],
  "contextFields": string[],
  "sourceLabelFields": string[],
  "languageFields": string[],
  "metadataFields": string[],
  "mutableMetricFields": string[],
  "excludeFields": string[],
  "confidence": "low" | "medium" | "high",
  "rationale": string
}

Definitions:
- primaryTextFields: stable human-authored text that should be analyzed as the main comment body.
- contextFields: stable fields that help interpret the comment, such as prompt, topic, source query, or target account match.
- sourceLabelFields: stable fields identifying source, author, organization, platform, or channel.
- languageFields: language or locale fields.
- metadataFields: stable provenance fields worth preserving in normalized records.
- mutableMetricFields: counters, collection timestamps, or operational fields that can change over time, such as likes, shares, replies, views, scores, ranks, scraped_at, collected_at, updated_at, or last_seen_at. These should not be analyzed and should not affect record identity.
- excludeFields: fields that are not useful for analysis, are redundant, or are too operational/internal.

Project:
${JSON.stringify(
  {
    name: options.config.project.name,
    description: options.config.project.description,
    goals: options.config.project.goals,
    questions: options.config.questions
  },
  null,
  2
)}

Dataset path: ${options.datasetPath}
Detected format: ${options.preview.format}
Detected delimiter: ${renderDelimiterLabel(options.preview.delimiter)}
Row count: ${options.preview.rowCount}

Headers:
${JSON.stringify(options.preview.headers, null, 2)}

Column stats:
${JSON.stringify(options.preview.columnStats, null, 2)}

Example rows:
${JSON.stringify(options.preview.sampleRows, null, 2)}
`;
}

function parseClassificationJson(source: string): DatasetFieldClassification {
  const jsonSource = extractJsonObjectSource(source);
  const parsed = JSON.parse(jsonSource) as Partial<DatasetFieldClassification>;

  return {
    idColumn: typeof parsed.idColumn === "string" ? parsed.idColumn : null,
    primaryTextFields: normalizeStringArray(parsed.primaryTextFields),
    contextFields: normalizeStringArray(parsed.contextFields),
    sourceLabelFields: normalizeStringArray(parsed.sourceLabelFields),
    languageFields: normalizeStringArray(parsed.languageFields),
    metadataFields: normalizeStringArray(parsed.metadataFields),
    mutableMetricFields: normalizeStringArray(parsed.mutableMetricFields),
    excludeFields: normalizeStringArray(parsed.excludeFields),
    confidence:
      parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high"
        ? parsed.confidence
        : "low",
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : ""
  };
}

function sanitizeClassification(
  classification: DatasetFieldClassification,
  preview: ParsedDatasetPreview
): DatasetFieldClassification {
  const headerSet = new Set(preview.headers);
  const forcedMutableFields = preview.headers.filter(isMutableOrOperationalField);
  const used = new Set<string>();
  const sanitizeFieldList = (
    fields: string[],
    options?: {
      allowMutable?: boolean;
    }
  ): string[] => {
    const result: string[] = [];

    for (const field of fields) {
      if (
        !headerSet.has(field) ||
        used.has(field) ||
        (options?.allowMutable !== true && forcedMutableFields.includes(field))
      ) {
        continue;
      }

      used.add(field);
      result.push(field);
    }

    return result;
  };
  const idColumn =
    classification.idColumn !== null && headerSet.has(classification.idColumn)
      ? classification.idColumn
      : detectIdColumn(preview.headers);
  let primaryTextFields = sanitizeFieldList(classification.primaryTextFields);

  if (primaryTextFields.length === 0) {
    primaryTextFields = sanitizeFieldList(detectPrimaryTextFields(preview));
  }

  const contextFields = sanitizeFieldList(classification.contextFields);
  const sourceLabelFields = sanitizeFieldList(classification.sourceLabelFields);
  const languageFields = sanitizeFieldList(classification.languageFields);
  const metadataFields = sanitizeFieldList(classification.metadataFields);
  const mutableMetricFields = uniqueStrings([
    ...sanitizeFieldList(classification.mutableMetricFields, { allowMutable: true }),
    ...forcedMutableFields
  ]);
  const excludeFields = sanitizeFieldList(classification.excludeFields);

  return {
    idColumn,
    primaryTextFields,
    contextFields,
    sourceLabelFields,
    languageFields,
    metadataFields,
    mutableMetricFields,
    excludeFields,
    confidence: classification.confidence,
    rationale: classification.rationale
  };
}

function buildHeuristicClassification(preview: ParsedDatasetPreview): DatasetFieldClassification {
  const primaryTextFields = detectPrimaryTextFields(preview);
  const idColumn = detectIdColumn(preview.headers);
  const mutableMetricFields = preview.headers.filter((header) =>
    isMutableOrOperationalField(header)
  );
  const sourceLabelFields = preview.headers.filter((header) =>
    normalizedHeaderHasAny(header, ["author", "source", "platform", "channel"])
  );
  const languageFields = preview.headers.filter((header) =>
    normalizedHeaderHasAny(header, ["language", "lang", "locale"])
  );
  const contextFields = preview.headers.filter((header) =>
    normalizedHeaderHasAny(header, ["context", "prompt", "query", "topic", "target", "match"])
  );
  const metadataFields = preview.headers.filter((header) =>
    normalizedHeaderHasAny(header, ["created", "date", "time", "url", "uri", "link"])
  );

  return {
    idColumn,
    primaryTextFields,
    contextFields,
    sourceLabelFields,
    languageFields,
    metadataFields,
    mutableMetricFields,
    excludeFields: preview.headers.filter(
      (header) =>
        primaryTextFields.includes(header) === false &&
        contextFields.includes(header) === false &&
        sourceLabelFields.includes(header) === false &&
        languageFields.includes(header) === false &&
        metadataFields.includes(header) === false &&
        mutableMetricFields.includes(header) === false
    ),
    confidence: "medium",
    rationale: "Deterministic header heuristics were used."
  };
}

function buildAllowFields(classification: DatasetFieldClassification): string[] {
  return uniqueStrings([
    ...classification.primaryTextFields,
    ...classification.contextFields,
    ...classification.sourceLabelFields,
    ...classification.languageFields,
    ...classification.metadataFields
  ]).filter(
    (field) =>
      classification.mutableMetricFields.includes(field) === false &&
      classification.excludeFields.includes(field) === false
  );
}

async function loadDatasetPreview(
  datasetPath: string,
  sampleRowCount: number
): Promise<ParsedDatasetPreview> {
  const sourceBuffer = await readFile(datasetPath);
  const decoded = decodeSourceText(sourceBuffer);
  const parsed = parseTabularText(decoded.text);
  const [headerRow, ...dataRows] = parsed.rows;

  if (headerRow === undefined || headerRow.length === 0) {
    throw new Error(`Could not read a header row from dataset: ${datasetPath}`);
  }

  const headers = dedupeHeaders(headerRow);
  const rowObjects = dataRows
    .map((row) => buildRawRow(headers, row))
    .filter((row) => Object.values(row).some((value) => value.trim().length > 0));
  const sampleRows = rowObjects.slice(0, sampleRowCount);
  const columnStats = headers.map((header) => buildColumnStats(header, rowObjects));

  return {
    encoding: decoded.encoding,
    delimiter: parsed.delimiter,
    format: parsed.delimiter === "\t" ? "tsv" : "csv",
    headers,
    rowCount: rowObjects.length,
    sampleRows,
    columnStats
  };
}

function buildColumnStats(header: string, rows: Array<Record<string, string>>): ColumnStats {
  const values = rows
    .map((row) => normalizeCellValue(row[header] ?? ""))
    .filter((value) => value.length > 0);

  return {
    header,
    nonEmptyCount: values.length,
    maxLength: values.reduce((max, value) => Math.max(max, value.length), 0),
    samples: uniqueStrings(values.map((value) => truncate(value, 160))).slice(0, 4)
  };
}

function resolveConfigurationModel(
  config: BroadlyProjectConfig,
  explicitModel: string | undefined
): RegisteredModel | null {
  if (explicitModel !== undefined) {
    const model = config.models.find((item) => item.name === explicitModel);

    if (model === undefined) {
      throw new Error(`No model alias named '${explicitModel}' is registered in this project.`);
    }

    return model;
  }

  const reviewModel =
    config.review_model === undefined
      ? undefined
      : config.models.find((item) => item.name === config.review_model);

  if (reviewModel !== undefined) {
    return reviewModel;
  }

  return config.models.find((item) => item.modelId.toLowerCase().includes("embed") === false) ?? null;
}

function resolveDatasetPath(projectRoot: string, datasetPath: string): string {
  if (path.isAbsolute(datasetPath)) {
    return datasetPath;
  }

  if (datasetPath.startsWith(".")) {
    return path.resolve(projectRoot, datasetPath);
  }

  return path.resolve(datasetPath);
}

function decodeSourceText(sourceBuffer: Buffer): { encoding: string; text: string } {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(sourceBuffer);
    return {
      encoding: "utf-8",
      text: utf8
    };
  } catch {
    return {
      encoding: "latin1",
      text: sourceBuffer.toString("latin1")
    };
  }
}

function parseTabularText(text: string): { delimiter: string; rows: string[][] } {
  let bestDelimiter = ",";
  let bestRows: string[][] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const delimiter of delimiterCandidates) {
    const rows = parseDelimitedRows(text, delimiter).filter((row) => !isBlankParsedRow(row));
    const score = scoreParsedRows(rows);

    if (score > bestScore) {
      bestDelimiter = delimiter;
      bestRows = rows;
      bestScore = score;
    }
  }

  if (bestRows.length === 0) {
    throw new Error("Could not detect a supported delimited format.");
  }

  return {
    delimiter: bestDelimiter,
    rows: bestRows
  };
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === undefined) {
      continue;
    }

    if (inQuotes) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }

      continue;
    }

    if (character === "\"") {
      inQuotes = true;
      continue;
    }

    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (character === "\r") {
      continue;
    }

    field += character;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function scoreParsedRows(rows: string[][]): number {
  const sampleRows = rows.slice(0, 25);
  const headerWidth = sampleRows[0]?.length ?? 0;

  if (headerWidth <= 1) {
    return Number.NEGATIVE_INFINITY;
  }

  return (
    headerWidth * 100 +
    sampleRows.slice(1).filter((row) => row.length === headerWidth).length
  );
}

function dedupeHeaders(headers: string[]): string[] {
  const seenHeaders = new Map<string, number>();

  return headers.map((header, index) => {
    const baseHeader = normalizeCellValue(header).length === 0 ? `column_${index + 1}` : normalizeCellValue(header);
    const seenCount = seenHeaders.get(baseHeader) ?? 0;
    seenHeaders.set(baseHeader, seenCount + 1);

    return seenCount === 0 ? baseHeader : `${baseHeader}_${seenCount + 1}`;
  });
}

function buildRawRow(headers: string[], row: string[]): Record<string, string> {
  const rawRow: Record<string, string> = {};

  for (const [index, header] of headers.entries()) {
    rawRow[header] = normalizeCellValue(row[index] ?? "");
  }

  return rawRow;
}

function detectIdColumn(headers: string[]): string | null {
  return (
    headers.find((header) =>
      ["id", "record id", "response id", "submission id", "comment id", "source id", "uri"].includes(
        normalizeFieldName(header)
      )
    ) ?? null
  );
}

function detectPrimaryTextFields(preview: ParsedDatasetPreview): string[] {
  const candidates = preview.columnStats
    .filter((column) =>
      normalizedHeaderHasAny(column.header, [
        "text",
        "comment",
        "question",
        "idea",
        "feedback",
        "response",
        "opinion",
        "submission",
        "remark",
        "suggestion",
        "body",
        "content"
      ])
    )
    .sort((left, right) => right.maxLength - left.maxLength);

  if (candidates[0] !== undefined) {
    return [candidates[0].header];
  }

  const longest = [...preview.columnStats].sort((left, right) => right.maxLength - left.maxLength)[0];

  return longest === undefined ? [preview.headers[0] ?? ""] : [longest.header];
}

function normalizedHeaderHasAny(header: string, keywords: string[]): boolean {
  const normalized = normalizeFieldName(header);

  return keywords.some((keyword) => normalized.includes(keyword));
}

function isMutableOrOperationalField(header: string): boolean {
  const normalized = normalizeFieldName(header);
  const tokens = new Set(normalized.split(" ").filter((token) => token.length > 0));
  const tokenKeywords = new Set([
    "like",
    "likes",
    "repost",
    "reposts",
    "reply",
    "replies",
    "quote",
    "quotes",
    "view",
    "views",
    "score",
    "rank",
    "count",
    "counts",
    "scraped",
    "collected",
    "updated"
  ]);

  if ([...tokenKeywords].some((keyword) => tokens.has(keyword))) {
    return true;
  }

  return normalized.includes("last seen");
}

function normalizeFieldName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCellValue(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isBlankParsedRow(row: string[]): boolean {
  return row.every((value) => normalizeCellValue(value).length === 0);
}

function extractJsonObjectSource(source: string): string {
  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch?.[1] !== undefined) {
    return fencedMatch[1].trim();
  }

  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return source.slice(start, end + 1);
  }

  return source;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}

function renderDelimiterLabel(delimiter: string): string {
  return delimiter === "\t" ? "\\t" : delimiter;
}

function renderConfigureDatasetSummary(options: {
  allowFields: string[];
  classification: DatasetFieldClassification;
  configPath: string;
  datasetPath: string;
  model: RegisteredModel | null;
  preview: ParsedDatasetPreview;
}): string {
  const lines = [
    `Configured dataset mapping in ${options.configPath}`,
    "",
    `Dataset: ${options.datasetPath}`,
    `Rows inspected: ${options.preview.rowCount}`,
    `Headers: ${options.preview.headers.length}`,
    `Model: ${options.model === null ? "heuristic fallback" : options.model.name}`,
    `Confidence: ${options.classification.confidence}`,
    "",
    `ID column: ${options.classification.idColumn ?? "(none)"}`,
    `Primary text: ${renderFieldList(options.classification.primaryTextFields)}`,
    `Context: ${renderFieldList(options.classification.contextFields)}`,
    `Source labels: ${renderFieldList(options.classification.sourceLabelFields)}`,
    `Language: ${renderFieldList(options.classification.languageFields)}`,
    `Metadata: ${renderFieldList(options.classification.metadataFields)}`,
    `Mutable metrics excluded: ${renderFieldList(options.classification.mutableMetricFields)}`,
    `Other excluded: ${renderFieldList(options.classification.excludeFields)}`,
    `Allowed ingest fields: ${options.allowFields.length}`,
    "",
    `Rationale: ${options.classification.rationale || "(none)"}`
  ];

  return `${lines.join("\n")}\n`;
}

function renderFieldList(fields: string[]): string {
  return fields.length === 0 ? "(none)" : fields.join(", ");
}
