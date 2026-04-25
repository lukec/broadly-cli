import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveProjectPaths } from "@broadly/core";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

const DEFAULT_APPVIEW_URL = "https://api.bsky.app";
const DEFAULT_ACCOUNT_HANDLES = ["cityofvancouver.bsky.social"];
const DEFAULT_SEARCH_QUERIES = [
  "\"City of Vancouver\"",
  "cityofvancouver",
  "\"Vancouver city hall\"",
  "\"Vancouver City Council\"",
  "CityofVancouver"
];
const DEFAULT_OUTPUT_PATH = "data/raw/bluesky-vancouver-pulse.csv";
const DEFAULT_MANIFEST_PATH = "data/raw/bluesky-vancouver-pulse-manifest.json";

const csvHeaders = [
  "id",
  "uri",
  "cid",
  "url",
  "created_at",
  "indexed_at",
  "scraped_at",
  "query_matches",
  "target_account_matches",
  "author_handle",
  "author_did",
  "author_display_name",
  "reply_count",
  "repost_count",
  "like_count",
  "quote_count",
  "language",
  "text",
  "external_urls",
  "mentioned_dids"
] as const;

type CsvHeader = (typeof csvHeaders)[number];
type CsvRow = Record<CsvHeader, string>;

interface BlueskyScrapeOptions {
  project?: string;
  account: string[];
  query: string[];
  since?: string;
  until?: string;
  sinceDays: number;
  limit: number;
  output: string;
  manifest: string;
  appview: string;
}

interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  createdAt?: string;
  indexedAt?: string;
  followersCount?: number;
}

interface SearchResponse {
  cursor?: string;
  posts?: PostView[];
  error?: string;
  message?: string;
}

interface PostView {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record?: {
    createdAt?: string;
    text?: string;
    langs?: string[];
    facets?: Array<{
      features?: Array<{
        $type?: string;
        did?: string;
        uri?: string;
      }>;
    }>;
  };
  indexedAt?: string;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
}

interface SearchFailure {
  query: string;
  status: number;
  message: string;
}

interface SearchHit {
  post: PostView;
  query: string;
}

interface ScrapedPost {
  row: CsvRow;
  createdAt: string;
}

export async function scrapeBluesky(options: BlueskyScrapeOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "bluesky scrape",
    details: {
      accounts: options.account,
      queries: options.query,
      since: options.since,
      until: options.until,
      sinceDays: options.sinceDays,
      limit: options.limit
    },
    summarizeResult: (result) => result,
    action: async () => {
      const result = await scrapeBlueskyIntoProject(projectRoot, options);

      process.stdout.write(renderScrapeSummary(result));
      return {
        accountsResolved: result.accounts.length,
        queriesSucceeded: result.queriesSucceeded,
        queriesFailed: result.failures.length,
        postsFetched: result.postsFetched,
        rowsAdded: result.rowsAdded,
        rowsUpdated: result.rowsUpdated,
        totalRows: result.totalRows,
        output: result.outputPath,
        manifest: result.manifestPath
      };
    }
  });
}

