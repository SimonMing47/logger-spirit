/// <reference lib="webworker" />

import type {
  SearchAggregation,
  SearchFilters,
  SearchOptions,
  SearchResult,
  TimelineEvent,
} from "@/types/logspace";

type IndexFilePayload = {
  workspaceId: string;
  fileKey: string;
  signature: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  text: string;
};

type IndexDeltaRequest = {
  type: "indexDelta";
  workspaceId: string;
  replace: boolean;
  files: IndexFilePayload[];
  removedFileKeys: string[];
  totalFiles: number;
};

type SearchRequest = {
  type: "search";
  requestId: string;
  workspaceId: string;
  query: string;
  options: SearchOptions;
};

type WorkerRequest = IndexDeltaRequest | SearchRequest;

type LineMeta = {
  timestamp?: number;
  traceId?: string;
  spanId?: string;
  pod?: string;
  container?: string;
  namespace?: string;
  level?: string;
  tags: string[];
};

type IndexedFile = {
  workspaceId: string;
  fileKey: string;
  signature: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  text: string;
  lowerText: string;
  lines: string[];
  lowerLines: string[];
  lineMetas: LineMeta[];
  anomalyTags: string[];
};

type WorkspaceIndexState = {
  files: Map<string, IndexedFile>;
  signatures: Map<string, string>;
};

type SearchResponse = {
  type: "searchResult";
  requestId: string;
  query: string;
  results: SearchResult[];
  matchedFiles: string[];
  aggregations: SearchAggregation;
  timeline: TimelineEvent[];
  totalIndexedFiles: number;
  error?: string;
};

type IndexStatusResponse = {
  type: "indexStatus";
  workspaceId: string;
  indexedFiles: number;
  changedFiles: number;
  totalFiles: number;
};

const MONTH_MAP: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

const workspaceIndexes = new Map<string, WorkspaceIndexState>();

function ensureWorkspace(workspaceId: string): WorkspaceIndexState {
  const existing = workspaceIndexes.get(workspaceId);
  if (existing) {
    return existing;
  }

  const created: WorkspaceIndexState = {
    files: new Map(),
    signatures: new Map(),
  };
  workspaceIndexes.set(workspaceId, created);
  return created;
}

function normalizeToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTimestamp(line: string): number | undefined {
  const isoMatch = line.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const nginxMatch = line.match(
    /\[(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]/,
  );

  if (nginxMatch) {
    const [, dayRaw, monthRaw, year, hms, offset] = nginxMatch;
    const day = dayRaw.padStart(2, "0");
    const month = MONTH_MAP[monthRaw] ?? "01";
    const offsetFixed = `${offset.slice(0, 3)}:${offset.slice(3)}`;
    const parsed = Date.parse(`${year}-${month}-${day}T${hms}${offsetFixed}`);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseLevel(line: string): string | undefined {
  const match = line.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/i);
  if (!match) {
    return undefined;
  }
  return match[1].toUpperCase();
}

function parseKeyValue(line: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const regex = new RegExp(`${key}=([^\\s"']+)`, "i");
    const match = line.match(regex);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function detectTags(line: string): string[] {
  const tags = new Set<string>();
  const lower = line.toLowerCase();

  if (lower.includes("timeout") || lower.includes("deadline exceeded")) {
    tags.add("timeout");
  }

  if (
    lower.includes("connection refused") ||
    lower.includes("conn refused") ||
    lower.includes("econnrefused")
  ) {
    tags.add("conn_refused");
  }

  if (lower.includes("retry") || lower.includes("backoff")) {
    tags.add("retry");
  }

  if (lower.includes("circuit breaker") || lower.includes("熔断")) {
    tags.add("circuit_breaker");
  }

  if (lower.includes("oom") || lower.includes("outofmemory")) {
    tags.add("oom");
  }

  if (lower.includes("throttl")) {
    tags.add("throttling");
  }

  if (lower.includes("unavailable") || lower.includes("503")) {
    tags.add("unavailable");
  }

  return [...tags];
}

function parseLineMeta(line: string): LineMeta {
  return {
    timestamp: parseTimestamp(line),
    traceId: normalizeToken(parseKeyValue(line, ["traceId", "trace_id", "trace"])),
    spanId: normalizeToken(parseKeyValue(line, ["spanId", "span_id", "span"])),
    pod: normalizeToken(parseKeyValue(line, ["pod", "podName", "pod_name"])),
    container: normalizeToken(
      parseKeyValue(line, ["container", "containerName", "container_name"]),
    ),
    namespace: normalizeToken(
      parseKeyValue(line, ["namespace", "ns", "k8s.namespace"]),
    ),
    level: parseLevel(line),
    tags: detectTags(line),
  };
}

function buildIndexedFile(payload: IndexFilePayload): IndexedFile {
  const lines = payload.text.split(/\r?\n/);
  const lowerLines = lines.map((line) => line.toLowerCase());
  const lineMetas = lines.map((line) => parseLineMeta(line));

  let retryCount = 0;
  const anomalySet = new Set<string>();

  lineMetas.forEach((meta) => {
    meta.tags.forEach((tag) => {
      anomalySet.add(tag);
      if (tag === "retry") {
        retryCount += 1;
      }
    });
  });

  if (retryCount >= 20) {
    anomalySet.add("retry_storm");
  }

  return {
    workspaceId: payload.workspaceId,
    fileKey: payload.fileKey,
    signature: payload.signature,
    rootId: payload.rootId,
    sourceName: payload.sourceName,
    filePath: payload.filePath,
    text: payload.text,
    lowerText: payload.text.toLowerCase(),
    lines,
    lowerLines,
    lineMetas,
    anomalyTags: [...anomalySet],
  };
}

function applyIndexDelta(request: IndexDeltaRequest): IndexStatusResponse {
  const workspace = ensureWorkspace(request.workspaceId);

  if (request.replace) {
    workspace.files.clear();
    workspace.signatures.clear();
  }

  request.removedFileKeys.forEach((fileKey) => {
    workspace.files.delete(fileKey);
    workspace.signatures.delete(fileKey);
  });

  for (const file of request.files) {
    const prev = workspace.signatures.get(file.fileKey);
    if (prev === file.signature) {
      continue;
    }

    const indexed = buildIndexedFile(file);
    workspace.files.set(file.fileKey, indexed);
    workspace.signatures.set(file.fileKey, file.signature);
  }

  return {
    type: "indexStatus",
    workspaceId: request.workspaceId,
    indexedFiles: workspace.files.size,
    changedFiles: request.files.length,
    totalFiles: request.totalFiles,
  };
}

function includesCaseAware(
  raw: string,
  lower: string,
  query: string,
  options: SearchOptions,
): boolean {
  if (options.caseSensitive) {
    return raw.includes(query);
  }
  return lower.includes(query.toLowerCase());
}

function matchesFilters(meta: LineMeta, filters: SearchFilters): boolean {
  if (filters.level && meta.level !== filters.level.toUpperCase()) {
    return false;
  }

  if (filters.pod) {
    const expected = filters.pod.toLowerCase();
    if (!meta.pod || !meta.pod.toLowerCase().includes(expected)) {
      return false;
    }
  }

  if (filters.container) {
    const expected = filters.container.toLowerCase();
    if (!meta.container || !meta.container.toLowerCase().includes(expected)) {
      return false;
    }
  }

  if (filters.namespace) {
    const expected = filters.namespace.toLowerCase();
    if (!meta.namespace || !meta.namespace.toLowerCase().includes(expected)) {
      return false;
    }
  }

  if (typeof filters.timeFrom === "number") {
    if (!meta.timestamp || meta.timestamp < filters.timeFrom) {
      return false;
    }
  }

  if (typeof filters.timeTo === "number") {
    if (!meta.timestamp || meta.timestamp > filters.timeTo) {
      return false;
    }
  }

  return true;
}

function createAggregation(): SearchAggregation {
  return {
    byLevel: {},
    byPod: {},
    byNamespace: {},
    bySource: {},
    byTag: {},
  };
}

function addCount(bucket: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function compressPreview(line: string, maxLength = 160): string {
  const normalized = line.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function runSearch(request: SearchRequest): SearchResponse {
  const workspace = ensureWorkspace(request.workspaceId);

  const aggregation = createAggregation();
  const timeline: TimelineEvent[] = [];
  const matchedFiles = new Set<string>();

  const query = request.query.trim();
  const { options } = request;
  const hasAnyFilter = Boolean(
    options.filters.level ||
      options.filters.namespace ||
      options.filters.pod ||
      options.filters.container ||
      typeof options.filters.timeFrom === "number" ||
      typeof options.filters.timeTo === "number",
  );

  if (!query && !hasAnyFilter) {
    return {
      type: "searchResult",
      requestId: request.requestId,
      query,
      results: [],
      matchedFiles: [],
      aggregations: aggregation,
      timeline,
      totalIndexedFiles: workspace.files.size,
    };
  }

  let regex: RegExp | null = null;

  if (options.regex) {
    try {
      regex = new RegExp(query, options.caseSensitive ? "" : "i");
    } catch (error) {
      return {
        type: "searchResult",
        requestId: request.requestId,
        query,
        results: [],
        matchedFiles: [],
        aggregations: aggregation,
        timeline,
        totalIndexedFiles: workspace.files.size,
        error: `正则表达式无效: ${String(error)}`,
      };
    }
  }

  const context = Math.max(0, Math.min(options.contextLines, 8));
  const maxResults = Math.max(20, Math.min(options.maxResults, 3000));

  const results: SearchResult[] = [];

  for (const entry of workspace.files.values()) {
    const fileMatchedTags = new Set<string>();

    if (regex ? !regex.test(entry.text) : !includesCaseAware(entry.text, entry.lowerText, query, options)) {
      // Keep scanning if filters exist without explicit query.
      if (query) {
        continue;
      }
    }

    for (let index = 0; index < entry.lines.length; index += 1) {
      const line = entry.lines[index];
      const lineLower = entry.lowerLines[index];
      const meta = entry.lineMetas[index];

      const queryMatched = query
        ? regex
          ? regex.test(line)
          : includesCaseAware(line, lineLower, query, options)
        : true;

      if (!queryMatched) {
        continue;
      }

      if (!matchesFilters(meta, options.filters)) {
        continue;
      }

      meta.tags.forEach((tag) => fileMatchedTags.add(tag));

      const result: SearchResult = {
        id: `${entry.fileKey}:${index}`,
        fileKey: entry.fileKey,
        rootId: entry.rootId,
        sourceName: entry.sourceName,
        filePath: entry.filePath,
        line: index + 1,
        preview: compressPreview(line),
        before: entry.lines.slice(Math.max(0, index - context), index),
        after: entry.lines.slice(index + 1, index + 1 + context),
        timestamp: meta.timestamp,
        traceId: meta.traceId,
        spanId: meta.spanId,
        pod: meta.pod,
        container: meta.container,
        namespace: meta.namespace,
        level: meta.level,
        tags: [...meta.tags],
      };

      results.push(result);
      matchedFiles.add(entry.fileKey);

      addCount(aggregation.bySource, entry.sourceName);
      addCount(aggregation.byLevel, meta.level);
      addCount(aggregation.byPod, meta.pod);
      addCount(aggregation.byNamespace, meta.namespace);
      meta.tags.forEach((tag) => addCount(aggregation.byTag, tag));

      if (meta.timestamp || meta.traceId || meta.spanId) {
        timeline.push({
          id: `tl:${entry.fileKey}:${index}`,
          timestamp: meta.timestamp,
          traceId: meta.traceId,
          spanId: meta.spanId,
          rootId: entry.rootId,
          sourceName: entry.sourceName,
          filePath: entry.filePath,
          line: index + 1,
          message: compressPreview(line, 140),
          level: meta.level,
        });
      }

      if (results.length >= maxResults) {
        break;
      }
    }

    entry.anomalyTags.forEach((tag) => {
      if (matchedFiles.has(entry.fileKey)) {
        addCount(aggregation.byTag, tag);
      }
    });

    fileMatchedTags.forEach((tag) => addCount(aggregation.byTag, tag));

    if (results.length >= maxResults) {
      break;
    }
  }

  timeline.sort((a, b) => {
    if (typeof a.timestamp === "number" && typeof b.timestamp === "number") {
      return a.timestamp - b.timestamp;
    }
    if (typeof a.timestamp === "number") {
      return -1;
    }
    if (typeof b.timestamp === "number") {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    type: "searchResult",
    requestId: request.requestId,
    query,
    results,
    matchedFiles: [...matchedFiles],
    aggregations: aggregation,
    timeline: timeline.slice(0, 500),
    totalIndexedFiles: workspace.files.size,
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "indexDelta") {
    const status = applyIndexDelta(request);
    self.postMessage(status satisfies IndexStatusResponse);
    return;
  }

  if (request.type === "search") {
    const response = runSearch(request);
    self.postMessage(response satisfies SearchResponse);
  }
};
