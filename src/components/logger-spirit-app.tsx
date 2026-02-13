"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CanvasBoard } from "@/components/canvas-board";
import { VirtualList, type VirtualListHandle } from "@/components/virtual-list";
import { extractArchiveRecursively } from "@/lib/archive";
import {
  APP_DATA_DIR,
  WORKSPACES_DIR,
  deleteWorkspaceData,
  loadWorkspaceIndex,
  loadRememberedRootDirectoryHandle,
  loadWorkspaceManifest,
  pickDirectory,
  queryDirectoryPermission,
  readBinaryFile,
  rememberRootDirectoryHandle,
  requestDirectoryPermission,
  saveWorkspaceIndex,
  saveWorkspaceManifest,
  supportsFileSystemApi,
  writeBinaryFile,
} from "@/lib/file-system";
import { getBaseName, joinPath } from "@/lib/path";
import { decodeText } from "@/lib/text";
import { buildRootTree } from "@/lib/tree";
import type {
  CanvasItem,
  CanvasShape,
  CanvasState,
  LogReference,
  RootArchive,
  SearchAggregation,
  SearchOptions,
  SearchResult,
  TimelineEvent,
  TreeNode,
  WorkspaceManifest,
  WorkspaceSummary,
} from "@/types/logspace";

type ResizeTarget = "left" | "right";

type ResizeSession = {
  target: ResizeTarget;
  startX: number;
  startLeft: number;
  startRight: number;
  move: (event: PointerEvent) => void;
  up: () => void;
};

type HorizontalResizeSession = {
  move: (event: PointerEvent) => void;
  up: () => void;
};

type SearchResizeSession = {
  move: (event: PointerEvent) => void;
  up: () => void;
};

type LogTab = {
  key: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  title: string;
};

type ViewerCacheEntry = {
  rootId: string;
  sourceName: string;
  filePath: string;
  viewerFileName: string;
  binary: boolean;
  totalLines: number;
  lines: string[];
};

type SearchIndexFilePayload = {
  workspaceId: string;
  fileKey: string;
  signature: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  text: string;
};

type WorkerIndexStatusMessage = {
  type: "indexStatus";
  workspaceId: string;
  indexedFiles: number;
  changedFiles: number;
  totalFiles: number;
};

type WorkerSearchResultMessage = {
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

type WorkerMessage = WorkerIndexStatusMessage | WorkerSearchResultMessage;

type IndexStatusState = {
  indexing: boolean;
  indexedFiles: number;
  changedFiles: number;
  totalFiles: number;
};

const LOCAL_STORAGE_LAST_WORKSPACE_KEY = "logger-spirit:last-workspace-id";
const LOCAL_STORAGE_THEME_KEY = "logger-spirit:theme";
const LOCAL_STORAGE_UI_PREFS_KEY = "logger-spirit:ui-prefs";
const LOCAL_STORAGE_SEARCH_PREFS_KEY = "logger-spirit:search-prefs";
const COLLAPSED_PANE_WIDTH = 44;
const RESIZER_WIDTH = 8;
const MIN_LEFT_WIDTH = 320;
const MIN_CENTER_WIDTH = 420;
const MIN_RIGHT_WIDTH = 330;

const MAX_VIEW_LINES = 8000;
const MAX_INDEX_FILE_BYTES = 24 * 1024 * 1024;

const DEFAULT_INDEX_STATUS: IndexStatusState = {
  indexing: false,
  indexedFiles: 0,
  changedFiles: 0,
  totalFiles: 0,
};

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  regex: false,
  caseSensitive: false,
  realtime: true,
  contextLines: 2,
  maxResults: 600,
  filters: {},
};

const DEFAULT_SEARCH_AGGREGATION: SearchAggregation = {
  byLevel: {},
  byPod: {},
  byNamespace: {},
  bySource: {},
  byTag: {},
};

const DEFAULT_CANVAS: CanvasState = {
  zoom: 1,
  offsetX: 20,
  offsetY: 20,
  items: [],
  shapes: [],
  activeColor: "#3568ff",
  strokeWidth: 2,
};

const CANVAS_HISTORY_LIMIT = 120;

type ThemeMode = "sky" | "graphite" | "forest" | "cyberpunk";

type UiPrefs = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightSplitRatio: number;
  searchResultsHeight: number;
  centerSplitRatio: number;
  showAdvancedSearch: boolean;
  showSearchInsights: boolean;
  treeFilter: string;
  treeOnlyMatched: boolean;
};

type SearchPrefs = Pick<SearchOptions, "regex" | "caseSensitive" | "realtime" | "contextLines" | "maxResults"> &
  Pick<SearchOptions, "filters">;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type HighlightSpec =
  | {
      kind: "text";
      needle: string;
      needleLower: string;
      caseSensitive: boolean;
    }
  | {
      kind: "regex";
      regex: RegExp;
    };

function buildHighlightSpec(
  query: string,
  options: Pick<SearchOptions, "regex" | "caseSensitive">,
): HighlightSpec | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  if (options.regex) {
    try {
      const flags = options.caseSensitive ? "g" : "gi";
      return { kind: "regex", regex: new RegExp(trimmed, flags) };
    } catch {
      return null;
    }
  }

  return {
    kind: "text",
    needle: trimmed,
    needleLower: trimmed.toLocaleLowerCase(),
    caseSensitive: options.caseSensitive,
  };
}

function highlightText(
  text: string,
  spec: HighlightSpec | null,
  options?: { hitClassName?: string },
): ReactNode {
  if (!spec) {
    return text || " ";
  }

  if (!text) {
    return " ";
  }

  const hitClassName = options?.hitClassName ?? "log-hit";
  const parts: ReactNode[] = [];
  const maxHits = 64;

  if (spec.kind === "text") {
    const haystack = spec.caseSensitive ? text : text.toLocaleLowerCase();
    const needle = spec.caseSensitive ? spec.needle : spec.needleLower;

    if (!needle) {
      return text;
    }

    let fromIndex = 0;
    let hits = 0;

    while (fromIndex < text.length) {
      const index = haystack.indexOf(needle, fromIndex);
      if (index === -1 || hits >= maxHits) {
        break;
      }

      if (index > fromIndex) {
        parts.push(text.slice(fromIndex, index));
      }

      parts.push(
        <span key={`${index}-${hits}`} className="log-hit">
          {text.slice(index, index + needle.length)}
        </span>,
      );

      fromIndex = index + needle.length;
      hits += 1;
    }

    if (fromIndex < text.length) {
      parts.push(text.slice(fromIndex));
    }

    return parts.length > 0 ? parts : text;
  }

  const regex = spec.regex;
  regex.lastIndex = 0;

  let cursor = 0;
  let hits = 0;

  while (cursor < text.length) {
    const match = regex.exec(text);
    if (!match || hits >= maxHits) {
      break;
    }

    const start = match.index;
    const value = match[0] ?? "";
    const end = start + value.length;

    if (end <= cursor) {
      regex.lastIndex = Math.min(text.length, cursor + 1);
      continue;
    }

    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }

    parts.push(
      <span key={`${start}-${hits}`} className={hitClassName}>
        {text.slice(start, end)}
      </span>,
    );

    cursor = end;
    hits += 1;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length > 0 ? parts : text;
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function searchFileKey(rootId: string, filePath: string): string {
  return `${rootId}::${filePath}`;
}

function logRefKey(rootId: string, filePath: string, line: number): string {
  return `${rootId}::${filePath}::${line}`;
}

function workspaceFilePath(
  workspace: Pick<WorkspaceManifest, "id" | "storageFolder">,
  rootFolder: string,
  filePath: string,
): string {
  const baseFolder =
    typeof workspace.storageFolder === "string" && workspace.storageFolder.trim()
      ? workspace.storageFolder
      : legacyWorkspaceStorageFolder(workspace.id);
  return joinPath(baseFolder, rootFolder, filePath);
}

function legacyWorkspaceStorageFolder(workspaceId: string): string {
  return joinPath(APP_DATA_DIR, WORKSPACES_DIR, workspaceId);
}

function createWorkspaceStorageFolder(name: string, workspaceId: string): string {
  return `${sanitizeFolderName(name)}-${workspaceId.slice(-8)}`;
}

function toSummary(manifest: WorkspaceManifest): WorkspaceSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    storageFolder: manifest.storageFolder,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

function normalizeWorkspaceSummary(summary: WorkspaceSummary): WorkspaceSummary {
  const storageFolder =
    typeof summary.storageFolder === "string" && summary.storageFolder.trim()
      ? summary.storageFolder
      : legacyWorkspaceStorageFolder(summary.id);

  return {
    ...summary,
    storageFolder,
  };
}

function normalizeCanvasItem(item: CanvasItem): CanvasItem {
  return {
    ...item,
    kind: item.kind === "text" ? "text" : "note",
    textColor: item.textColor ?? (item.kind === "text" ? item.color : "#24325f"),
    width: item.width ?? (item.kind === "note" ? 240 : undefined),
    comment: typeof item.comment === "string" ? item.comment : "",
  };
}

function normalizeCanvasShape(shape: CanvasShape): CanvasShape {
  return {
    ...shape,
    strokeWidth:
      typeof shape.strokeWidth === "number" && shape.strokeWidth > 0
        ? shape.strokeWidth
        : 2,
  };
}

function normalizeCanvasState(canvas: WorkspaceManifest["canvas"] | undefined): CanvasState {
  return {
    zoom: typeof canvas?.zoom === "number" ? canvas.zoom : DEFAULT_CANVAS.zoom,
    offsetX:
      typeof canvas?.offsetX === "number" ? canvas.offsetX : DEFAULT_CANVAS.offsetX,
    offsetY:
      typeof canvas?.offsetY === "number" ? canvas.offsetY : DEFAULT_CANVAS.offsetY,
    items: Array.isArray(canvas?.items)
      ? canvas.items.map((item) => normalizeCanvasItem(item))
      : [],
    shapes: Array.isArray(canvas?.shapes)
      ? canvas.shapes.map((shape) => normalizeCanvasShape(shape))
      : [],
    activeColor:
      typeof canvas?.activeColor === "string"
        ? canvas.activeColor
        : DEFAULT_CANVAS.activeColor,
    strokeWidth:
      typeof canvas?.strokeWidth === "number" && canvas.strokeWidth > 0
        ? canvas.strokeWidth
        : DEFAULT_CANVAS.strokeWidth,
  };
}

function normalizeManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  const storageFolder =
    typeof manifest.storageFolder === "string" && manifest.storageFolder.trim()
      ? manifest.storageFolder
      : legacyWorkspaceStorageFolder(manifest.id);

  return {
    ...manifest,
    storageFolder,
    notes: normalizeNotesContent(manifest.notes),
    canvas: normalizeCanvasState(manifest.canvas),
  };
}

function createWorkspace(name: string): WorkspaceManifest {
  const now = Date.now();
  const id = createId("workspace");

  return {
    version: 1,
    id,
    name,
    storageFolder: createWorkspaceStorageFolder(name, id),
    createdAt: now,
    updatedAt: now,
    roots: [],
    notes: "",
    canvas: { ...DEFAULT_CANVAS },
  };
}

function collectDirectoryNodeIds(node: TreeNode, collector: Set<string>): void {
  if (node.kind !== "dir") {
    return;
  }
  collector.add(node.id);
  node.children?.forEach((child) => collectDirectoryNodeIds(child, collector));
}

function collectAncestorNodeIds(rootId: string, filePath: string): string[] {
  const segments = filePath.split("/").filter(Boolean);
  const ids = [`${rootId}:/`];

  for (let index = 1; index < segments.length; index += 1) {
    ids.push(`${rootId}:${segments.slice(0, index).join("/")}`);
  }

  return ids;
}

function parseDateTimeInput(value: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return timestamp;
}