async function scrapeBlueskyIntoProject(
  projectRoot: string,
  options: BlueskyScrapeOptions
): Promise<{
  accounts: BlueskyProfile[];
  failures: SearchFailure[];
  manifestPath: string;
  outputPath: string;
  postsFetched: number;
  queriesSucceeded: number;
  rowsAdded: number;
  rowsUpdated: number;
  since: string;
  totalRows: number;
  until: string;
}> {
  const appview = normalizeServiceUrl(options.appview);
  const projectPaths = resolveProjectPaths(projectRoot);
  const outputPath = resolveProjectFilePath(projectPaths.rootDir, options.output);
  const manifestPath = resolveProjectFilePath(projectPaths.rootDir, options.manifest);
  const since = options.since ?? daysAgoIso(options.sinceDays);
  const until = options.until ?? new Date().toISOString();
  const scrapedAt = new Date().toISOString();
  const accountHandles = normalizeRepeatedOption(options.account, DEFAULT_ACCOUNT_HANDLES);
  const queries = normalizeRepeatedOption(options.query, DEFAULT_SEARCH_QUERIES);
  const accounts = await Promise.all(
    accountHandles.map((handle) => getBlueskyProfile(appview, handle))
  );
  const existingRows = await readExistingRows(outputPath);
  const existingByUri = new Map(existingRows.map((row) => [row.uri, row]));
  const hits: SearchHit[] = [];
  const failures: SearchFailure[] = [];
  let queriesSucceeded = 0;

  for (const query of queries) {
    const result = await searchPosts({
      appview,
      limit: options.limit,
      query,
      since,
      until
    });

    hits.push(...result.hits);
    failures.push(...result.failures);

    if (result.succeeded) {
      queriesSucceeded += 1;
    }
  }

  const queryMatchesByUri = new Map<string, Set<string>>();

  for (const hit of hits) {
    const queriesForPost = queryMatchesByUri.get(hit.post.uri) ?? new Set<string>();
    queriesForPost.add(hit.query);
    queryMatchesByUri.set(hit.post.uri, queriesForPost);
  }

  let rowsAdded = 0;
  let rowsUpdated = 0;

  for (const post of dedupePosts(hits.map((hit) => hit.post))) {
    const scrapedPost = toScrapedPost({
      accounts,
      post,
      queryMatches: [...(queryMatchesByUri.get(post.uri) ?? [])],
      scrapedAt
    });
    const existing = existingByUri.get(post.uri);

    if (existing === undefined) {
      existingByUri.set(post.uri, scrapedPost.row);
      rowsAdded += 1;
      continue;
    }

    existingByUri.set(post.uri, {
      ...scrapedPost.row,
      scraped_at: existing.scraped_at.length > 0 ? existing.scraped_at : scrapedPost.row.scraped_at,
      query_matches: mergePipeLists(existing.query_matches, scrapedPost.row.query_matches),
      target_account_matches: mergePipeLists(
        existing.target_account_matches,
        scrapedPost.row.target_account_matches
      )
    });
    rowsUpdated += 1;
  }

  const allRows = [...existingByUri.values()].sort((left, right) =>
    right.created_at.localeCompare(left.created_at)
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderCsv(allRows), "utf8");

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        createdAt: scrapedAt,
        appview,
        accounts: accounts.map((account) => ({
          did: account.did,
          handle: account.handle,
          displayName: account.displayName ?? null,
          description: account.description ?? null,
          followersCount: account.followersCount ?? null,
          createdAt: account.createdAt ?? null,
          indexedAt: account.indexedAt ?? null
        })),
        search: {
          since,
          until,
          queries,
          limitPerQuery: options.limit,
          queriesSucceeded,
          failures
        },
        output: {
          csv: toPortableRelativePath(projectRoot, outputPath),
          rowCount: allRows.length,
          rowsAdded,
          rowsUpdated,
          postsFetched: hits.length
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    accounts,
    failures,
    manifestPath,
    outputPath,
    postsFetched: hits.length,
    queriesSucceeded,
    rowsAdded,
    rowsUpdated,
    since,
    totalRows: allRows.length,
    until
  };
}

async function getBlueskyProfile(appview: string, actor: string): Promise<BlueskyProfile> {
  const response = await getJson<BlueskyProfile>(appview, "app.bsky.actor.getProfile", {
    actor
  });

  if (response.ok === false) {
    throw new Error(
      `Could not resolve Bluesky account '${actor}': ${response.status} ${response.message}`
    );
  }

  return response.value;
}

