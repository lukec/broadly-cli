import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sha256Hex } from "@broadly/core";

const delimiterCandidates = [",", "\t", ";", "|"] as const;
const likelyIdColumnNames = new Set([
  "id",
  "record id",
  "response id",
  "submission id",
  "comment id",
  "source id"
]);

export interface NormalizedCommentRecord {
  sourceId: string;
  contentSha256: string;
  contentText: string;
  rawRow: Record<string, string>;
  provenance: {
    importPath: string;
    originalPath: string;
    sourceFileSha256: string;
    importEncoding: string;
    delimiter: string;
    sourceRowNumber: number;
    externalId?: string;
  };
}

export interface IngestManifest {
  createdAt: string;
  source: {
    originalPath: string;
    storedPath: string;
    sha256: string;
    byteSize: number;
    format: "csv" | "tsv";
    encoding: string;
    delimiter: string;
    idColumn?: string;
  };
  dataset: {
    sourceHeaderCount: number;
    sourceHeaders: string[];
    headerCount: number;
    rowCount: number;
    filesWritten: number;
    headers: string[];
  };
  outputs: {
    normalizedDir: string;
    manifestPath: string;
  };
}

export interface AddTabularDataSourceOptions {
  projectRoot: string;
  datasetPath: string;
  allowFields?: string[];
}

export interface AddTabularDataSourceResult {
  originalDatasetPath: string;
  storedDatasetPath: string;
  storedDatasetSha256: string;
  datasetFormat: "csv" | "tsv";
  encoding: string;
  delimiter: string;
  idColumn?: string;
  rowCount: number;
  filesWritten: number;
  normalizedDir: string;
  manifestPath: string;
  headers: string[];
  sourceHeaders: string[];
}