const MONTH_TOKEN_MAP: Record<string, string> = {
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

function parseLogLineTimestamp(line: string): number | undefined {
  const isoMatch = line.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const plainMatch = line.match(
    /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})([.,]\d{3,6})?/,
  );
  if (plainMatch) {
    const [, date, time, fractionRaw] = plainMatch;
    const fraction = fractionRaw ? fractionRaw.replace(",", ".") : "";
    const parsed = Date.parse(`${date}T${time}${fraction}`);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const nginxMatch = line.match(
    /\[(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]/,
  );
  if (nginxMatch) {
    const [, dayRaw, monthRaw, year, hms, offset] = nginxMatch;
    const month = MONTH_TOKEN_MAP[monthRaw] ?? "01";
    const day = dayRaw.padStart(2, "0");
    const offsetFixed = `${offset.slice(0, 3)}:${offset.slice(3)}`;
    const parsed = Date.parse(`${year}-${month}-${day}T${hms}${offsetFixed}`);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function sortCountEntries(bucket: Record<string, number>): Array<[string, number]> {
  return Object.entries(bucket).sort((a, b) => b[1] - a[1]);
}

function stripArchiveSuffix(fileName: string): string {
  return fileName.replace(/\.(tar\.gz|tgz|zip|tar|gz)$/i, "");
}

function sanitizeFolderName(raw: string): string {
  const safe = raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (!safe) {
    return "archive";
  }

  return safe.slice(0, 72);
}

function normalizeWorkspaceName(raw: string): string {
  return raw.trim().toLocaleLowerCase();
}

function hasWorkspaceNameCollision(
  name: string,
  summaries: WorkspaceSummary[],
  ignoreId?: string,
): boolean {
  const normalized = normalizeWorkspaceName(name);
  if (!normalized) {
    return false;
  }

  return summaries.some((item) => {
    if (ignoreId && item.id === ignoreId) {
      return false;
    }
    return normalizeWorkspaceName(item.name) === normalized;
  });
}

function createDefaultWorkspaceBaseName(): string {
  const now = new Date();
  const yyyy = `${now.getFullYear()}`;
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `日志空间-${yyyy}${mm}${dd}`;
}

function createUniqueWorkspaceName(
  preferredName: string,
  summaries: WorkspaceSummary[],
): string {
  const base = preferredName.trim() || "日志空间";
  let candidate = base;
  let index = 2;

  while (hasWorkspaceNameCollision(candidate, summaries)) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeNotesContent(notes: string | undefined): string {
  if (!notes) {
    return "";
  }

  const trimmed = notes.trim();
  if (!trimmed) {
    return "";
  }

  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return notes;
  }

  return escapeHtml(notes).replace(/\n/g, "<br>");
}

export function LoggerSpiritApp() {
  const [clientReady, setClientReady] = useState(false);
  const [isFsSupported, setIsFsSupported] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("sky");
  const [pickingDirectoryFromWelcome, setPickingDirectoryFromWelcome] = useState(false);
  const [restoringDirectoryHandle, setRestoringDirectoryHandle] = useState(true);
  const [rememberedDirectoryHandle, setRememberedDirectoryHandle] =
    useState<FileSystemDirectoryHandle | null>(null);

  const [directoryHandle, setDirectoryHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [storageName, setStorageName] = useState("未选择目录");

  const [workspaceSummaries, setWorkspaceSummaries] = useState<WorkspaceSummary[]>(
    [],
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceManifest | null>(
    null,
  );

  const [status, setStatus] = useState("请先选择日志主存储目录");
  const [importing, setImporting] = useState(false);
  const [draggingArchive, setDraggingArchive] = useState(false);

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [searchMatchedFiles, setSearchMatchedFiles] = useState<Set<string>>(
    new Set(),
  );
  const [treeFilter, setTreeFilter] = useState("");
  const [treeOnlyMatched, setTreeOnlyMatched] = useState(false);
  const [treeAutoExpandBackup, setTreeAutoExpandBackup] = useState<string[] | null>(null);

  const [openTabs, setOpenTabs] = useState<LogTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [viewerCache, setViewerCache] = useState<Record<string, ViewerCacheEntry>>({});
  const [viewerLoading, setViewerLoading] = useState(false);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [activeLogRef, setActiveLogRef] = useState<string | null>(null);
  const [selectedSnippet, setSelectedSnippet] = useState("");

  const [viewerFindOpen, setViewerFindOpen] = useState(false);
  const [viewerFindQuery, setViewerFindQuery] = useState("");
  const [viewerFindCaseSensitive, setViewerFindCaseSensitive] = useState(false);
  const [viewerFindMatchIndex, setViewerFindMatchIndex] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [timeFromInput, setTimeFromInput] = useState("");
  const [timeToInput, setTimeToInput] = useState("");
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [showSearchInsights, setShowSearchInsights] = useState(true);
  const [searchResultsHeight, setSearchResultsHeight] = useState(208);
  const [contextResult, setContextResult] = useState<SearchResult | null>(null);
  const [centerSplitRatio, setCenterSplitRatio] = useState(0.3);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAggregation, setSearchAggregation] = useState<SearchAggregation>(
    DEFAULT_SEARCH_AGGREGATION,
  );
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);

  const [indexStatus, setIndexStatus] = useState<IndexStatusState>(DEFAULT_INDEX_STATUS);

  const [leftWidth, setLeftWidth] = useState(320);
  const [rightWidth, setRightWidth] = useState(380);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const [rightSplitRatio, setRightSplitRatio] = useState(0.22);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createWorkspaceName, setCreateWorkspaceName] = useState("线上问题-2026-02");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [canvasDraft, setCanvasDraft] = useState<CanvasState>(DEFAULT_CANVAS);
  const [canvasHistoryState, setCanvasHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [notesColor, setNotesColor] = useState("#1f2b4d");
  const [notesFontSize, setNotesFontSize] = useState("3");
  const [notesMentionQuery, setNotesMentionQuery] = useState("");
  const [notesMentionOpen, setNotesMentionOpen] = useState(false);
  const [notesMentionPosition, setNotesMentionPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceSummary | null>(
    null,
  );
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceName, setRenamingWorkspaceName] = useState("");
  const [renamingWorkspaceBusy, setRenamingWorkspaceBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const notesEditorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const viewerFindInputRef = useRef<HTMLInputElement | null>(null);
  const viewerListRef = useRef<VirtualListHandle | null>(null);
  const treeFilterInputRef = useRef<HTMLInputElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const commandLastFocusRef = useRef<HTMLElement | null>(null);

  const saveTimerRef = useRef<number | null>(null);
  const pendingManifestRef = useRef<WorkspaceManifest | null>(null);
  const canvasSaveTimerRef = useRef<number | null>(null);
  const canvasDirtyRef = useRef(false);
  const canvasDraftRef = useRef<CanvasState>(DEFAULT_CANVAS);
  const canvasHistoryRef = useRef<{
    workspaceId: string;
    past: CanvasState[];
    future: CanvasState[];
  }>({ workspaceId: "", past: [], future: [] });

  const layoutRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const searchInsightsRef = useRef<HTMLDivElement | null>(null);
  const centerSplitRef = useRef<HTMLDivElement | null>(null);
  const centerSplitBackupRef = useRef<number | null>(null);

  const verticalResizeRef = useRef<ResizeSession | null>(null);
  const horizontalResizeRef = useRef<HorizontalResizeSession | null>(null);
  const searchResizeRef = useRef<SearchResizeSession | null>(null);
  const centerSplitResizeRef = useRef<HorizontalResizeSession | null>(null);

  const searchWorkerRef = useRef<Worker | null>(null);
  const latestSearchRequestIdRef = useRef("");
  const indexedSignaturesRef = useRef<Map<string, Map<string, string>>>(new Map());
  const activeWorkspaceIdRef = useRef("");
  const activeWorkspaceRef = useRef<WorkspaceManifest | null>(null);
  const activeViewerRef = useRef<ViewerCacheEntry | null>(null);

  const paneSnapshotRef = useRef({
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
  });

  const pendingSearchAfterIndexRef = useRef(false);
  const indexingWasActiveRef = useRef(false);
  const expandedNodesRef = useRef<Set<string>>(new Set());

  const hasSearchInput = useMemo(() => {
    if (searchQuery.trim()) {
      return true;
    }

    const filters = searchOptions.filters;
    return Boolean(
      filters.pod ||
        filters.container ||
        filters.namespace ||
        filters.level ||
        filters.timeFrom ||
      filters.timeTo,
    );
  }, [searchOptions.filters, searchQuery]);

  const viewerHighlightSpec = useMemo(
    () =>
      buildHighlightSpec(searchQuery, {
        regex: searchOptions.regex,
        caseSensitive: searchOptions.caseSensitive,
      }),
    [searchOptions.caseSensitive, searchOptions.regex, searchQuery],
  );

  const viewerFindSpec = useMemo(
    () =>
      buildHighlightSpec(viewerFindQuery, {
        regex: false,
        caseSensitive: viewerFindCaseSensitive,
      }),
    [viewerFindCaseSensitive, viewerFindQuery],
  );

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.key === activeTabKey) ?? null,
    [activeTabKey, openTabs],
  );

  const activeViewer = activeTabKey ? viewerCache[activeTabKey] : undefined;
  activeViewerRef.current = activeViewer ?? null;

  const viewerFindMatches = useMemo(() => {
    if (!viewerFindOpen) {
      return [];
    }

    const viewer = activeViewer;
    if (!viewer || viewer.binary) {
      return [];
    }

    const query = viewerFindQuery.trim();
    if (!query) {
      return [];
    }

    const needle = viewerFindCaseSensitive ? query : query.toLowerCase();
    const matches: number[] = [];

    viewer.lines.forEach((line, index) => {
      const haystack = viewerFindCaseSensitive ? line : line.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push(index);
      }
    });

    return matches;
  }, [activeViewer, viewerFindCaseSensitive, viewerFindOpen, viewerFindQuery]);

  const searchHitCounts = useMemo(() => {
    const counts = new Map<string, number>();
    searchResults.forEach((result) => {
      counts.set(result.fileKey, (counts.get(result.fileKey) ?? 0) + 1);
    });
    return counts;
  }, [searchResults]);

  const linkedLogRefSet = useMemo(() => {
    const refs = new Set<string>();
    canvasDraft.items.forEach((item) => {
      if (!item.link) {
        return;
      }
      refs.add(logRefKey(item.link.rootId, item.link.filePath, item.link.line));
    });
    return refs;
  }, [canvasDraft.items]);

  const noteMentionTargets = useMemo(() => {
    if (!activeWorkspace) {
      return [];
    }

    return activeWorkspace.roots.flatMap((root) =>
      root.files.map((file) => ({
        rootId: root.id,
        sourceName: root.sourceName,
        filePath: file.path,
        label: `${root.sourceName} / ${file.path}`,
      })),
    );
  }, [activeWorkspace]);

  const filteredNoteMentions = useMemo(() => {
    if (!notesMentionOpen) {
      return [];
    }

    const keyword = notesMentionQuery.trim().toLocaleLowerCase();
    if (!keyword) {
      return noteMentionTargets.slice(0, 12);
    }

    return noteMentionTargets
      .filter((item) => item.label.toLocaleLowerCase().includes(keyword))
      .slice(0, 12);
  }, [notesMentionOpen, notesMentionQuery, noteMentionTargets]);

  useEffect(() => {
    paneSnapshotRef.current = {
      leftWidth,
      rightWidth,
      leftCollapsed,
      rightCollapsed,
    };
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    setClientReady(true);
    setIsFsSupported(supportsFileSystemApi());
  }, []);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const savedTheme = window.localStorage.getItem(LOCAL_STORAGE_THEME_KEY);
    if (
      savedTheme === "sky" ||
      savedTheme === "graphite" ||
      savedTheme === "forest" ||
      savedTheme === "cyberpunk"
    ) {
      setTheme(savedTheme);
    }
  }, [clientReady]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    window.localStorage.setItem(LOCAL_STORAGE_THEME_KEY, theme);
    document.body.dataset.theme = theme;
  }, [clientReady, theme]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const rawUiPrefs = window.localStorage.getItem(LOCAL_STORAGE_UI_PREFS_KEY);
    if (rawUiPrefs) {
      try {
        const prefs = JSON.parse(rawUiPrefs) as Partial<UiPrefs>;
        if (typeof prefs.leftWidth === "number") {
          setLeftWidth(clamp(prefs.leftWidth, MIN_LEFT_WIDTH, 720));
        }
        if (typeof prefs.rightWidth === "number") {
          setRightWidth(clamp(prefs.rightWidth, MIN_RIGHT_WIDTH, 980));
        }
        if (typeof prefs.leftCollapsed === "boolean") {
          setLeftCollapsed(prefs.leftCollapsed);
        }
        if (typeof prefs.rightCollapsed === "boolean") {
          setRightCollapsed(prefs.rightCollapsed);
        }
        if (typeof prefs.rightSplitRatio === "number") {
          setRightSplitRatio(clamp(prefs.rightSplitRatio, 0.12, 0.68));
        }
        if (typeof prefs.searchResultsHeight === "number") {
          setSearchResultsHeight(clamp(prefs.searchResultsHeight, 110, 520));
        }
        if (typeof prefs.centerSplitRatio === "number") {
          setCenterSplitRatio(clamp(prefs.centerSplitRatio, 0.08, 0.7));
        }
        if (typeof prefs.showAdvancedSearch === "boolean") {
          setShowAdvancedSearch(prefs.showAdvancedSearch);
        }
        if (typeof prefs.showSearchInsights === "boolean") {
          setShowSearchInsights(prefs.showSearchInsights);
        }
        if (typeof prefs.treeFilter === "string") {
          setTreeFilter(prefs.treeFilter);
        }
        if (typeof prefs.treeOnlyMatched === "boolean") {
          setTreeOnlyMatched(prefs.treeOnlyMatched);
        }
      } catch {
        // Ignore malformed prefs
      }
    }

    const rawSearchPrefs = window.localStorage.getItem(LOCAL_STORAGE_SEARCH_PREFS_KEY);
    if (rawSearchPrefs) {
      try {
        const prefs = JSON.parse(rawSearchPrefs) as Partial<SearchPrefs>;
        setSearchOptions((current) => ({
          ...current,
          regex: typeof prefs.regex === "boolean" ? prefs.regex : current.regex,
          caseSensitive:
            typeof prefs.caseSensitive === "boolean"
              ? prefs.caseSensitive
              : current.caseSensitive,
          realtime:
            typeof prefs.realtime === "boolean" ? prefs.realtime : current.realtime,
          contextLines:
            typeof prefs.contextLines === "number"
              ? clamp(prefs.contextLines, 0, 8)
              : current.contextLines,
          maxResults:
            typeof prefs.maxResults === "number"
              ? clamp(prefs.maxResults, 50, 3000)
              : current.maxResults,
          filters: prefs.filters ? { ...current.filters, ...prefs.filters } : current.filters,
        }));
      } catch {
        // Ignore malformed prefs
      }
    }
  }, [clientReady]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const prefs: UiPrefs = {
      leftWidth,
      rightWidth,
      leftCollapsed,
      rightCollapsed,
      rightSplitRatio,
      searchResultsHeight,
      centerSplitRatio,
      showAdvancedSearch,
      showSearchInsights,
      treeFilter,
      treeOnlyMatched,
    };

    window.localStorage.setItem(LOCAL_STORAGE_UI_PREFS_KEY, JSON.stringify(prefs));
  }, [
    centerSplitRatio,
    clientReady,
    leftCollapsed,
    leftWidth,
    rightCollapsed,
    rightSplitRatio,
    rightWidth,
    searchResultsHeight,
    showAdvancedSearch,
    showSearchInsights,
    treeFilter,
    treeOnlyMatched,
  ]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const prefs: SearchPrefs = {
      regex: searchOptions.regex,
      caseSensitive: searchOptions.caseSensitive,
      realtime: searchOptions.realtime,
      contextLines: searchOptions.contextLines,
      maxResults: searchOptions.maxResults,
      filters: searchOptions.filters,
    };

    window.localStorage.setItem(LOCAL_STORAGE_SEARCH_PREFS_KEY, JSON.stringify(prefs));
  }, [clientReady, searchOptions]);

  useEffect(() => {
    if (!clientReady || !activeWorkspaceId) {
      return;
    }

    window.localStorage.setItem(LOCAL_STORAGE_LAST_WORKSPACE_KEY, activeWorkspaceId);
  }, [activeWorkspaceId, clientReady]);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace;
  }, [activeWorkspace]);

  const activeWorkspaceIdentity = activeWorkspace?.id ?? "";

  useEffect(() => {
    const currentWorkspace = activeWorkspaceRef.current;
    if (!currentWorkspace) {
      canvasDraftRef.current = DEFAULT_CANVAS;
      canvasDirtyRef.current = false;
      setCanvasDraft(DEFAULT_CANVAS);
      canvasHistoryRef.current = { workspaceId: "", past: [], future: [] };
      setCanvasHistoryState({ canUndo: false, canRedo: false });
      return;
    }

    const normalized = normalizeCanvasState(currentWorkspace.canvas);
    canvasDraftRef.current = normalized;
    canvasDirtyRef.current = false;
    setCanvasDraft(normalized);
    canvasHistoryRef.current = { workspaceId: currentWorkspace.id, past: [], future: [] };
    setCanvasHistoryState({ canUndo: false, canRedo: false });
  }, [activeWorkspaceIdentity]);

  useEffect(() => {
    const editor = notesEditorRef.current;
    if (!editor) {
      return;
    }

    const next = activeWorkspaceRef.current?.notes ?? "";
    if (editor.innerHTML !== next) {
      editor.innerHTML = next;
    }
  }, [activeWorkspaceIdentity]);

  useEffect(() => {
    setNotesMentionOpen(false);
    setNotesMentionQuery("");
    setNotesMentionPosition(null);
  }, [activeWorkspaceIdentity]);

  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (directoryHandle && pendingManifestRef.current) {
      await saveWorkspaceManifest(directoryHandle, pendingManifestRef.current);
      pendingManifestRef.current = null;
    }
  }, [directoryHandle]);

  const persistWorkspaceSummary = useCallback(
    (manifest: WorkspaceManifest) => {
      setWorkspaceSummaries((previous) => {
        const next = [
          toSummary(manifest),
          ...previous.filter((item) => item.id !== manifest.id),
        ].sort((a, b) => b.updatedAt - a.updatedAt);

        if (directoryHandle) {
          void saveWorkspaceIndex(directoryHandle, {
            version: 1,
            workspaces: next,
          });
        }

        return next;
      });
    },
    [directoryHandle],
  );

  const scheduleManifestSave = useCallback(
    (manifest: WorkspaceManifest) => {
      pendingManifestRef.current = manifest;

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(() => {
        if (!directoryHandle || !pendingManifestRef.current) {
          return;
        }

        const pending = pendingManifestRef.current;
        pendingManifestRef.current = null;

        void saveWorkspaceManifest(directoryHandle, pending).catch((error) => {
          console.error(error);
          setStatus(`自动保存失败: ${String(error)}`);
        });
      }, 600);
    },
    [directoryHandle],
  );

  const applyWorkspaceUpdate = useCallback(
    (
      updater: (current: WorkspaceManifest) => WorkspaceManifest,
      options: { immediate?: boolean; syncIndex?: boolean } = {},
    ) => {
      setActiveWorkspace((current) => {
        if (!current) {
          return current;
        }

        const next = normalizeManifest(updater(current));

        if (options.syncIndex) {
          persistWorkspaceSummary(next);
        }

        if (directoryHandle) {
          if (options.immediate) {
            pendingManifestRef.current = null;
            if (saveTimerRef.current !== null) {
              window.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }

            void saveWorkspaceManifest(directoryHandle, next).catch((error) => {
              console.error(error);
              setStatus(`保存失败: ${String(error)}`);
            });
          } else {
            scheduleManifestSave(next);
          }
        }

        return next;
      });
    },
    [directoryHandle, persistWorkspaceSummary, scheduleManifestSave],
  );

  const persistCanvasDraft = useCallback(
    (immediate: boolean) => {
      if (!canvasDirtyRef.current || !activeWorkspaceRef.current) {
        return;
      }

      const snapshot = normalizeCanvasState(canvasDraftRef.current);
      canvasDirtyRef.current = false;

      applyWorkspaceUpdate(
        (current) => ({
          ...current,
          updatedAt: Date.now(),
          canvas: snapshot,
        }),
        { immediate },
      );
    },
    [applyWorkspaceUpdate],
  );

  const scheduleCanvasPersist = useCallback(() => {
    if (canvasSaveTimerRef.current !== null) {
      window.clearTimeout(canvasSaveTimerRef.current);
    }

    canvasSaveTimerRef.current = window.setTimeout(() => {
      canvasSaveTimerRef.current = null;
      persistCanvasDraft(false);
    }, 260);
  }, [persistCanvasDraft]);

  const flushCanvasPersist = useCallback(() => {
    if (canvasSaveTimerRef.current !== null) {
      window.clearTimeout(canvasSaveTimerRef.current);
      canvasSaveTimerRef.current = null;
    }
    persistCanvasDraft(true);
  }, [persistCanvasDraft]);

  const resetWorkspaceView = useCallback(() => {
    setOpenTabs([]);
    setActiveTabKey("");
    setViewerCache({});
    setActiveLine(null);
    setActiveLogRef(null);
    setSelectedSnippet("");

    setSearchResults([]);
    setSearchMatchedFiles(new Set());
    setSearchError("");
    setTimelineEvents([]);
    setSearchAggregation(DEFAULT_SEARCH_AGGREGATION);
  }, []);

  const loadDirectoryWorkspaceIndex = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      const index = await loadWorkspaceIndex(handle);
      const normalized = index.workspaces.map((item) =>
        normalizeWorkspaceSummary(item),
      );
      const needsNormalize = normalized.some(
        (item, idx) => item.storageFolder !== index.workspaces[idx]?.storageFolder,
      );
      if (needsNormalize) {
        await saveWorkspaceIndex(handle, {
          version: 1,
          workspaces: normalized,
        });
      }
      const sorted = [...normalized].sort((a, b) => b.updatedAt - a.updatedAt);

      if (sorted.length === 0) {
        const defaultName = createUniqueWorkspaceName(
          createDefaultWorkspaceBaseName(),
          sorted,
        );
        const manifest = createWorkspace(defaultName);
        const autoSummaries = [toSummary(manifest)];

        await saveWorkspaceManifest(handle, manifest);
        await saveWorkspaceIndex(handle, {
          version: 1,
          workspaces: autoSummaries,
        });

        setDirectoryHandle(handle);
        setStorageName(handle.name || "已选择目录");
        setWorkspaceSummaries(autoSummaries);
        setActiveWorkspace(manifest);
        resetWorkspaceView();
        setIndexStatus(DEFAULT_INDEX_STATUS);
        setActiveWorkspaceId(manifest.id);
        setStatus(`目录已连接，已创建默认日志空间：${manifest.name}`);
        return;
      }

      setDirectoryHandle(handle);
      setStorageName(handle.name || "已选择目录");
      setWorkspaceSummaries(sorted);
      setActiveWorkspace(null);
      resetWorkspaceView();
      setIndexStatus(DEFAULT_INDEX_STATUS);

      const lastOpened = clientReady
        ? window.localStorage.getItem(LOCAL_STORAGE_LAST_WORKSPACE_KEY)
        : null;

      const preferred =
        sorted.find((item) => item.id === lastOpened)?.id ?? sorted[0]?.id ?? "";

      setActiveWorkspaceId(preferred);
      setStatus(`已连接目录，发现 ${sorted.length} 个日志空间`);
    },
    [clientReady, resetWorkspaceView],
  );

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    if (!isFsSupported) {
      setRestoringDirectoryHandle(false);
      return;
    }

    if (directoryHandle) {
      setRestoringDirectoryHandle(false);
      return;
    }

    let cancelled = false;
    setRestoringDirectoryHandle(true);

    const restore = async () => {
      const remembered = await loadRememberedRootDirectoryHandle();
      if (cancelled) {
        return;
      }

      setRememberedDirectoryHandle(remembered);

      if (!remembered) {
        return;
      }

      const permission = await queryDirectoryPermission(remembered, "readwrite");
      if (cancelled) {
        return;
      }

      if (permission === "granted") {
        await loadDirectoryWorkspaceIndex(remembered);
      }
    };

    void restore()
      .catch(() => {
        // Ignore restore failures and show picker modal.
      })
      .finally(() => {
        if (!cancelled) {
          setRestoringDirectoryHandle(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientReady, directoryHandle, isFsSupported, loadDirectoryWorkspaceIndex]);

  const handlePickDirectory = useCallback(async (): Promise<boolean> => {
    if (!isFsSupported) {
      setStatus("当前浏览器不支持本地目录访问，请使用 Chromium 内核浏览器。");
      return false;
    }

    try {
      flushCanvasPersist();
      await flushPendingSave();
      const handle = await pickDirectory();
      await loadDirectoryWorkspaceIndex(handle);
      await rememberRootDirectoryHandle(handle);
      setRememberedDirectoryHandle(handle);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`选择目录失败: ${message}`);
      return false;
    }
  }, [
    flushCanvasPersist,
    flushPendingSave,
    isFsSupported,
    loadDirectoryWorkspaceIndex,
  ]);

  const handlePickDirectoryFromWelcome = useCallback(async () => {
    setPickingDirectoryFromWelcome(true);
    try {
      if (rememberedDirectoryHandle) {
        flushCanvasPersist();
        await flushPendingSave();

        const permission = await requestDirectoryPermission(
          rememberedDirectoryHandle,
          "readwrite",
        );

        if (permission === "granted") {
          await loadDirectoryWorkspaceIndex(rememberedDirectoryHandle);
          await rememberRootDirectoryHandle(rememberedDirectoryHandle);
          setRememberedDirectoryHandle(rememberedDirectoryHandle);
          return;
        }
      }

      await handlePickDirectory();
    } finally {
      setPickingDirectoryFromWelcome(false);
    }
  }, [
    flushCanvasPersist,
    flushPendingSave,
    handlePickDirectory,
    loadDirectoryWorkspaceIndex,
    rememberedDirectoryHandle,
  ]);

  const openCreateWorkspaceModal = useCallback(() => {
    if (!directoryHandle) {
      setStatus("请先选择日志主存储目录");
      return;
    }

    setCreateWorkspaceName("线上问题-2026-02");
    setIsCreateModalOpen(true);
  }, [directoryHandle]);

  const handleConfirmCreateWorkspace = useCallback(async () => {
    const name = createWorkspaceName.trim();

    if (!name) {
      setStatus("请输入日志空间名称");
      return;
    }

    if (!directoryHandle) {
      setStatus("请先选择日志主存储目录");
      return;
    }

    setCreatingWorkspace(true);

    try {
      flushCanvasPersist();
      await flushPendingSave();

      if (hasWorkspaceNameCollision(name, workspaceSummaries)) {
        setStatus(`日志空间名称已存在：${name}`);
        return;
      }

      const manifest = createWorkspace(name);
      const index = await loadWorkspaceIndex(directoryHandle);
      const normalizedSummaries = index.workspaces.map((item) =>
        normalizeWorkspaceSummary(item),
      );
      if (hasWorkspaceNameCollision(name, normalizedSummaries)) {
        setStatus(`日志空间名称已存在：${name}`);
        return;
      }

      await saveWorkspaceManifest(directoryHandle, manifest);

      const nextIndex = [
        toSummary(manifest),
        ...normalizedSummaries.filter((item) => item.id !== manifest.id),
      ].sort((a, b) => b.updatedAt - a.updatedAt);

      await saveWorkspaceIndex(directoryHandle, {
        version: 1,
        workspaces: nextIndex,
      });

      setWorkspaceSummaries(nextIndex);
      setActiveWorkspaceId(manifest.id);
      setActiveWorkspace(manifest);
      resetWorkspaceView();
      setIsCreateModalOpen(false);
      setStatus(`已创建日志空间: ${manifest.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`新建日志空间失败: ${message}`);
    } finally {
      setCreatingWorkspace(false);
    }
  }, [
    createWorkspaceName,
    directoryHandle,
    flushCanvasPersist,
    flushPendingSave,
    resetWorkspaceView,
    workspaceSummaries,
  ]);

  const requestDeleteWorkspace = useCallback(
    (workspaceId: string) => {
      const summary = workspaceSummaries.find((item) => item.id === workspaceId) ?? null;
      setWorkspaceToDelete(summary);
    },
    [workspaceSummaries],
  );

  const confirmDeleteWorkspace = useCallback(async () => {
    if (!directoryHandle || !workspaceToDelete) {
      return;
    }

    try {
      flushCanvasPersist();
      await flushPendingSave();
      await deleteWorkspaceData(
        directoryHandle,
        workspaceToDelete.id,
        workspaceToDelete.storageFolder,
      );

      const index = await loadWorkspaceIndex(directoryHandle);
      const sorted = index.workspaces
        .map((item) => normalizeWorkspaceSummary(item))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      setWorkspaceSummaries(sorted);

      if (activeWorkspaceId === workspaceToDelete.id) {
        resetWorkspaceView();
        setActiveWorkspace(null);
        setActiveWorkspaceId(sorted[0]?.id ?? "");
        if (!sorted[0] && clientReady) {
          window.localStorage.removeItem(LOCAL_STORAGE_LAST_WORKSPACE_KEY);
        }
      }

      setStatus(`已删除日志空间: ${workspaceToDelete.name}`);
      setWorkspaceToDelete(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`删除日志空间失败: ${message}`);
    }
  }, [
    activeWorkspaceId,
    clientReady,
    directoryHandle,
    flushCanvasPersist,
    flushPendingSave,
    resetWorkspaceView,
    workspaceToDelete,
  ]);

  const beginRenameWorkspace = useCallback((summary: WorkspaceSummary) => {
    setRenamingWorkspaceId(summary.id);
    setRenamingWorkspaceName(summary.name);
  }, []);

  const cancelRenameWorkspace = useCallback(() => {
    setRenamingWorkspaceId(null);
    setRenamingWorkspaceName("");
  }, []);

  const confirmRenameWorkspace = useCallback(async () => {
    const workspaceId = renamingWorkspaceId;
    const nextName = renamingWorkspaceName.trim();

    if (!workspaceId) {
      return;
    }

    if (!nextName) {
      setStatus("请输入日志空间名称");
      return;
    }

    if (!directoryHandle) {
      setStatus("请先选择日志主存储目录");
      return;
    }

    const collisionCandidates = workspaceSummaries.filter((item) => item.id !== workspaceId);
    if (hasWorkspaceNameCollision(nextName, collisionCandidates)) {
      setStatus(`日志空间名称已存在：${nextName}`);
      return;
    }

    setRenamingWorkspaceBusy(true);

    try {
      flushCanvasPersist();
      await flushPendingSave();

      let base: WorkspaceManifest | null =
        activeWorkspace && activeWorkspace.id === workspaceId ? activeWorkspace : null;

      if (!base) {
        const raw = await loadWorkspaceManifest(directoryHandle, workspaceId);
        base = raw ? normalizeManifest(raw) : null;
      }

      if (!base) {
        setStatus("无法读取日志空间元数据");
        return;
      }

      const updated: WorkspaceManifest = {
        ...base,
        name: nextName,
        updatedAt: Date.now(),
      };

      await saveWorkspaceManifest(directoryHandle, updated);

      const index = await loadWorkspaceIndex(directoryHandle);
      const nextSummaries = index.workspaces
        .map((item) => normalizeWorkspaceSummary(item))
        .map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                name: nextName,
                updatedAt: updated.updatedAt,
              }
            : item,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);

      await saveWorkspaceIndex(directoryHandle, {
        version: 1,
        workspaces: nextSummaries,
      });

      setWorkspaceSummaries(nextSummaries);
      if (activeWorkspaceId === workspaceId) {
        setActiveWorkspace(updated);
      }

      cancelRenameWorkspace();
      setStatus(`已重命名日志空间：${nextName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`重命名日志空间失败: ${message}`);
    } finally {
      setRenamingWorkspaceBusy(false);
    }
  }, [
    activeWorkspace,
    activeWorkspaceId,
    cancelRenameWorkspace,
    directoryHandle,
    flushCanvasPersist,
    flushPendingSave,
    renamingWorkspaceId,
    renamingWorkspaceName,
    workspaceSummaries,
  ]);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      if (workspaceId === activeWorkspaceId) {
        return;
      }
      flushCanvasPersist();
      await flushPendingSave();
      cancelRenameWorkspace();
      setActiveWorkspaceId(workspaceId);
    },
    [activeWorkspaceId, cancelRenameWorkspace, flushCanvasPersist, flushPendingSave],
  );

  useEffect(() => {
    if (!directoryHandle || !activeWorkspaceId) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      const manifestRaw = await loadWorkspaceManifest(directoryHandle, activeWorkspaceId);
      if (cancelled) {
        return;
      }

      if (!manifestRaw) {
        setStatus(`空间 ${activeWorkspaceId} 的元数据损坏或不存在`);
        return;
      }

      const manifest = normalizeManifest(manifestRaw);
      setActiveWorkspace(manifest);
      if (
        typeof manifestRaw.storageFolder !== "string" ||
        !manifestRaw.storageFolder.trim()
      ) {
        await saveWorkspaceManifest(directoryHandle, manifest);
      }
      resetWorkspaceView();
      setStatus(`已打开空间: ${manifest.name}`);
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, directoryHandle, resetWorkspaceView]);

  const treeRootIds = useMemo(
    () => activeWorkspace?.roots.map((root) => root.tree.id) ?? [],
    [activeWorkspace?.roots],
  );

  useEffect(() => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      treeRootIds.forEach((id) => next.add(id));
      return next;
    });
  }, [treeRootIds]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const worker = new Worker(new URL("../workers/search-index.worker.ts", import.meta.url), {
      type: "module",
    });

    searchWorkerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const payload = event.data;

      if (payload.type === "indexStatus") {
        if (payload.workspaceId !== activeWorkspaceIdRef.current) {
          return;
        }

        setIndexStatus({
          indexing: false,
          indexedFiles: payload.indexedFiles,
          changedFiles: payload.changedFiles,
          totalFiles: payload.totalFiles,
        });
        return;
      }

      if (payload.type === "searchResult") {
        if (payload.requestId !== latestSearchRequestIdRef.current) {
          return;
        }

        setSearching(false);

        if (payload.error) {
          setSearchError(payload.error);
          setSearchResults([]);
          setSearchMatchedFiles(new Set());
          setTimelineEvents([]);
          setSearchAggregation(DEFAULT_SEARCH_AGGREGATION);
          return;
        }

        setSearchError("");
        setSearchResults(payload.results);
        setSearchMatchedFiles(new Set(payload.matchedFiles));
        setTimelineEvents(payload.timeline);
        setSearchAggregation(payload.aggregations);

        if (payload.results.length > 0) {
          setExpandedNodes((current) => {
            const next = new Set(current);
            payload.results.forEach((result) => {
              collectAncestorNodeIds(result.rootId, result.filePath).forEach((id) => {
                next.add(id);
              });
            });
            return next;
          });
        }
      }
    };

    return () => {
      worker.terminate();
      searchWorkerRef.current = null;
    };
  }, [clientReady]);

  const buildSearchIndex = useCallback(
    async (workspace: WorkspaceManifest) => {
      if (!directoryHandle || !searchWorkerRef.current) {
        return;
      }

      const allTextFiles = workspace.roots.flatMap((root) =>
        root.files
          .filter((file) => file.textLike && file.size <= MAX_INDEX_FILE_BYTES)
          .map((file) => ({
            root,
            file,
            fileKey: searchFileKey(root.id, file.path),
            signature: `${root.id}:${file.path}:${file.size}`,
          })),
      );

      const currentSignatures = new Map<string, string>();
      allTextFiles.forEach((entry) => {
        currentSignatures.set(entry.fileKey, entry.signature);
      });

      const previousSignatures =
        indexedSignaturesRef.current.get(workspace.id) ?? new Map<string, string>();

      const changedFiles = allTextFiles.filter(
        (entry) => previousSignatures.get(entry.fileKey) !== entry.signature,
      );

      const removedFileKeys = [...previousSignatures.keys()].filter(
        (fileKey) => !currentSignatures.has(fileKey),
      );

      if (changedFiles.length === 0 && removedFileKeys.length === 0) {
        setIndexStatus({
          indexing: false,
          indexedFiles: allTextFiles.length,
          totalFiles: allTextFiles.length,
          changedFiles: 0,
        });
        return;
      }

      // Mark that indexing work has started even if React batches away the intermediate
      // "indexing: true" render (used for pending search refresh).
      indexingWasActiveRef.current = true;

      setIndexStatus({
        indexing: true,
        indexedFiles: previousSignatures.size,
        totalFiles: allTextFiles.length,
        changedFiles: changedFiles.length,
      });

      const payload: SearchIndexFilePayload[] = [];
      const nextSignatures = new Map(previousSignatures);
      removedFileKeys.forEach((fileKey) => nextSignatures.delete(fileKey));

      for (const entry of changedFiles) {
        try {
          const bytes = await readBinaryFile(
            directoryHandle,
            workspaceFilePath(workspace, entry.root.rootFolder, entry.file.path),
          );

          payload.push({
            workspaceId: workspace.id,
            fileKey: entry.fileKey,
            signature: entry.signature,
            rootId: entry.root.id,
            sourceName: entry.root.sourceName,
            filePath: entry.file.path,
            text: decodeText(bytes),
          });

          // Only mark a file as indexed after we have successfully read it.
          nextSignatures.set(entry.fileKey, entry.signature);
        } catch {
          continue;
        }
      }

      searchWorkerRef.current.postMessage({
        type: "indexDelta",
        workspaceId: workspace.id,
        replace: previousSignatures.size === 0,
        files: payload,
        removedFileKeys,
        totalFiles: allTextFiles.length,
      });

      indexedSignaturesRef.current.set(workspace.id, nextSignatures);
    },
    [directoryHandle],
  );

  const activeRoots = activeWorkspace?.roots;

  const indexableFileCount = useMemo(() => {
    if (!activeRoots) {
      return 0;
    }

    let count = 0;
    activeRoots.forEach((root) => {
      root.files.forEach((file) => {
        if (file.textLike && file.size <= MAX_INDEX_FILE_BYTES) {
          count += 1;
        }
      });
    });
    return count;
  }, [activeRoots]);

  const indexSignature = useMemo(() => {
    if (!activeRoots) {
      return "";
    }

    return activeRoots
      .map((root) => `${root.id}:${root.files.length}:${root.files.reduce((sum, f) => sum + f.size, 0)}`)
      .join("|");
  }, [activeRoots]);

  useEffect(() => {
    if (!directoryHandle) {
      return;
    }

    const workspace = activeWorkspaceRef.current;
    if (!workspace) {
      return;
    }

    void buildSearchIndex(workspace);
  }, [activeWorkspaceId, buildSearchIndex, directoryHandle, indexSignature]);

  const activeManifestId = activeWorkspace?.id ?? "";

  const executeSearch = useCallback(() => {
    if (!activeManifestId || !searchWorkerRef.current) {
      return;
    }

    if (!hasSearchInput) {
      setSearchResults([]);
      setSearchMatchedFiles(new Set());
      setSearchAggregation(DEFAULT_SEARCH_AGGREGATION);
      setTimelineEvents([]);
      setSearchError("");
      setSearching(false);
      return;
    }

    const requestId = createId("search");
    latestSearchRequestIdRef.current = requestId;

    if (!searchOptions.realtime) {
      setTreeAutoExpandBackup([...expandedNodesRef.current]);
    }

    setSearching(true);
    // If the index isn't ready yet, kick off indexing and defer the actual search until
    // we receive the next indexStatus update. This avoids "always empty" results when the
    // user searches immediately after importing archives.
    if (indexStatus.indexing || indexStatus.indexedFiles < indexableFileCount) {
      pendingSearchAfterIndexRef.current = true;
      if (!indexStatus.indexing && activeWorkspaceRef.current) {
        void buildSearchIndex(activeWorkspaceRef.current);
      }
      return;
    }

    searchWorkerRef.current.postMessage({
      type: "search",
      requestId,
      workspaceId: activeManifestId,
      query: searchQuery,
      options: searchOptions,
    });
  }, [
    activeManifestId,
    buildSearchIndex,
    hasSearchInput,
    indexStatus.indexedFiles,
    indexStatus.indexing,
    indexableFileCount,
    searchOptions,
    searchQuery,
  ]);

  useEffect(() => {
    if (!activeManifestId || !searchOptions.realtime) {
      return;
    }

    const timer = window.setTimeout(() => {
      executeSearch();
    }, 280);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeManifestId, executeSearch, searchOptions.realtime]);

  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);

  useEffect(() => {
    if (indexStatus.indexing) {
      return;
    }

    if (!indexingWasActiveRef.current) {
      return;
    }

    indexingWasActiveRef.current = false;

    if (!pendingSearchAfterIndexRef.current) {
      return;
    }

    pendingSearchAfterIndexRef.current = false;
    if (hasSearchInput) {
      executeSearch();
    }
  }, [
    executeSearch,
    hasSearchInput,
    indexStatus.indexedFiles,
    indexStatus.indexing,
    indexStatus.totalFiles,
  ]);

  const openLogTab = useCallback(
    ({
      rootId,
      filePath,
      line,
      sourceName,
    }: {
      rootId: string;
      filePath: string;
      line?: number;
      sourceName?: string;
    }) => {
      if (!activeWorkspace) {
        return;
      }

      const root = activeWorkspace.roots.find((item) => item.id === rootId);
      if (!root) {
        return;
      }

      const file = root.files.find((item) => item.path === filePath);
      if (!file) {
        return;
      }

      const key = searchFileKey(rootId, filePath);

      setOpenTabs((current) => {
        if (current.some((tab) => tab.key === key)) {
          return current;
        }

        return [
          ...current,
          {
            key,
            rootId,
            sourceName: sourceName ?? root.sourceName,
            filePath,
            title: getBaseName(filePath),
          },
        ];
      });

      setActiveTabKey(key);

      if (typeof line === "number") {
        setActiveLine(line);
        setActiveLogRef(logRefKey(rootId, filePath, line));
      }

      setExpandedNodes((current) => {
        const next = new Set(current);
        collectAncestorNodeIds(rootId, filePath).forEach((id) => {
          next.add(id);
        });
        return next;
      });
    },
    [activeWorkspace],
  );

  const closeTab = useCallback(
    (key: string) => {
      setOpenTabs((current) => {
        const index = current.findIndex((tab) => tab.key === key);
        if (index < 0) {
          return current;
        }

        const next = current.filter((tab) => tab.key !== key);

        if (activeTabKey === key) {
          const fallback = next[index] ?? next[index - 1] ?? next[0] ?? null;
          setActiveTabKey(fallback?.key ?? "");
          setActiveLine(null);
          setActiveLogRef(null);
        }

        return next;
      });
    },
    [activeTabKey],
  );

  useEffect(() => {
    if (!activeTab || !directoryHandle || !activeWorkspace) {
      return;
    }

    if (viewerCache[activeTab.key]) {
      return;
    }

    const root = activeWorkspace.roots.find((item) => item.id === activeTab.rootId);
    if (!root) {
      return;
    }

    const fileMeta = root.files.find((file) => file.path === activeTab.filePath);
    if (!fileMeta) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      setViewerLoading(true);

      try {
        if (!fileMeta.textLike) {
          if (!cancelled) {
            setViewerCache((current) => ({
              ...current,
              [activeTab.key]: {
                rootId: activeTab.rootId,
                sourceName: activeTab.sourceName,
                filePath: activeTab.filePath,
                viewerFileName: `${activeTab.sourceName} / ${activeTab.filePath}`,
                binary: true,
                totalLines: 0,
                lines: [],
              },
            }));
          }
          return;
        }

        const bytes = await readBinaryFile(
          directoryHandle,
          workspaceFilePath(activeWorkspace, root.rootFolder, fileMeta.path),
        );

        const text = decodeText(bytes);
        const lines = text.split(/\r?\n/);

        if (cancelled) {
          return;
        }

        setViewerCache((current) => ({
          ...current,
          [activeTab.key]: {
            rootId: activeTab.rootId,
            sourceName: activeTab.sourceName,
            filePath: activeTab.filePath,
            viewerFileName: `${activeTab.sourceName} / ${activeTab.filePath}`,
            binary: false,
            totalLines: lines.length,
            lines: lines.slice(0, MAX_VIEW_LINES),
          },
        }));
      } catch {
        if (!cancelled) {
          setViewerCache((current) => ({
            ...current,
            [activeTab.key]: {
              rootId: activeTab.rootId,
              sourceName: activeTab.sourceName,
              filePath: activeTab.filePath,
              viewerFileName: `${activeTab.sourceName} / ${activeTab.filePath}`,
              binary: true,
              totalLines: 0,
              lines: [],
            },
          }));
        }
      } finally {
        if (!cancelled) {
          setViewerLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeTab, activeWorkspace, directoryHandle, viewerCache]);

  const updateCanvasDraft = useCallback(
    (
      updater: (current: CanvasState) => CanvasState,
      options?: { skipHistory?: boolean },
    ) => {
      setCanvasDraft((current) => {
        const next = normalizeCanvasState(updater(current));

        if (!options?.skipHistory) {
          const workspaceId = activeWorkspaceIdRef.current || activeWorkspaceRef.current?.id || "";
          if (workspaceId) {
            const history = canvasHistoryRef.current;
            if (history.workspaceId !== workspaceId) {
              history.workspaceId = workspaceId;
              history.past = [];
              history.future = [];
            }

            history.past.push(current);
            if (history.past.length > CANVAS_HISTORY_LIMIT) {
              history.past.shift();
            }
            history.future = [];

            setCanvasHistoryState({
              canUndo: history.past.length > 0,
              canRedo: false,
            });
          }
        }

        canvasDraftRef.current = next;
        return next;
      });
      canvasDirtyRef.current = true;
      scheduleCanvasPersist();
    },
    [scheduleCanvasPersist],
  );

  const handleCanvasChange = useCallback(
    (nextCanvas: CanvasState) => {
      updateCanvasDraft(() => nextCanvas);
    },
    [updateCanvasDraft],
  );

  const undoCanvas = useCallback(() => {
    const workspaceId = activeWorkspaceIdRef.current || activeWorkspaceRef.current?.id || "";
    if (!workspaceId) {
      return;
    }

    const history = canvasHistoryRef.current;
    if (history.workspaceId !== workspaceId || history.past.length === 0) {
      return;
    }

    const previous = history.past.pop();
    if (!previous) {
      return;
    }

    history.future.unshift(canvasDraftRef.current);
    if (history.future.length > CANVAS_HISTORY_LIMIT) {
      history.future.pop();
    }

    setCanvasHistoryState({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });

    updateCanvasDraft(() => previous, { skipHistory: true });
  }, [updateCanvasDraft]);

  const redoCanvas = useCallback(() => {
    const workspaceId = activeWorkspaceIdRef.current || activeWorkspaceRef.current?.id || "";
    if (!workspaceId) {
      return;
    }

    const history = canvasHistoryRef.current;
    if (history.workspaceId !== workspaceId || history.future.length === 0) {
      return;
    }

    const next = history.future.shift();
    if (!next) {
      return;
    }

    history.past.push(canvasDraftRef.current);
    if (history.past.length > CANVAS_HISTORY_LIMIT) {
      history.past.shift();
    }

    setCanvasHistoryState({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });

    updateCanvasDraft(() => next, { skipHistory: true });
  }, [updateCanvasDraft]);

  const resetCanvasView = useCallback(() => {
    updateCanvasDraft((canvas) => ({
      ...canvas,
      zoom: 1,
      offsetX: 20,
      offsetY: 20,
    }));
  }, [updateCanvasDraft]);

  const openViewerFind = useCallback(() => {
    const viewer = activeViewerRef.current;
    if (!viewer || viewer.binary) {
      return;
    }

    setViewerFindOpen(true);
    window.setTimeout(() => {
      viewerFindInputRef.current?.focus();
      viewerFindInputRef.current?.select();
    }, 0);
  }, []);

  const closeViewerFind = useCallback(() => {
    setViewerFindOpen(false);
  }, []);

  const selectViewerFindMatch = useCallback(
    (targetIndex: number) => {
      const viewer = activeViewerRef.current;
      if (!viewer || viewer.binary) {
        return;
      }

      if (viewerFindMatches.length === 0) {
        return;
      }

      const total = viewerFindMatches.length;
      const safeIndex = ((targetIndex % total) + total) % total;
      setViewerFindMatchIndex(safeIndex);

      const lineIndex = viewerFindMatches[safeIndex] ?? null;
      if (lineIndex === null) {
        return;
      }

      const lineNumber = lineIndex + 1;
      setActiveLine(lineNumber);
      setActiveLogRef(logRefKey(viewer.rootId, viewer.filePath, lineNumber));

      window.setTimeout(() => {
        viewerListRef.current?.scrollToIndex(lineIndex, { align: "center" });
      }, 0);
    },
    [viewerFindMatches],
  );

  const gotoNextViewerFindMatch = useCallback(() => {
    selectViewerFindMatch(viewerFindMatchIndex + 1);
  }, [selectViewerFindMatch, viewerFindMatchIndex]);

  const gotoPrevViewerFindMatch = useCallback(() => {
    selectViewerFindMatch(viewerFindMatchIndex - 1);
  }, [selectViewerFindMatch, viewerFindMatchIndex]);

  useEffect(() => {
    if (!viewerFindOpen) {
      return;
    }

    setViewerFindMatchIndex(0);

    if (viewerFindMatches.length > 0) {
      selectViewerFindMatch(0);
    }
  }, [
    activeTabKey,
    selectViewerFindMatch,
    viewerFindCaseSensitive,
    viewerFindMatches.length,
    viewerFindOpen,
    viewerFindQuery,
  ]);

  const openCommandPalette = useCallback(() => {
    commandLastFocusRef.current = document.activeElement as HTMLElement | null;
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    setCommandPaletteOpen(true);
  }, [setCommandPaletteIndex, setCommandPaletteOpen, setCommandPaletteQuery]);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setCommandPaletteOpen(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);

    if (options?.restoreFocus ?? true) {
      const last = commandLastFocusRef.current;
      window.setTimeout(() => {
        if (last && typeof last.focus === "function") {
          last.focus();
        }
      }, 0);
    }
  }, [setCommandPaletteIndex, setCommandPaletteOpen, setCommandPaletteQuery]);

  useEffect(() => {
    if (!clientReady) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (activeViewerRef.current && !activeViewerRef.current.binary) {
          event.preventDefault();
          openViewerFind();
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandPaletteOpen) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (event.key === "Escape") {
        if (commandPaletteOpen) {
          event.preventDefault();
          closeCommandPalette();
          return;
        }

        if (viewerFindOpen) {
          event.preventDefault();
          closeViewerFind();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clientReady,
    closeCommandPalette,
    closeViewerFind,
    commandPaletteOpen,
    openCommandPalette,
    openViewerFind,
    viewerFindOpen,
  ]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return;
    }

    window.setTimeout(() => {
      commandInputRef.current?.focus();
    }, 0);
  }, [commandPaletteOpen]);

  const pinSearchResultToCanvas = useCallback(
    (result: SearchResult) => {
      if (!activeWorkspace) {
        return;
      }

      const text = `[${result.sourceName}] ${result.filePath}:${result.line}\n${result.preview}`;

      const link: LogReference = {
        workspaceId: activeWorkspace.id,
        rootId: result.rootId,
        sourceName: result.sourceName,
        filePath: result.filePath,
        line: result.line,
      };

      updateCanvasDraft((canvas) => ({
        ...canvas,
        items: [
          ...canvas.items,
          {
            id: createId("note"),
            kind: "note",
            text,
            x: 90 + canvas.items.length * 20,
            y: 90 + canvas.items.length * 18,
            color: "#f9edb8",
            textColor: "#24325f",
            width: 240,
            link,
            timestamp: result.timestamp,
            comment: "",
          },
        ],
      }));
    },
    [activeWorkspace, updateCanvasDraft],
  );

  const appendSelectionToCanvas = useCallback(() => {
    const snippet = selectedSnippet.trim();
    if (!snippet || !activeWorkspace) {
      return;
    }

    const link =
      activeTab && typeof activeLine === "number"
        ? {
            workspaceId: activeWorkspace.id,
            rootId: activeTab.rootId,
            sourceName: activeTab.sourceName,
            filePath: activeTab.filePath,
            line: activeLine,
          }
        : undefined;

    updateCanvasDraft((canvas) => ({
      ...canvas,
      items: [
        ...canvas.items,
        {
          id: createId("note"),
          kind: "note",
          text: snippet,
          x: 120 + canvas.items.length * 20,
          y: 120 + canvas.items.length * 16,
          color: "#f9edb8",
          textColor: "#24325f",
          width: 240,
          link,
          timestamp: parseLogLineTimestamp(snippet),
          comment: link ? "" : undefined,
        },
      ],
    }));

    setSelectedSnippet("");
  }, [activeLine, activeTab, activeWorkspace, selectedSnippet, updateCanvasDraft]);

  const handleOpenLinkedLog = useCallback(
    (link: LogReference) => {
      openLogTab({
        rootId: link.rootId,
        filePath: link.filePath,
        line: link.line,
        sourceName: link.sourceName,
      });
    },
    [openLogTab],
  );

  const syncNotesFromEditor = useCallback(() => {
    const editor = notesEditorRef.current;
    if (!editor) {
      return;
    }

    applyWorkspaceUpdate(
      (current) => ({
        ...current,
        updatedAt: Date.now(),
        notes: editor.innerHTML,
      }),
      { immediate: false },
    );
  }, [applyWorkspaceUpdate]);

  const hideNoteMention = useCallback(() => {
    setNotesMentionOpen(false);
    setNotesMentionQuery("");
    setNotesMentionPosition(null);
  }, []);

  const refreshNoteMention = useCallback(() => {
    const editor = notesEditorRef.current;
    const selection = window.getSelection();

    if (!editor || !selection || selection.rangeCount === 0) {
      hideNoteMention();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!range.collapsed || !editor.contains(range.endContainer)) {
      hideNoteMention();
      return;
    }

    const beforeCaretRange = range.cloneRange();
    beforeCaretRange.selectNodeContents(editor);
    beforeCaretRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = beforeCaretRange.toString();
    const match = beforeText.match(/@([^\s@]{0,120})$/);

    if (!match) {
      hideNoteMention();
      return;
    }

    const hostRect = editor.getBoundingClientRect();
    const caretRect = range.getBoundingClientRect();

    setNotesMentionQuery(match[1] ?? "");
    setNotesMentionPosition({
      x: clamp(caretRect.left - hostRect.left, 8, Math.max(8, hostRect.width - 12)),
      y: clamp(caretRect.bottom - hostRect.top + 8, 16, Math.max(16, hostRect.height - 14)),
    });
    setNotesMentionOpen(true);
  }, [hideNoteMention]);

  const applyNotesCommand = useCallback(
    (command: string, value?: string) => {
      const editor = notesEditorRef.current;
      if (!editor) {
        return;
      }

      editor.focus();
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand(command, false, value);
      syncNotesFromEditor();
      refreshNoteMention();
    },
    [refreshNoteMention, syncNotesFromEditor],
  );

  const insertNoteMention = useCallback(
    (target: {
      rootId: string;
      sourceName: string;
      filePath: string;
    }) => {
      const editor = notesEditorRef.current;
      const selection = window.getSelection();

      if (!editor || !selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      if (!editor.contains(range.endContainer)) {
        return;
      }

      const removeTokenLength = notesMentionQuery.length + 1;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const textNode = range.startContainer as Text;
        const start = Math.max(0, range.startOffset - removeTokenLength);
        const token = textNode.data.slice(start, range.startOffset);

        if (token.startsWith("@")) {
          const tokenRange = document.createRange();
          tokenRange.setStart(textNode, start);
          tokenRange.setEnd(textNode, range.startOffset);
          tokenRange.deleteContents();
          range.setStart(textNode, start);
          range.collapse(true);
        }
      }

      const link = document.createElement("a");
      link.href = "#";
      link.className = "notes-link-token";
      link.textContent = `@${getBaseName(target.filePath)}`;
      link.dataset.rootId = target.rootId;
      link.dataset.sourceName = target.sourceName;
      link.dataset.filePath = target.filePath;
      link.setAttribute("contenteditable", "false");

      range.insertNode(link);
      const spacer = document.createTextNode(" ");
      link.after(spacer);

      const nextRange = document.createRange();
      nextRange.setStartAfter(spacer);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);

      syncNotesFromEditor();
      hideNoteMention();
      editor.focus();
    },
    [hideNoteMention, notesMentionQuery, syncNotesFromEditor],
  );

  const clearSearch = useCallback(() => {
    latestSearchRequestIdRef.current = "";
    setSearching(false);
    setSearchError("");
    setSearchResults([]);
    setSearchMatchedFiles(new Set());
    setTimelineEvents([]);
    setTimelineExpanded(false);
    setSearchAggregation(DEFAULT_SEARCH_AGGREGATION);
    setContextResult(null);
    setTreeAutoExpandBackup(null);
  }, []);

  const importArchives = useCallback(
    async (files: File[]) => {
      if (!directoryHandle || !activeWorkspace) {
        setStatus("请先选择主存储目录并打开日志空间");
        return;
      }

      if (files.length === 0) {
        return;
      }

      setImporting(true);
      setStatus(`开始导入 ${files.length} 个压缩包`);

      let working = activeWorkspace;

      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const archive = files[fileIndex];
        setStatus(`[${fileIndex + 1}/${files.length}] 正在解析 ${archive.name}`);

        try {
          const bytes = new Uint8Array(await archive.arrayBuffer());
          const extracted = extractArchiveRecursively(archive.name, bytes);

          if (extracted.length === 0) {
            setStatus(`${archive.name} 中没有可解析文件`);
            continue;
          }

          const rootId = createId("root");
          const sourceBase = sanitizeFolderName(stripArchiveSuffix(getBaseName(archive.name)));
          const rootFolder = `${sourceBase}-${rootId.slice(-8)}`;

          const written: typeof extracted = [];
          let failedWrites = 0;

          for (let itemIndex = 0; itemIndex < extracted.length; itemIndex += 1) {
            const item = extracted[itemIndex];

            try {
              await writeBinaryFile(
                directoryHandle,
                workspaceFilePath(working, rootFolder, item.path),
                item.bytes,
              );
              written.push(item);
            } catch {
              failedWrites += 1;
            }

            if (itemIndex > 0 && itemIndex % 200 === 0) {
              setStatus(
                `${archive.name}: 已处理 ${itemIndex}/${extracted.length}（成功 ${written.length}，失败 ${failedWrites}）`,
              );
            }
          }

          if (written.length === 0) {
            setStatus(`${archive.name} 导入失败：没有成功写入任何文件`);
            continue;
          }

          const filesIndex = written.map((item) => ({
            path: item.path,
            size: item.size,
            textLike: item.textLike,
          }));

          const root: RootArchive = {
            id: rootId,
            sourceName: archive.name,
            importedAt: Date.now(),
            rootFolder,
            tree: buildRootTree(rootId, archive.name, filesIndex),
            files: filesIndex,
          };

          working = {
            ...working,
            updatedAt: Date.now(),
            roots: [...working.roots, root],
          };

          setActiveWorkspace(working);
          setExpandedNodes((current) => {
            const next = new Set(current);
            next.add(root.tree.id);
            return next;
          });
          await saveWorkspaceManifest(directoryHandle, working);
          if (failedWrites > 0) {
            setStatus(`${archive.name}: 导入完成（成功 ${written.length}，失败 ${failedWrites}）`);
          }
        } catch (error) {
          setStatus(`${archive.name} 导入失败: ${String(error)}`);
        }
      }

      setImporting(false);
      persistWorkspaceSummary(working);
      setStatus(`导入完成：当前空间共有 ${working.roots.length} 个日志包`);
    },
    [activeWorkspace, directoryHandle, persistWorkspaceSummary],
  );

  const handleFileSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files ? Array.from(event.target.files) : [];
      await importArchives(selected);
      event.target.value = "";
    },
    [importArchives],
  );

  const handleDropArchives = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDraggingArchive(false);
      const selected = Array.from(event.dataTransfer.files);
      await importArchives(selected);
    },
    [importArchives],
  );

  const expandAllNodes = useCallback(() => {
    if (!activeWorkspace) {
      return;
    }

    const all = new Set<string>();
    activeWorkspace.roots.forEach((root) => collectDirectoryNodeIds(root.tree, all));
    setExpandedNodes(all);
  }, [activeWorkspace]);

  const expandRootNodes = useCallback((rootTree: TreeNode) => {
    const all = new Set<string>();
    collectDirectoryNodeIds(rootTree, all);
    setExpandedNodes((current) => {
      const next = new Set(current);
      all.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const collapseAllNodes = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  const collapseRootNodes = useCallback((rootTree: TreeNode) => {
    const all = new Set<string>();
    collectDirectoryNodeIds(rootTree, all);
    setExpandedNodes((current) => {
      const next = new Set(current);
      all.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const startVerticalResize = useCallback(
    (target: ResizeTarget) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        (target === "left" && leftCollapsed) ||
        (target === "right" && rightCollapsed)
      ) {
        return;
      }

      event.preventDefault();

      const sessionStartX = event.clientX;
      const sessionStartLeft = leftWidth;
      const sessionStartRight = rightWidth;

      const move = (moveEvent: PointerEvent) => {
        const session = verticalResizeRef.current;
        if (!session) {
          return;
        }

        const width = layoutRef.current?.clientWidth ?? 0;
        if (width <= 0) {
          return;
        }

        const snapshot = paneSnapshotRef.current;
        const centerMin = MIN_CENTER_WIDTH;

        const delta = moveEvent.clientX - session.startX;

        if (session.target === "left") {
          const rightCurrent = snapshot.rightCollapsed
            ? COLLAPSED_PANE_WIDTH
            : snapshot.rightWidth;

          const maxLeft = Math.max(
            MIN_LEFT_WIDTH,
            width - rightCurrent - centerMin - RESIZER_WIDTH * 2,
          );

          setLeftWidth(clamp(session.startLeft + delta, MIN_LEFT_WIDTH, maxLeft));
          return;
        }

        const leftCurrent = snapshot.leftCollapsed
          ? COLLAPSED_PANE_WIDTH
          : snapshot.leftWidth;

        const maxRight = Math.max(
          MIN_RIGHT_WIDTH,
          width - leftCurrent - centerMin - RESIZER_WIDTH * 2,
        );

        setRightWidth(clamp(session.startRight - delta, MIN_RIGHT_WIDTH, maxRight));
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        verticalResizeRef.current = null;
        document.body.classList.remove("is-resizing");
      };

      verticalResizeRef.current = {
        target,
        startX: sessionStartX,
        startLeft: sessionStartLeft,
        startRight: sessionStartRight,
        move,
        up,
      };

      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [leftCollapsed, leftWidth, rightCollapsed, rightWidth],
  );

  const startRightSplitResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();

    const move = (moveEvent: PointerEvent) => {
      const paneRect = rightPaneRef.current?.getBoundingClientRect();
      if (!paneRect) {
        return;
      }

      const ratio = (moveEvent.clientY - paneRect.top) / paneRect.height;
      setRightSplitRatio(clamp(ratio, 0.12, 0.68));
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      horizontalResizeRef.current = null;
      document.body.classList.remove("is-resizing-horizontal");
    };

    horizontalResizeRef.current = { move, up };
    document.body.classList.add("is-resizing-horizontal");

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const startSearchResultsResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const startHeight = searchResultsHeight;
      const startY = event.clientY;

      const move = (moveEvent: PointerEvent) => {
        const containerHeight = searchInsightsRef.current?.clientHeight ?? 0;
        if (containerHeight <= 0) {
          return;
        }

        const nextHeight = startHeight + (moveEvent.clientY - startY);
        const maxHeight = Math.max(140, containerHeight - 130);
        setSearchResultsHeight(clamp(nextHeight, 110, maxHeight));
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        searchResizeRef.current = null;
        document.body.classList.remove("is-resizing-horizontal");
      };

      searchResizeRef.current = { move, up };
      document.body.classList.add("is-resizing-horizontal");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [searchResultsHeight],
  );

  const startCenterSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const move = (moveEvent: PointerEvent) => {
        const rect = centerSplitRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }

        const minRatio = showSearchInsights ? 0.15 : 0.08;
        const ratio = (moveEvent.clientY - rect.top) / rect.height;
        setCenterSplitRatio(clamp(ratio, minRatio, 0.7));
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        centerSplitResizeRef.current = null;
        document.body.classList.remove("is-resizing-horizontal");
      };

      centerSplitResizeRef.current = { move, up };
      document.body.classList.add("is-resizing-horizontal");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [showSearchInsights],
  );

  useEffect(() => {
    if (!showSearchInsights) {
      return;
    }

    const containerHeight = searchInsightsRef.current?.clientHeight ?? 0;
    if (containerHeight <= 0) {
      return;
    }

    const maxHeight = Math.max(140, containerHeight - 130);
    setSearchResultsHeight((current) => {
      const next = clamp(current, 110, maxHeight);
      return next === current ? current : next;
    });
  }, [centerSplitRatio, showAdvancedSearch, showSearchInsights]);

  const toggleSearchInsights = useCallback(() => {
    setShowSearchInsights((current) => {
      const next = !current;

      if (!next) {
        centerSplitBackupRef.current = centerSplitRatio;
        setCenterSplitRatio((ratio) => clamp(Math.min(ratio, 0.12), 0.08, 0.7));
        return next;
      }

      const backup = centerSplitBackupRef.current;
      centerSplitBackupRef.current = null;
      if (typeof backup === "number") {
        setCenterSplitRatio(clamp(backup, 0.15, 0.7));
      }

      return next;
    });
  }, [centerSplitRatio]);

  useEffect(() => {
    if (!layoutRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) {
        return;
      }

      const snapshot = paneSnapshotRef.current;
      const centerMin = MIN_CENTER_WIDTH;

      setLeftWidth((current) => {
        const rightCurrent = snapshot.rightCollapsed
          ? COLLAPSED_PANE_WIDTH
          : snapshot.rightWidth;

        const maxLeft = Math.max(
          MIN_LEFT_WIDTH,
          width - rightCurrent - centerMin - RESIZER_WIDTH * 2,
        );

        return clamp(current, MIN_LEFT_WIDTH, maxLeft);
      });

      setRightWidth((current) => {
        const leftCurrent = snapshot.leftCollapsed
          ? COLLAPSED_PANE_WIDTH
          : snapshot.leftWidth;

        const maxRight = Math.max(
          MIN_RIGHT_WIDTH,
          width - leftCurrent - centerMin - RESIZER_WIDTH * 2,
        );

        return clamp(current, MIN_RIGHT_WIDTH, maxRight);
      });
    });

    observer.observe(layoutRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushCanvasPersist();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushCanvasPersist();
    };
  }, [flushCanvasPersist]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (canvasSaveTimerRef.current !== null) {
        window.clearTimeout(canvasSaveTimerRef.current);
      }

      const vertical = verticalResizeRef.current;
      if (vertical) {
        window.removeEventListener("pointermove", vertical.move);
        window.removeEventListener("pointerup", vertical.up);
      }

      const horizontal = horizontalResizeRef.current;
      if (horizontal) {
        window.removeEventListener("pointermove", horizontal.move);
        window.removeEventListener("pointerup", horizontal.up);
      }

      const searchResize = searchResizeRef.current;
      if (searchResize) {
        window.removeEventListener("pointermove", searchResize.move);
        window.removeEventListener("pointerup", searchResize.up);
      }

      const centerResize = centerSplitResizeRef.current;
      if (centerResize) {
        window.removeEventListener("pointermove", centerResize.move);
        window.removeEventListener("pointerup", centerResize.up);
      }
    };
  }, []);

  const leftPaneStyle = useMemo(
    () => ({
      width: leftCollapsed ? COLLAPSED_PANE_WIDTH : leftWidth,
      flex: `0 0 ${leftCollapsed ? COLLAPSED_PANE_WIDTH : leftWidth}px`,
    }),
    [leftCollapsed, leftWidth],
  );

  const rightPaneStyle = useMemo(
    () => ({
      width: rightCollapsed ? COLLAPSED_PANE_WIDTH : rightWidth,
      flex: `0 0 ${rightCollapsed ? COLLAPSED_PANE_WIDTH : rightWidth}px`,
    }),
    [rightCollapsed, rightWidth],
  );

  const renderTree = useCallback(
    (
      rootId: string,
      nodes: WorkspaceManifest["roots"][number]["tree"]["children"],
      depth: number,
    ): React.ReactNode => {
      if (!nodes || nodes.length === 0) {
        return null;
      }

      const filter = treeFilter.trim().toLowerCase();
      const rendered: React.ReactNode[] = [];

      const matchesFilter = (node: TreeNode): boolean => {
        if (!filter) {
          return true;
        }
        return (
          node.name.toLowerCase().includes(filter) ||
          node.path.toLowerCase().includes(filter)
        );
      };

      nodes.forEach((node) => {
        if (node.kind === "dir") {
          const isOpen = expandedNodes.has(node.id);
          const children = renderTree(rootId, node.children, depth + 1);
          const shouldShow = treeOnlyMatched
            ? Boolean(children)
            : Boolean(children) || matchesFilter(node);

          if (!shouldShow) {
            return;
          }

          rendered.push(
            <div key={node.id}>
              <button
                type="button"
                className="tree-node tree-dir"
                style={{ paddingLeft: 14 + depth * 14 }}
                onClick={() => toggleNode(node.id)}
              >
                <span className="tree-node-icon">{isOpen ? "▾" : "▸"}</span>
                <span className="tree-node-label">{node.name}</span>
              </button>
              {isOpen ? children : null}
            </div>,
          );
          return;
        }

        const fileKey = searchFileKey(rootId, node.path);
        const tabOpened = openTabs.some((tab) => tab.key === fileKey);
        const searchHit = searchMatchedFiles.has(fileKey);
        const hitCount = searchHitCounts.get(fileKey) ?? 0;

        if (treeOnlyMatched && !searchHit) {
          return;
        }

        if (!matchesFilter(node)) {
          return;
        }

        rendered.push(
          <button
            type="button"
            key={node.id}
            className={`tree-node tree-file ${tabOpened && activeTabKey === fileKey ? "tree-selected" : ""} ${searchHit ? "tree-search-hit" : ""}`}
            style={{ paddingLeft: 14 + depth * 14 }}
            onClick={() => {
              void openLogTab({ rootId, filePath: node.path });
            }}
          >
            <span className="tree-node-icon">{tabOpened ? "◉" : "•"}</span>
            <span className="tree-node-label" title={node.path}>
              {node.name}
            </span>
            {searchHit ? (
              <span className="tree-hit-badge">{hitCount || 1}</span>
            ) : null}
          </button>,
        );
      });

      return rendered.length > 0 ? rendered : null;
    },
    [
      activeTabKey,
      expandedNodes,
      openLogTab,
      openTabs,
      searchHitCounts,
      searchMatchedFiles,
      toggleNode,
      treeFilter,
      treeOnlyMatched,
    ],
  );

  const lineOverflow =
    activeViewer?.totalLines !== undefined &&
    activeViewer.totalLines > (activeViewer.lines.length ?? 0);

  type CommandEntry = {
    id: string;
    title: string;
    hint?: string;
    shortcut?: string;
    enabled: boolean;
    run: () => void;
  };

  const commandEntries: CommandEntry[] = [
    {
      id: "focus-search",
      title: "聚焦跨文件搜索",
      hint: "中栏",
      enabled: true,
      run: () => searchInputRef.current?.focus(),
    },
    {
      id: "toggle-search-results",
      title: showSearchInsights ? "隐藏搜索结果" : "显示搜索结果",
      hint: "中栏",
      enabled: true,
      run: () => toggleSearchInsights(),
    },
    {
      id: "toggle-advanced-search",
      title: showAdvancedSearch ? "收起高级搜索" : "展开高级搜索",
      hint: "中栏",
      enabled: true,
      run: () => setShowAdvancedSearch((current) => !current),
    },
    {
      id: "clear-search",
      title: "清空搜索结果",
      hint: "中栏",
      enabled: searchResults.length > 0 || hasSearchInput,
      run: () => clearSearch(),
    },
    {
      id: "focus-tree-filter",
      title: "聚焦日志树过滤",
      hint: "左栏",
      enabled: true,
      run: () => {
        setLeftCollapsed(false);
        window.setTimeout(() => treeFilterInputRef.current?.focus(), 0);
      },
    },
    {
      id: "tree-only-matched",
      title: treeOnlyMatched ? "日志树：显示全部文件" : "日志树：只看命中文件",
      hint: "左栏",
      enabled: searchMatchedFiles.size > 0,
      run: () => setTreeOnlyMatched((current) => !current),
    },
    {
      id: "tree-expand-all",
      title: "日志树：全部展开",
      hint: "左栏",
      enabled: Boolean(activeWorkspace),
      run: () => expandAllNodes(),
    },
    {
      id: "tree-collapse-all",
      title: "日志树：全部收起",
      hint: "左栏",
      enabled: Boolean(activeWorkspace),
      run: () => collapseAllNodes(),
    },
    {
      id: "focus-canvas",
      title: "聚焦线索画板",
      hint: "右栏",
      enabled: true,
      run: () => {
        setRightCollapsed(false);
        window.setTimeout(() => {
          document.querySelector<HTMLDivElement>(".canvas-viewport")?.focus();
        }, 0);
      },
    },
    {
      id: "canvas-undo",
      title: "画板：撤销",
      shortcut: "Ctrl/⌘+Z",
      enabled: canvasHistoryState.canUndo,
      run: () => undoCanvas(),
    },
    {
      id: "canvas-redo",
      title: "画板：重做",
      shortcut: "Ctrl/⌘+Shift+Z",
      enabled: canvasHistoryState.canRedo,
      run: () => redoCanvas(),
    },
    {
      id: "canvas-reset-view",
      title: "画板：重置视图",
      enabled: true,
      run: () => resetCanvasView(),
    },
    {
      id: "theme-sky",
      title: "主题：云蓝",
      enabled: theme !== "sky",
      run: () => setTheme("sky"),
    },
    {
      id: "theme-graphite",
      title: "主题：石墨",
      enabled: theme !== "graphite",
      run: () => setTheme("graphite"),
    },
    {
      id: "theme-forest",
      title: "主题：森绿",
      enabled: theme !== "forest",
      run: () => setTheme("forest"),
    },
    {
      id: "theme-cyberpunk",
      title: "主题：赛博朋克",
      enabled: theme !== "cyberpunk",
      run: () => setTheme("cyberpunk"),
    },
    {
      id: "pick-storage",
      title: "选择主存储目录",
      enabled: true,
      run: () => void handlePickDirectory(),
    },
    {
      id: "create-workspace",
      title: "新增日志空间",
      hint: "左栏",
      enabled: Boolean(directoryHandle),
      run: () => openCreateWorkspaceModal(),
    },
  ];

  const normalizedCommandQuery = commandPaletteQuery.trim().toLocaleLowerCase();
  const commandTokens = normalizedCommandQuery
    ? normalizedCommandQuery.split(/\s+/).filter(Boolean)
    : [];

  const filteredCommandEntries =
    commandTokens.length === 0
      ? commandEntries
      : commandEntries.filter((command) => {
          const haystack = `${command.title} ${command.hint ?? ""} ${command.id}`
            .toLocaleLowerCase()
            .trim();
          return commandTokens.every((token) => haystack.includes(token));
        });

  const safeCommandIndex =
    filteredCommandEntries.length === 0
      ? 0
      : clamp(commandPaletteIndex, 0, filteredCommandEntries.length - 1);

  const runCommandEntry = useCallback(
    (command: CommandEntry) => {
      if (!command.enabled) {
        return;
      }

      closeCommandPalette({ restoreFocus: false });
      window.setTimeout(() => command.run(), 0);
    },
    [closeCommandPalette],
  );

  return (
    <div className="logger-shell">
      <header className="top-bar">
        <div className="top-bar-group">
          <div className="app-brand" aria-label="Logger Spirit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="app-logo" src="/icon.svg" alt="" aria-hidden="true" />
            <span className="app-title">Logger Spirit</span>
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void handlePickDirectory();
            }}
          >
            选择主存储目录
          </button>

          <select
            className="select theme-select"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemeMode)}
            aria-label="切换主题"
          >
            <option value="sky">云蓝</option>
            <option value="graphite">石墨</option>
            <option value="forest">森绿</option>
            <option value="cyberpunk">赛博朋克</option>
          </select>
        </div>

        <p className="status-text">
          存储目录：{storageName} | 索引 {indexStatus.indexedFiles}/{indexStatus.totalFiles}
          {indexStatus.indexing ? `（更新中，变更 ${indexStatus.changedFiles}）` : ""}
        </p>
      </header>

      {!clientReady ? (
        <main className="booting">页面初始化中...</main>
      ) : !isFsSupported ? (
        <main className="unsupported">
          当前浏览器不支持 File System Access API。请使用最新版 Chrome / Edge。
        </main>
      ) : (
        <main className="workspace-layout" ref={layoutRef}>
          <aside
            className={`pane left-pane ${leftCollapsed ? "collapsed" : ""}`}
            style={leftPaneStyle}
          >
            {leftCollapsed ? (
              <div className="pane-rail">
                <button
                  type="button"
                  className="ghost-button pane-rail-button"
                  onClick={() => setLeftCollapsed(false)}
                >
                  展开
                </button>
                <span className="pane-rail-label">空间与日志树</span>
              </div>
            ) : (
              <>
                <div className="pane-title-row">
                  <h2>空间与日志树</h2>
                  <div className="pane-title-actions">
                    <button
                      type="button"
                      className="ghost-button tiny"
                      onClick={() => setLeftCollapsed(true)}
                    >
                      收起
                    </button>
                  </div>
                </div>

	                <section
	                  className={`import-dropzone ${draggingArchive ? "active" : ""}`}
	                  onDragOver={(event) => {
	                    event.preventDefault();
	                    setDraggingArchive(true);
	                  }}
                  onDragLeave={() => setDraggingArchive(false)}
                  onDrop={handleDropArchives}
                  onClick={() => {
                    if (!activeWorkspace || importing) {
	                      return;
	                    }
	                    fileInputRef.current?.click();
	                  }}
	                  data-disabled={!activeWorkspace || importing}
	                >
                  <div className="import-dropzone-inner">
                    <div className="import-dropzone-plus">+</div>
                    <div className="import-dropzone-text">
                      <strong>
                        {importing ? "导入中..." : "拖拽或者点击上传日志压缩包"}
                      </strong>
                      <span className="muted">zip / tar.gz，支持递归解压</span>
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    hidden
                    multiple
                    accept=".zip,.tar,.tar.gz,.tgz,.gz"
                    onChange={handleFileSelection}
                  />
                </section>

                <section className="tree-panel">
                  <div className="tree-panel-tabs">
                    <div className="workspace-box-head">
                      <h3>日志空间</h3>
                      <small className="muted">切换 Tab 即切换日志树</small>
                    </div>

                    <div className="workspace-tab-strip">
                      {workspaceSummaries.map((summary) => {
                        const isActive = summary.id === activeWorkspaceId;
                        const isRenaming = summary.id === renamingWorkspaceId;

                        return (
                          <div
                            key={summary.id}
                            className={`workspace-tab-item ${isActive ? "active" : ""}`}
                          >
                            {isRenaming ? (
                              <div className="workspace-tab-edit">
                                <input
                                  className="workspace-tab-input"
                                  value={renamingWorkspaceName}
                                  disabled={renamingWorkspaceBusy}
                                  autoFocus
                                  onChange={(event) => setRenamingWorkspaceName(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void confirmRenameWorkspace();
                                      return;
                                    }
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      cancelRenameWorkspace();
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  className="workspace-tab-action"
                                  disabled={renamingWorkspaceBusy}
                                  onClick={() => {
                                    void confirmRenameWorkspace();
                                  }}
                                >
                                  保存
                                </button>
                                <button
                                  type="button"
                                  className="workspace-tab-action"
                                  disabled={renamingWorkspaceBusy}
                                  onClick={cancelRenameWorkspace}
                                >
                                  取消
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="workspace-tab-main"
                                title={isActive ? "单击重命名" : summary.name}
                                onClick={() => {
                                  if (isActive) {
                                    beginRenameWorkspace(summary);
                                    return;
                                  }
                                  void switchWorkspace(summary.id);
                                }}
                              >
                                {summary.name}
                              </button>
                            )}

                            <button
                              type="button"
                              className="workspace-tab-delete"
                              title={`删除 ${summary.name}`}
                              disabled={isRenaming}
                              onClick={() => {
                                requestDeleteWorkspace(summary.id);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}

                      <button
                        type="button"
                        className="workspace-tab-add"
                        title="新增日志空间"
                        onClick={openCreateWorkspaceModal}
                        disabled={!directoryHandle}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="tree-head">
                    <h3>日志树</h3>
                    <div className="pane-title-actions no-wrap">
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={expandAllNodes}
                      >
                        全部展开
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={collapseAllNodes}
                      >
                        全部收起
                      </button>
                    </div>
                  </div>

	                  <div className="tree-filter-row">
	                    <input
	                      className="tree-filter-input"
	                      ref={treeFilterInputRef}
	                      value={treeFilter}
	                      placeholder="快速过滤文件/目录"
	                      onChange={(event) => setTreeFilter(event.target.value)}
	                    />
                    {treeFilter.trim() ? (
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={() => setTreeFilter("")}
                      >
                        清空
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className={`ghost-button tiny ${treeOnlyMatched ? "active" : ""}`}
                      disabled={searchMatchedFiles.size === 0}
                      title={
                        searchMatchedFiles.size === 0
                          ? "暂无命中结果"
                          : treeOnlyMatched
                            ? "显示全部文件"
                            : "只显示命中文件"
                      }
                      onClick={() => setTreeOnlyMatched((current) => !current)}
                    >
                      只看命中
                    </button>

                    {treeAutoExpandBackup ? (
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={() => {
                          setExpandedNodes(new Set(treeAutoExpandBackup));
                          setTreeAutoExpandBackup(null);
                        }}
                      >
                        撤销自动展开
                      </button>
                    ) : null}

                    {searchMatchedFiles.size > 0 ? (
                      <small className="muted">
                        命中 {searchMatchedFiles.size} 文件
                      </small>
                    ) : null}
                  </div>

                  <div className="tree-content">
                    {!activeWorkspace ? (
                      <p className="muted">未打开日志空间</p>
                    ) : activeWorkspace.roots.length === 0 ? (
                      <p className="muted">暂无导入包，拖拽或点击上传日志压缩包开始分析</p>
                    ) : (
                      activeWorkspace.roots.map((root) => {
                        const isOpen = expandedNodes.has(root.tree.id);
                        return (
                          <div className="root-tree" key={root.id}>
                            <div className="root-header-row">
                              <button
                                type="button"
                                className="root-header"
                                onClick={() => toggleNode(root.tree.id)}
                              >
                                <span>{isOpen ? "▾" : "▸"}</span>
                                <span>{root.sourceName}</span>
                                <small>{root.files.length} 文件</small>
                              </button>

                              <div className="root-actions">
                                <button
                                  type="button"
                                  className="ghost-button tiny"
                                  onClick={() => expandRootNodes(root.tree)}
                                >
                                  展开
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button tiny"
                                  onClick={() => collapseRootNodes(root.tree)}
                                >
                                  收起
                                </button>
                              </div>
                            </div>

                            {isOpen ? renderTree(root.id, root.tree.children, 1) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              </>
            )}
          </aside>

          <div
            className={`vertical-resizer ${leftCollapsed ? "disabled" : ""}`}
            onPointerDown={startVerticalResize("left")}
          />

          <section className="pane center-pane">
            <div className="pane-title-row">
              <h2>搜索与日志查看</h2>
            </div>

            <div className="center-split" ref={centerSplitRef}>
                  <section
                    className="search-box compact"
                    style={
                      showSearchInsights
                        ? { flex: `0 0 ${Math.round(centerSplitRatio * 100)}%` }
                        : { flex: "0 0 auto" }
                    }
                  >
                    <div className="search-row">
	                      <input
	                        className="search-input"
	                        ref={searchInputRef}
	                        value={searchQuery}
	                        placeholder="跨文件搜索关键字，例如 timeout / error code"
	                        onChange={(event) => setSearchQuery(event.target.value)}
	                        onKeyDown={(event) => {
	                          if (event.key === "Enter") {
                              if (!showSearchInsights) {
                                toggleSearchInsights();
                              }
                            executeSearch();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="primary-button tiny"
                        disabled={!activeWorkspace || searching}
                        onClick={() => {
                          if (!showSearchInsights) {
                            toggleSearchInsights();
                          }
                          executeSearch();
                        }}
                      >
                        {searching ? "搜索中..." : "搜索"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={clearSearch}
                      >
                        清空
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={() => setShowAdvancedSearch((current) => !current)}
                      >
                        {showAdvancedSearch ? "收起高级" : "高级搜索"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={toggleSearchInsights}
                      >
                        {showSearchInsights ? "隐藏结果" : "显示结果"}
                      </button>
                    </div>

                    <div className="search-meta">
                      <p className="muted">
                        命中 {searchResults.length} 条，索引 {indexStatus.indexedFiles} 文件，相关文件已高亮。
                      </p>
                      {searchError ? <p className="error-text">{searchError}</p> : null}
                    </div>

                    {showAdvancedSearch ? (
                      <div className="search-advanced">
                        <div className="search-options">
                          <label>
                            <input
                              type="checkbox"
                              checked={searchOptions.regex}
                              onChange={(event) =>
                                setSearchOptions((current) => ({
                                  ...current,
                                  regex: event.target.checked,
                                }))
                              }
                            />
                            正则
                          </label>

                          <label>
                            <input
                              type="checkbox"
                              checked={searchOptions.caseSensitive}
                              onChange={(event) =>
                                setSearchOptions((current) => ({
                                  ...current,
                                  caseSensitive: event.target.checked,
                                }))
                              }
                            />
                            区分大小写
                          </label>

                          <label>
                            <input
                              type="checkbox"
                              checked={searchOptions.realtime}
                              onChange={(event) =>
                                setSearchOptions((current) => ({
                                  ...current,
                                  realtime: event.target.checked,
                                }))
                              }
                            />
                            实时搜索
                          </label>

                          <label>
                            上下文
                            <input
                              type="number"
                              min={0}
                              max={8}
                              value={searchOptions.contextLines}
                              onChange={(event) =>
                                setSearchOptions((current) => ({
                                  ...current,
                                  contextLines: clamp(
                                    Number.parseInt(event.target.value, 10) || 0,
                                    0,
                                    8,
                                  ),
                                }))
                              }
                            />
                          </label>

                          <label>
                            结果上限
                            <input
                              type="number"
                              min={50}
                              max={3000}
                              value={searchOptions.maxResults}
                              onChange={(event) =>
                                setSearchOptions((current) => ({
                                  ...current,
                                  maxResults: clamp(
                                    Number.parseInt(event.target.value, 10) || 200,
                                    50,
                                    3000,
                                  ),
                                }))
                              }
                            />
                          </label>
                        </div>

                        <div className="search-filters">
                          <input
                            className="search-mini-input"
                            placeholder="pod"
                            value={searchOptions.filters.pod ?? ""}
                            onChange={(event) =>
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  pod: event.target.value || undefined,
                                },
                              }))
                            }
                          />

                          <input
                            className="search-mini-input"
                            placeholder="container"
                            value={searchOptions.filters.container ?? ""}
                            onChange={(event) =>
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  container: event.target.value || undefined,
                                },
                              }))
                            }
                          />

                          <input
                            className="search-mini-input"
                            placeholder="namespace"
                            value={searchOptions.filters.namespace ?? ""}
                            onChange={(event) =>
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  namespace: event.target.value || undefined,
                                },
                              }))
                            }
                          />

                          <select
                            className="search-mini-select"
                            value={searchOptions.filters.level ?? ""}
                            onChange={(event) =>
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  level: event.target.value || undefined,
                                },
                              }))
                            }
                          >
                            <option value="">全部级别</option>
                            <option value="TRACE">TRACE</option>
                            <option value="DEBUG">DEBUG</option>
                            <option value="INFO">INFO</option>
                            <option value="WARN">WARN</option>
                            <option value="ERROR">ERROR</option>
                            <option value="FATAL">FATAL</option>
                          </select>

                          <input
                            type="datetime-local"
                            className="search-mini-input"
                            value={timeFromInput}
                            onChange={(event) => {
                              const value = event.target.value;
                              setTimeFromInput(value);
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  timeFrom: parseDateTimeInput(value),
                                },
                              }));
                            }}
                          />

                          <input
                            type="datetime-local"
                            className="search-mini-input"
                            value={timeToInput}
                            onChange={(event) => {
                              const value = event.target.value;
                              setTimeToInput(value);
                              setSearchOptions((current) => ({
                                ...current,
                                filters: {
                                  ...current.filters,
                                  timeTo: parseDateTimeInput(value),
                                },
                              }));
                            }}
                          />
                        </div>

                        <div className="aggregation-box compact">
                          <div className="agg-group">
                            <span>级别</span>
                            <div className="agg-chips">
                              {sortCountEntries(searchAggregation.byLevel)
                                .slice(0, 5)
                                .map(([key, count]) => (
                                  <button
                                    key={key}
                                    type="button"
                                    className="agg-chip"
                                    onClick={() =>
                                      setSearchOptions((current) => ({
                                        ...current,
                                        filters: {
                                          ...current.filters,
                                          level: key,
                                        },
                                      }))
                                    }
                                  >
                                    {key}:{count}
                                  </button>
                                ))}
                            </div>
                          </div>

                          <div className="agg-group">
                            <span>Pod</span>
                            <div className="agg-chips">
                              {sortCountEntries(searchAggregation.byPod)
                                .slice(0, 8)
                                .map(([key, count]) => (
                                  <button
                                    key={key}
                                    type="button"
                                    className="agg-chip"
                                    onClick={() =>
                                      setSearchOptions((current) => ({
                                        ...current,
                                        filters: {
                                          ...current.filters,
                                          pod: key,
                                        },
                                      }))
                                    }
                                  >
                                    {key}:{count}
                                  </button>
                                ))}
                            </div>
                          </div>

                          <div className="agg-group">
                            <span>NS</span>
                            <div className="agg-chips">
                              {sortCountEntries(searchAggregation.byNamespace)
                                .slice(0, 8)
                                .map(([key, count]) => (
                                  <button
                                    key={key}
                                    type="button"
                                    className="agg-chip"
                                    onClick={() =>
                                      setSearchOptions((current) => ({
                                        ...current,
                                        filters: {
                                          ...current.filters,
                                          namespace: key,
                                        },
                                      }))
                                    }
                                  >
                                    {key}:{count}
                                  </button>
                                ))}
                            </div>
                          </div>

                          <div className="agg-group">
                            <span>标签</span>
                            <div className="agg-chips">
                              {sortCountEntries(searchAggregation.byTag)
                                .slice(0, 8)
                                .map(([key, count]) => (
                                  <span key={key} className="agg-chip passive">
                                    {key}:{count}
                                  </span>
                                ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

	                    {showSearchInsights ? (
	                      <div className="search-insights" ref={searchInsightsRef}>
	                        {searchResults.length === 0 ? (
	                          <div
	                            className="search-results compact"
	                            style={{ flex: `0 1 ${searchResultsHeight}px` }}
	                          >
	                            <p className="muted">
                                {searching ? "搜索中..." : hasSearchInput ? "暂无命中结果。" : "请输入关键字开始搜索。"}
                              </p>
                              {indexStatus.indexing ? (
                                <p className="muted">索引更新中，结果会自动刷新。</p>
                              ) : null}
	                          </div>
	                        ) : (
	                          <VirtualList
	                            className="search-results compact"
	                            style={{ flex: `0 1 ${searchResultsHeight}px` }}
	                            itemCount={searchResults.length}
	                            itemHeight={92}
	                            overscan={10}
	                            renderRow={(index, rowStyle) => {
	                              const result = searchResults[index];
	                              if (!result) {
	                                return null;
	                              }
	                              const resultLogRef = logRefKey(
	                                result.rootId,
	                                result.filePath,
	                                result.line,
	                              );
	                              const isActive = activeLogRef === resultLogRef;

	                              return (
	                                <div
	                                  style={rowStyle}
	                                  className={`search-item compact ${isActive ? "active" : ""}`}
	                                  draggable
	                                  onDragStart={(event) => {
	                                    const payload = JSON.stringify({
	                                      text: `[${result.sourceName}] ${result.filePath}:${result.line} ${result.preview}`,
	                                      link: {
	                                        workspaceId: activeWorkspace?.id,
	                                        rootId: result.rootId,
	                                        sourceName: result.sourceName,
	                                        filePath: result.filePath,
	                                        line: result.line,
	                                      },
	                                      timestamp: result.timestamp,
	                                    });
	                                    event.dataTransfer.effectAllowed = "copy";
	                                    event.dataTransfer.setData(
	                                      "application/logger-snippet",
	                                      payload,
	                                    );
	                                    event.dataTransfer.setData("application/json", payload);
	                                    event.dataTransfer.setData("text/plain", payload);
	                                  }}
	                                >
	                                  <div className="search-item-head">
	                                    <button
	                                      type="button"
	                                      className="search-item-open compact"
	                                      title={`${result.sourceName} ${result.filePath}:${result.line}\n${result.preview}`}
	                                      onClick={() => {
	                                        openLogTab({
	                                          rootId: result.rootId,
	                                          filePath: result.filePath,
	                                          line: result.line,
	                                          sourceName: result.sourceName,
	                                        });
	                                      }}
	                                    >
	                                      <strong>{result.sourceName}</strong>
	                                      <span>
	                                        {result.filePath}:{result.line}
	                                      </span>
	                                      <p className="search-preview">
	                                        {highlightText(result.preview, viewerHighlightSpec)}
	                                      </p>
	                                    </button>

	                                    <div className="search-item-actions">
	                                      <button
	                                        type="button"
	                                        className="ghost-button tiny"
	                                        onClick={() => setContextResult(result)}
	                                      >
	                                        上下文
	                                      </button>
	                                      <button
	                                        type="button"
	                                        className="ghost-button tiny"
	                                        onClick={() => pinSearchResultToCanvas(result)}
	                                      >
	                                        固定
	                                      </button>
	                                    </div>
	                                  </div>

	                                  <div className="search-item-tags">
	                                    {result.level ? (
	                                      <span className="tag-chip">{result.level}</span>
	                                    ) : null}
	                                    {result.tags.map((tag) => (
	                                      <span
	                                        key={`${result.id}-${tag}`}
	                                        className="tag-chip alert"
	                                      >
	                                        {tag}
	                                      </span>
	                                    ))}
	                                    {result.traceId ? (
	                                      <span className="tag-chip">trace:{result.traceId}</span>
	                                    ) : null}
	                                  </div>
	                                </div>
	                              );
	                            }}
	                          />
	                        )}

                        <div
                          className="horizontal-resizer search-results-resizer"
                          onPointerDown={startSearchResultsResize}
                        />

                        <section className="timeline-box compact timeline-panel">
                          <div className="timeline-head">
                            <h4>事件时间线</h4>
                            <small className="muted">{timelineEvents.length} 条</small>
                            {timelineEvents.length > 80 ? (
                              <button
                                type="button"
                                className="ghost-button tiny"
                                onClick={() => setTimelineExpanded((current) => !current)}
                              >
                                {timelineExpanded ? "收起" : "展开"}
                              </button>
                            ) : null}
                          </div>

                          <div className="timeline-list">
                            {timelineEvents.length === 0 ? (
                              <p className="muted">暂无可提取时间线。</p>
                            ) : (
                              (timelineExpanded
                                ? timelineEvents
                                : timelineEvents.slice(0, 80)
                              ).map((event) => (
                                <button
                                  type="button"
                                  key={event.id}
                                  className="timeline-item"
                                  onClick={() => {
                                    openLogTab({
                                      rootId: event.rootId,
                                      filePath: event.filePath,
                                      line: event.line,
                                      sourceName: event.sourceName,
                                    });
                                  }}
                                >
                                  <span>
                                    {typeof event.timestamp === "number"
                                      ? new Date(event.timestamp).toLocaleString()
                                      : "无时间戳"}
                                  </span>
                                  <strong>
                                    {event.sourceName}:{event.line}
                                  </strong>
                                  <p>{event.message}</p>
                                </button>
                              ))
                            )}
                          </div>
                        </section>
                      </div>
                    ) : null}
                  </section>

                  {showSearchInsights ? (
                    <div
                      className="horizontal-resizer center-resizer"
                      onPointerDown={startCenterSplitResize}
                    />
                  ) : null}

                  <section
                    className="viewer-box"
                    style={
                      showSearchInsights
                        ? { flex: `1 1 ${Math.round((1 - centerSplitRatio) * 100)}%` }
                        : { flex: "1 1 auto" }
                    }
                  >
                  <div className="tab-strip">
                    {openTabs.length === 0 ? (
                      <p className="muted">尚未打开日志文件。点击左侧树或搜索结果打开。</p>
                    ) : (
                      openTabs.map((tab) => (
                        <div
                          key={tab.key}
                          className={`tab-item ${tab.key === activeTabKey ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            className="tab-main"
                            onClick={() => setActiveTabKey(tab.key)}
                          >
                            {tab.title}
                          </button>
                          <button
                            type="button"
                            className="tab-close"
                            onClick={() => closeTab(tab.key)}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="viewer-head">
                    <div>
                      <h3>日志查看</h3>
                      <p className="muted">
                        {activeViewer?.viewerFileName ?? "尚未选择文件"}
                      </p>
                    </div>

                    <div className="viewer-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={!selectedSnippet}
                        onClick={appendSelectionToCanvas}
                      >
                        收藏选中文本
                      </button>
                    </div>
                  </div>

                  {viewerFindOpen && activeViewer && !activeViewer.binary ? (
                    <div className="viewer-find-bar">
                      <input
                        ref={viewerFindInputRef}
                        className="viewer-find-input"
                        value={viewerFindQuery}
                        placeholder="在当前文件内查找 (Ctrl/Cmd+F)"
                        onChange={(event) => setViewerFindQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            if (event.shiftKey) {
                              gotoPrevViewerFindMatch();
                            } else {
                              gotoNextViewerFindMatch();
                            }
                          }

                          if (event.key === "Escape") {
                            event.preventDefault();
                            closeViewerFind();
                          }
                        }}
                      />

                      <span className="viewer-find-count">
                        {viewerFindMatches.length > 0
                          ? `${Math.min(viewerFindMatchIndex, viewerFindMatches.length - 1) + 1}/${viewerFindMatches.length}`
                          : "0/0"}
                      </span>

                      <button
                        type="button"
                        className="ghost-button tiny"
                        disabled={viewerFindMatches.length === 0}
                        onClick={gotoPrevViewerFindMatch}
                        title="上一个 (Shift+Enter)"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        disabled={viewerFindMatches.length === 0}
                        onClick={gotoNextViewerFindMatch}
                        title="下一个 (Enter)"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={`ghost-button tiny ${viewerFindCaseSensitive ? "active" : ""}`}
                        title="区分大小写"
                        onClick={() => setViewerFindCaseSensitive((current) => !current)}
                      >
                        Aa
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={closeViewerFind}
                        title="关闭"
                      >
                        ✕
                      </button>
                    </div>
                  ) : null}

                  {viewerLoading ? (
                    <p className="muted">读取中...</p>
	                  ) : activeViewer?.binary ? (
	                    <p className="muted">当前文件为二进制或不可读文本，暂不支持预览。</p>
	                  ) : activeViewer?.lines.length ? (
	                    <VirtualList
	                      ref={viewerListRef}
	                      className="viewer-content"
	                      itemCount={activeViewer.lines.length}
	                      itemHeight={28}
	                      overscan={40}
	                      onMouseUp={() => {
	                        const text = window.getSelection()?.toString().trim() ?? "";
	                        if (text) {
	                          setSelectedSnippet(text.slice(0, 1200));
	                        }
	                      }}
	                      renderRow={(index) => {
	                        const line = activeViewer.lines[index] ?? "";
	                        const lineNumber = index + 1;
	                        const lineRef = logRefKey(
	                          activeViewer.rootId,
	                          activeViewer.filePath,
	                          lineNumber,
	                        );
	                        const isCurrent = activeLine === lineNumber;
	                        const isLinked = linkedLogRefSet.has(lineRef);
	                        const isActiveLinked = activeLogRef === lineRef;

	                        return (
	                          <div
	                            style={{ height: "100%" }}
	                            className={`log-line ${isCurrent ? "log-active" : ""} ${isLinked ? "log-linked" : ""} ${isActiveLinked ? "log-link-active" : ""}`}
	                            onClick={() => {
	                              setActiveLine(lineNumber);
	                              setActiveLogRef(lineRef);
	                            }}
	                          >
	                            <span className="line-meta">
	                              <button
	                                type="button"
	                                className="line-drag-handle"
	                                draggable
	                                title="拖动到画板"
	                                onClick={(event) => event.stopPropagation()}
	                                onMouseDown={(event) => event.stopPropagation()}
	                                onDragStart={(event) => {
	                                  const timestamp = parseLogLineTimestamp(line);
	                                  const payload = JSON.stringify({
	                                    text: `[${activeViewer.viewerFileName}] ${lineNumber}: ${line}`,
	                                    link: {
	                                      workspaceId: activeWorkspace?.id,
	                                      rootId: activeViewer.rootId,
	                                      sourceName: activeViewer.sourceName,
	                                      filePath: activeViewer.filePath,
	                                      line: lineNumber,
	                                    },
	                                    timestamp,
	                                  });
	                                  event.dataTransfer.effectAllowed = "copy";
	                                  event.dataTransfer.setData(
	                                    "application/logger-snippet",
	                                    payload,
	                                  );
	                                  event.dataTransfer.setData("application/json", payload);
	                                  event.dataTransfer.setData("text/plain", payload);
	                                }}
	                              >
	                                ⋮⋮
	                              </button>
	                              <span className="line-no">{lineNumber}</span>
	                            </span>
	                            <span className="line-text">
	                              {viewerFindOpen && viewerFindQuery.trim()
	                                ? highlightText(line, viewerFindSpec, {
	                                    hitClassName: "log-find-hit",
	                                  })
	                                : highlightText(line, viewerHighlightSpec)}
	                            </span>
	                          </div>
	                        );
	                      }}
	                    />
	                  ) : (
	                    <p className="muted">从左侧树或搜索结果中选择文件。</p>
	                  )}

                  {lineOverflow ? (
                    <p className="muted">
                      仅展示前 {MAX_VIEW_LINES} 行（原始 {activeViewer?.totalLines} 行）
                    </p>
                  ) : null}
                  </section>
                </div>
          </section>

          <div
            className={`vertical-resizer ${rightCollapsed ? "disabled" : ""}`}
            onPointerDown={startVerticalResize("right")}
          />

          <aside
            className={`pane right-pane ${rightCollapsed ? "collapsed" : ""}`}
            style={rightPaneStyle}
          >
            {rightCollapsed ? (
              <div className="pane-rail">
                <button
                  type="button"
                  className="ghost-button pane-rail-button"
                  onClick={() => setRightCollapsed(false)}
                >
                  展开
                </button>
                <span className="pane-rail-label">记录与画板</span>
              </div>
            ) : (
              <>
                <div className="pane-title-row">
                  <h2>分析记录与画板</h2>
                  <div className="pane-title-actions">
                    <button
                      type="button"
                      className="ghost-button tiny"
                      onClick={() => setRightCollapsed(true)}
                    >
                      收起
                    </button>
                  </div>
                </div>

                <div className="right-split" ref={rightPaneRef}>
                  <section
                    className="notes-box"
                    style={{ flex: `0 0 ${Math.round(rightSplitRatio * 100)}%` }}
                  >
                    <div className="notes-head">
                      <h3>问题记录本</h3>
                      <small>支持选区字号/颜色与 @文件跳转</small>
                    </div>
                    <div className="notes-toolbar">
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={() => applyNotesCommand("bold")}
                      >
                        粗体
                      </button>
                      <button
                        type="button"
                        className="ghost-button tiny"
                        onClick={() => applyNotesCommand("italic")}
                      >
                        斜体
                      </button>
                      <label className="notes-tool">
                        字号
                        <select
                          className="search-mini-select"
                          value={notesFontSize}
                          onChange={(event) => {
                            const next = event.target.value;
                            setNotesFontSize(next);
                            applyNotesCommand("fontSize", next);
                          }}
                        >
                          <option value="2">小</option>
                          <option value="3">中</option>
                          <option value="4">大</option>
                          <option value="5">特大</option>
                        </select>
                      </label>
                      <label className="notes-tool">
                        颜色
                        <input
                          type="color"
                          value={notesColor}
                          onChange={(event) => {
                            const next = event.target.value;
                            setNotesColor(next);
                            applyNotesCommand("foreColor", next);
                          }}
                        />
                      </label>
                    </div>

                    <div className="notes-editor-wrap">
                      <div
                        ref={notesEditorRef}
                        className="notes-editor"
                        contentEditable
                        suppressContentEditableWarning
                        data-placeholder="记录你的分析路径、结论、待验证假设... 输入 @ 可关联日志文件"
                        onInput={() => {
                          syncNotesFromEditor();
                          refreshNoteMention();
                        }}
                        onKeyUp={() => {
                          refreshNoteMention();
                        }}
                        onKeyDown={(event) => {
                          if (
                            notesMentionOpen &&
                            (event.key === "Enter" || event.key === "Tab") &&
                            filteredNoteMentions.length > 0
                          ) {
                            event.preventDefault();
                            insertNoteMention(filteredNoteMentions[0]);
                            return;
                          }

                          if (notesMentionOpen && event.key === "Escape") {
                            event.preventDefault();
                            hideNoteMention();
                          }
                        }}
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          const mentionLink = target.closest("a.notes-link-token");

                          if (mentionLink instanceof HTMLAnchorElement) {
                            event.preventDefault();
                            const rootId = mentionLink.dataset.rootId;
                            const filePath = mentionLink.dataset.filePath;
                            const sourceName = mentionLink.dataset.sourceName;

                            if (rootId && filePath) {
                              openLogTab({
                                rootId,
                                filePath,
                                sourceName: sourceName || undefined,
                              });
                            }
                            return;
                          }

                          refreshNoteMention();
                        }}
                      />

                      {notesMentionOpen && filteredNoteMentions.length > 0 ? (
                        <div
                          className="notes-mention-panel"
                          style={{
                            left: `${notesMentionPosition?.x ?? 8}px`,
                            top: `${notesMentionPosition?.y ?? 28}px`,
                          }}
                        >
                          {filteredNoteMentions.map((target) => (
                            <button
                              type="button"
                              key={`${target.rootId}:${target.filePath}`}
                              className="notes-mention-item"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                insertNoteMention(target);
                              }}
                            >
                              {target.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <div className="horizontal-resizer" onPointerDown={startRightSplitResize} />

                  <section
                    className="board-box"
                    style={{ flex: `1 1 ${Math.round((1 - rightSplitRatio) * 100)}%` }}
                  >
                    <div className="notes-head">
                      <h3>线索画板</h3>
                      <small>拖拽日志、搜索项到画板</small>
                    </div>

                    <CanvasBoard
                      value={canvasDraft}
                      activeLogRef={activeLogRef}
                      onOpenLinkedLog={handleOpenLinkedLog}
                      onChange={handleCanvasChange}
                      canUndo={canvasHistoryState.canUndo}
                      canRedo={canvasHistoryState.canRedo}
                      onUndo={undoCanvas}
                      onRedo={redoCanvas}
                    />
                  </section>
                </div>
              </>
            )}
          </aside>
        </main>
      )}

      {!directoryHandle && clientReady && isFsSupported && !restoringDirectoryHandle ? (
        <div className="modal-backdrop">
          <div className="modal-card guide-modal">
            <div className="modal-head">
              <h3>选择日志主存储目录</h3>
            </div>

            <p className="muted">
              Logger Spirit 需要访问一个本地主存储目录，用于解压日志、建立索引、保存笔记与画板。
              点击下方按钮后，浏览器会弹出系统权限提示，请允许读写并选择你用于存放日志的目录。
            </p>

            {rememberedDirectoryHandle ? (
              <p className="muted">
                检测到上次使用的目录：<strong>{rememberedDirectoryHandle.name || "已保存目录"}</strong>
              </p>
            ) : null}

            <ol className="guide-list">
              <li>选择主存储目录并授权读写。</li>
              <li>首次连接目录时会自动创建默认日志空间。</li>
              <li>拖入 zip/tar.gz，系统会递归解压并在左侧树展示。</li>
              <li>搜索定位，记录分析结论，并在画板串联线索。</li>
            </ol>

            <div className="modal-footer">
              <button
                type="button"
                className="primary-button"
                disabled={pickingDirectoryFromWelcome}
                onClick={() => {
                  void handlePickDirectoryFromWelcome();
                }}
              >
                {pickingDirectoryFromWelcome
                  ? "处理中..."
                  : rememberedDirectoryHandle
                    ? "继续使用上次目录"
                    : "选择主存储目录"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contextResult ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setContextResult(null);
            }
          }}
        >
          <div className="modal-card context-modal">
            <div className="modal-head">
              <h3>命中上下文</h3>
              <button
                type="button"
                className="ghost-button tiny"
                onClick={() => setContextResult(null)}
              >
                关闭
              </button>
            </div>

            <p className="muted">
              {contextResult.sourceName} / {contextResult.filePath}:{contextResult.line}
            </p>

            <div className="context-modal-body">
              {contextResult.before.map((line, index) => (
                <p key={`${contextResult.id}-before-${index}`} className="context-line before">
                  {line}
                </p>
              ))}
              <p className="context-line current">{contextResult.preview}</p>
              {contextResult.after.map((line, index) => (
                <p key={`${contextResult.id}-after-${index}`} className="context-line after">
                  {line}
                </p>
              ))}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  openLogTab({
                    rootId: contextResult.rootId,
                    filePath: contextResult.filePath,
                    line: contextResult.line,
                    sourceName: contextResult.sourceName,
                  });
                  setContextResult(null);
                }}
              >
                打开日志
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => pinSearchResultToCanvas(contextResult)}
              >
                固定到画板
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {workspaceToDelete ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setWorkspaceToDelete(null);
            }
          }}
        >
          <div className="modal-card">
            <div className="modal-head">
              <h3>删除日志空间</h3>
              <button
                type="button"
                className="ghost-button tiny"
                onClick={() => setWorkspaceToDelete(null)}
              >
                关闭
              </button>
            </div>

            <p className="muted">
              确认删除日志空间 “{workspaceToDelete.name}”？该空间日志、笔记和画板数据会被清除。
            </p>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setWorkspaceToDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void confirmDeleteWorkspace();
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {commandPaletteOpen ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              closeCommandPalette();
            }
          }}
        >
          <div className="modal-card command-modal">
            <div className="modal-head">
              <h3>命令面板</h3>
              <button
                type="button"
                className="ghost-button tiny"
                onClick={() => closeCommandPalette()}
              >
                关闭
              </button>
            </div>

            <input
              ref={commandInputRef}
              className="command-input"
              value={commandPaletteQuery}
              placeholder="输入命令，例如：搜索 / 画板 撤销 / 日志树 展开"
              onChange={(event) => {
                setCommandPaletteQuery(event.target.value);
                setCommandPaletteIndex(0);
              }}
              onKeyDown={(event) => {
                const key = event.key;

                if (key === "Escape") {
                  event.preventDefault();
                  closeCommandPalette();
                  return;
                }

                if (key === "ArrowDown") {
                  event.preventDefault();
                  if (filteredCommandEntries.length === 0) {
                    return;
                  }
                  setCommandPaletteIndex((current) =>
                    current + 1 >= filteredCommandEntries.length ? 0 : current + 1,
                  );
                  return;
                }

                if (key === "ArrowUp") {
                  event.preventDefault();
                  if (filteredCommandEntries.length === 0) {
                    return;
                  }
                  setCommandPaletteIndex((current) =>
                    current - 1 < 0 ? filteredCommandEntries.length - 1 : current - 1,
                  );
                  return;
                }

                if (key === "Enter") {
                  event.preventDefault();
                  const command = filteredCommandEntries[safeCommandIndex];
                  if (command) {
                    runCommandEntry(command);
                  }
                }
              }}
            />

            <div className="command-list">
              {filteredCommandEntries.length === 0 ? (
                <p className="muted">没有匹配的命令。</p>
              ) : (
                filteredCommandEntries.map((command, index) => (
                  <button
                    type="button"
                    key={command.id}
                    className={`command-item ${index === safeCommandIndex ? "active" : ""}`}
                    disabled={!command.enabled}
                    onMouseEnter={() => setCommandPaletteIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => runCommandEntry(command)}
                  >
                    <div className="command-item-main">
                      <strong>{command.title}</strong>
                      {command.hint ? <span className="muted">{command.hint}</span> : null}
                    </div>
                    {command.shortcut ? (
                      <span className="command-shortcut">{command.shortcut}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>

            <p className="muted command-footnote">Enter 执行 · ↑↓ 选择 · Esc 关闭 · Cmd/Ctrl+K 打开</p>
          </div>
        </div>
      ) : null}

      {isCreateModalOpen ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setIsCreateModalOpen(false);
            }
          }}
        >
          <div className="modal-card">
            <div className="modal-head">
              <h3>新建日志空间</h3>
              <button
                type="button"
                className="ghost-button tiny"
                onClick={() => setIsCreateModalOpen(false)}
              >
                关闭
              </button>
            </div>

            <label className="modal-field">
              <span>空间名称</span>
              <input
                className="search-input"
                value={createWorkspaceName}
                onChange={(event) => setCreateWorkspaceName(event.target.value)}
                placeholder="例如：线上故障-订单链路"
              />
            </label>

            <p className="muted">新空间将创建在主存储目录：{storageName}</p>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setIsCreateModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={creatingWorkspace}
                onClick={() => {
                  void handleConfirmCreateWorkspace();
                }}
              >
                {creatingWorkspace ? "创建中..." : "创建空间"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="status-footer">
        <span className="status-footer-text">{status}</span>
        <span className="status-footer-meta">@CopyRight：codex & m00477369</span>
      </footer>
    </div>
  );
}