async function searchPosts(options: {
  appview: string;
  limit: number;
  query: string;
  since: string;
  until: string;
}): Promise<{ failures: SearchFailure[]; hits: SearchHit[]; succeeded: boolean }> {
  const hits: SearchHit[] = [];
  const failures: SearchFailure[] = [];
  let cursor: string | undefined;
  let succeeded = false;

  while (hits.length < options.limit) {
    const pageLimit = Math.min(100, options.limit - hits.length);
    const params: Record<string, string> = {
      q: options.query,
      limit: String(pageLimit),
      sort: "latest",
      since: options.since,
      until: options.until
    };

    if (cursor !== undefined) {
      params.cursor = cursor;
    }

    const response = await getJson<SearchResponse>(
      options.appview,
      "app.bsky.feed.searchPosts",
      params
    );

    if (response.ok === false) {
      failures.push({
        query: options.query,
        status: response.status,
        message: response.message
      });
      break;
    }

    succeeded = true;

    for (const post of response.value.posts ?? []) {
      hits.push({
        post,
        query: options.query
      });
    }

    if (response.value.cursor === undefined || (response.value.posts ?? []).length === 0) {
      break;
    }

    cursor = response.value.cursor;
  }

  return {
    failures,
    hits,
    succeeded
  };
}

async function getJson<T>(
  appview: string,
  endpoint: string,
  params: Record<string, string>
): Promise<
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      message: string;
    }
> {
  const url = new URL(`/xrpc/${endpoint}`, appview);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "broadly-cli/0.1 bluesky-scraper"
    }
  });
  const text = await response.text();
  const parsed = parseJsonObject(text);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractErrorMessage(parsed, text)
    };
  }

  return {
    ok: true,
    value: parsed as T
  };
}

function toScrapedPost(options: {
  accounts: BlueskyProfile[];
  post: PostView;
  queryMatches: string[];
  scrapedAt: string;
}): ScrapedPost {
  const text = options.post.record?.text ?? "";
  const normalizedText = text.toLowerCase();
  const mentionedDids = extractMentionedDids(options.post);
  const externalUrls = extractExternalUrls(options.post);
  const targetAccountMatches = options.accounts
    .filter((account) => {
      const normalizedDisplayName = account.displayName?.trim().toLowerCase() ?? "";

      return (
        mentionedDids.includes(account.did) ||
        normalizedText.includes(account.handle.toLowerCase()) ||
        (normalizedDisplayName.length > 0 && normalizedText.includes(normalizedDisplayName))
      );
    })
    .map((account) => account.handle);
  const createdAt = options.post.record?.createdAt ?? options.post.indexedAt ?? "";

  return {
    createdAt,
    row: {
      id: blueskyUriToStableId(options.post.uri),
      uri: options.post.uri,
      cid: options.post.cid,
      url: blueskyPostUrl(options.post),
      created_at: createdAt,
      indexed_at: options.post.indexedAt ?? "",
      scraped_at: options.scrapedAt,
      query_matches: options.queryMatches.join(" | "),
      target_account_matches: targetAccountMatches.join(" | "),
      author_handle: options.post.author.handle,
      author_did: options.post.author.did,
      author_display_name: options.post.author.displayName ?? "",
      reply_count: String(options.post.replyCount ?? 0),
      repost_count: String(options.post.repostCount ?? 0),
      like_count: String(options.post.likeCount ?? 0),
      quote_count: String(options.post.quoteCount ?? 0),
      language: (options.post.record?.langs ?? []).join(" | "),
      text,
      external_urls: externalUrls.join(" | "),
      mentioned_dids: mentionedDids.join(" | ")
    }
  };
}

function extractMentionedDids(post: PostView): string[] {
  return uniqueStrings(
    (post.record?.facets ?? [])
      .flatMap((facet) => facet.features ?? [])
      .filter((feature) => feature.$type === "app.bsky.richtext.facet#mention")
      .map((feature) => feature.did ?? "")
      .filter((did) => did.length > 0)
  );
}

function extractExternalUrls(post: PostView): string[] {
  return uniqueStrings(
    (post.record?.facets ?? [])
      .flatMap((facet) => facet.features ?? [])
      .filter((feature) => feature.$type === "app.bsky.richtext.facet#link")
      .map((feature) => feature.uri ?? "")
      .filter((uri) => uri.length > 0)
  );
}