export async function addTabularDataSource(
  options: AddTabularDataSourceOptions
): Promise<AddTabularDataSourceResult> {
  const absoluteDatasetPath = path.resolve(options.datasetPath);
  const rawDir = path.join(path.resolve(options.projectRoot), "data", "raw");
  const normalizedDir = path.join(path.resolve(options.projectRoot), "data", "normalized");
  const sourceBuffer = await readFile(absoluteDatasetPath);
  const sourceFileSha256 = sha256Hex(sourceBuffer);
  const decodedSource = decodeSourceText(sourceBuffer);
  const parsedDataset = parseTabularText(decodedSource.text);

  if (parsedDataset.rows.length === 0) {
    throw new Error(`No rows found in dataset: ${absoluteDatasetPath}`);
  }

  const [headerRow, ...dataRows] = parsedDataset.rows;

  if (headerRow === undefined || headerRow.length === 0) {
    throw new Error(`Could not read a header row from dataset: ${absoluteDatasetPath}`);
  }

  const sourceHeaders = dedupeHeaders(headerRow);
  const headers = resolveAllowedHeaders(sourceHeaders, options.allowFields);
  const idColumn = detectIdColumn(sourceHeaders);
  const createdAt = new Date().toISOString();
  const datasetFormat = parsedDataset.delimiter === "\t" ? "tsv" : "csv";
  const storedDatasetPath = path.join(
    rawDir,
    `${sourceFileSha256}${resolveStoredExtension(absoluteDatasetPath, datasetFormat)}`
  );
  const manifestPath = path.join(normalizedDir, "ingest-manifest.json");

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });
  await writeFile(storedDatasetPath, sourceBuffer);

  let filesWritten = 0;
  let rowCount = 0;

  for (const [index, row] of dataRows.entries()) {
    const sourceRawRow = buildRawRow(sourceHeaders, row);
    const rawRow = filterRawRow(headers, sourceRawRow);

    if (isEmptyRow(rawRow)) {
      continue;
    }

    const contentText = renderContentText(headers, rawRow);
    const contentSha256 = sha256Hex(contentText);
    const record: NormalizedCommentRecord = {
      sourceId: contentSha256,
      contentSha256,
      contentText,
      rawRow,
      provenance: {
        importPath: storedDatasetPath,
        originalPath: absoluteDatasetPath,
        sourceFileSha256,
        importEncoding: decodedSource.encoding,
        delimiter: parsedDataset.delimiter,
        sourceRowNumber: index + 2,
        ...(idColumn === undefined ||
        sourceRawRow[idColumn] === undefined ||
        sourceRawRow[idColumn].length === 0
          ? {}
          : { externalId: sourceRawRow[idColumn] })
      }
    };

    const outputPath = path.join(normalizedDir, `${contentSha256}.json`);

    await writeFile(
      outputPath,
      JSON.stringify(
        {
          createdAt,
          ...record
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    filesWritten += 1;
    rowCount += 1;
  }

  const manifest: IngestManifest = {
    createdAt,
    source: {
      originalPath: absoluteDatasetPath,
      storedPath: storedDatasetPath,
      sha256: sourceFileSha256,
      byteSize: sourceBuffer.byteLength,
      format: datasetFormat,
      encoding: decodedSource.encoding,
      delimiter: parsedDataset.delimiter,
      ...(idColumn === undefined ? {} : { idColumn })
    },
    dataset: {
      sourceHeaderCount: sourceHeaders.length,
      sourceHeaders,
      headerCount: headers.length,
      rowCount,
      filesWritten,
      headers
    },
    outputs: {
      normalizedDir,
      manifestPath
    }
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    originalDatasetPath: absoluteDatasetPath,
    storedDatasetPath,
    storedDatasetSha256: sourceFileSha256,
    datasetFormat,
    encoding: decodedSource.encoding,
    delimiter: parsedDataset.delimiter,
    ...(idColumn === undefined ? {} : { idColumn }),
    rowCount,
    filesWritten,
    normalizedDir,
    manifestPath,
    headers,
    sourceHeaders
  };
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

    if (rows.length === 0) {
      continue;
    }

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
      if (text[index + 1] === "\n") {
        continue;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = "";
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

  let consistentRows = 0;

  for (const row of sampleRows.slice(1)) {
    if (row.length === headerWidth) {
      consistentRows += 1;
    }
  }

  return headerWidth * 100 + consistentRows;
}

function dedupeHeaders(headers: string[]): string[] {
  const seenHeaders = new Map<string, number>();

  return headers.map((header, index) => {
    const baseHeader = normalizeHeader(header, index);
    const existingCount = seenHeaders.get(baseHeader) ?? 0;
    const nextCount = existingCount + 1;

    seenHeaders.set(baseHeader, nextCount);

    return nextCount === 1 ? baseHeader : `${baseHeader} (${nextCount})`;
  });
}

function normalizeHeader(header: string, index: number): string {
  const normalizedHeader = normalizeCellValue(header).replace(/\s+/g, " ").trim();

  return normalizedHeader.length === 0 ? `Column ${index + 1}` : normalizedHeader;
}

function buildRawRow(headers: string[], row: string[]): Record<string, string> {
  const rawRow: Record<string, string> = {};

  for (const [index, header] of headers.entries()) {
    rawRow[header] = normalizeCellValue(row[index] ?? "");
  }

  return rawRow;
}

function filterRawRow(
  headers: string[],
  rawRow: Record<string, string>
): Record<string, string> {
  const filteredRow: Record<string, string> = {};

  for (const header of headers) {
    filteredRow[header] = rawRow[header] ?? "";
  }

  return filteredRow;
}

function renderContentText(headers: string[], rawRow: Record<string, string>): string {
  const lines: string[] = [];

  for (const header of headers) {
    const value = rawRow[header];

    if (value === undefined || value.length === 0) {
      continue;
    }

    lines.push(value.includes("\n") ? `${header}:\n${value}` : `${header}: ${value}`);
  }

  return lines.join("\n");
}

function normalizeCellValue(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isBlankParsedRow(row: string[]): boolean {
  return row.every((value) => normalizeCellValue(value).length === 0);
}

function isEmptyRow(rawRow: Record<string, string>): boolean {
  return Object.values(rawRow).every((value) => value.length === 0);
}

function detectIdColumn(headers: string[]): string | undefined {
  return headers.find((header) => likelyIdColumnNames.has(header.toLowerCase()));
}

function resolveAllowedHeaders(headers: string[], allowFields: string[] | undefined): string[] {
  if (allowFields === undefined || allowFields.length === 0) {
    return headers;
  }

  const allowed = new Set(allowFields);
  const matchedHeaders = headers.filter((header) => allowed.has(header));

  if (matchedHeaders.length === 0) {
    throw new Error("No configured dataset.allowFields matched the dataset headers.");
  }

  return matchedHeaders;
}

function resolveStoredExtension(
  datasetPath: string,
  datasetFormat: "csv" | "tsv"
): string {
  const extname = path.extname(datasetPath).toLowerCase();

  if (extname.length > 0) {
    return extname;
  }

  return datasetFormat === "tsv" ? ".tsv" : ".csv";
}