function dedupePosts(posts: PostView[]): PostView[] {
  const postsByUri = new Map<string, PostView>();

  for (const post of posts) {
    postsByUri.set(post.uri, post);
  }

  return [...postsByUri.values()];
}

async function readExistingRows(filePath: string): Promise<CsvRow[]> {
  try {
    const source = await readFile(filePath, "utf8");
    return parseCsv(source);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

function renderCsv(rows: CsvRow[]): string {
  return [
    csvHeaders.join(","),
    ...rows.map((row) => csvHeaders.map((header) => escapeCsvField(row[header])).join(","))
  ].join("\n") + "\n";
}

function parseCsv(source: string): CsvRow[] {
  const rows = parseCsvRows(source);
  const [headerRow, ...dataRows] = rows;

  if (headerRow === undefined) {
    return [];
  }

  return dataRows
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => {
      const output = Object.fromEntries(csvHeaders.map((header) => [header, ""])) as CsvRow;

      for (const [index, header] of headerRow.entries()) {
        if (csvHeaders.includes(header as CsvHeader)) {
          output[header as CsvHeader] = row[index] ?? "";
        }
      }

      return output;
    })
    .filter((row) => row.uri.length > 0);
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === undefined) {
      continue;
    }

    if (inQuotes) {
      if (character === "\"") {
        if (source[index + 1] === "\"") {
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

    if (character === ",") {
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

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }

  return value;
}

function parseJsonObject(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return {};
  }
}

function extractErrorMessage(parsed: unknown, fallback: string): string {
  if (typeof parsed === "object" && parsed !== null) {
    const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : "";
    const message =
      "message" in parsed && typeof parsed.message === "string" ? parsed.message : fallback;

    return [error, message]
      .filter((part) => part.length > 0)
      .join(": ")
      .slice(0, 240);
  }

  return fallback.slice(0, 240);
}

function blueskyUriToStableId(uri: string): string {
  return uri.replace(/^at:\/\//, "").replace(/\/app\.bsky\.feed\.post\//, "/");
}

function blueskyPostUrl(post: PostView): string {
  const rkey = post.uri.split("/").at(-1) ?? "";
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

function mergePipeLists(left: string, right: string): string {
  return uniqueStrings([...splitPipeList(left), ...splitPipeList(right)]).join(" | ");
}

function splitPipeList(value: string): string[] {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRepeatedOption(values: string[], defaults: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length === 0 ? defaults : uniqueStrings(normalized);
}

function normalizeServiceUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveProjectFilePath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function renderScrapeSummary(result: {
  accounts: BlueskyProfile[];
  failures: SearchFailure[];
  manifestPath: string;
  outputPath: string;
  postsFetched: number;
  queriesSucceeded: number;
  rowsAdded: number;
  rowsUpdated: number;
  since: string;
  totalRows: number;
  until: string;
}): string {
  const lines = [
    "Scraped Bluesky posts",
    "",
    `Accounts: ${result.accounts.map((account) => `${account.handle} (${account.did})`).join(", ")}`,
    `Window: ${result.since} to ${result.until}`,
    `Queries succeeded: ${result.queriesSucceeded}`,
    `Search hits fetched: ${result.postsFetched}`,
    `Rows added: ${result.rowsAdded}`,
    `Rows updated: ${result.rowsUpdated}`,
    `Total rows: ${result.totalRows}`,
    `CSV: ${result.outputPath}`,
    `Manifest: ${result.manifestPath}`
  ];

  if (result.failures.length > 0) {
    lines.push("");
    lines.push("Search failures:");

    for (const failure of result.failures) {
      lines.push(`- ${failure.query}: ${failure.status} ${failure.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export const defaultBlueskyScrapeOptions = {
  account: DEFAULT_ACCOUNT_HANDLES,
  appview: DEFAULT_APPVIEW_URL,
  limit: 300,
  manifest: DEFAULT_MANIFEST_PATH,
  output: DEFAULT_OUTPUT_PATH,
  query: DEFAULT_SEARCH_QUERIES,
  sinceDays: 30
} as const;
