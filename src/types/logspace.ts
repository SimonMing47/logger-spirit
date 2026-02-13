export type NodeKind = "dir" | "file";

export type TreeNode = {
  id: string;
  name: string;
  kind: NodeKind;
  path: string;
  size?: number;
  textLike?: boolean;
  children?: TreeNode[];
};

export type IndexedFile = {
  path: string;
  size: number;
  textLike: boolean;
};

export type RootArchive = {
  id: string;
  sourceName: string;
  importedAt: number;
  rootFolder: string;
  tree: TreeNode;
  files: IndexedFile[];
};

export type LogReference = {
  workspaceId: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  line: number;
};

export type CanvasItemKind = "note" | "text";

export type CanvasItem = {
  id: string;
  kind: CanvasItemKind;
  text: string;
  x: number;
  y: number;
  color: string;
  textColor?: string;
  width?: number;
  link?: LogReference;
  timestamp?: number;
  comment?: string;
};

export type CanvasShapeType = "line" | "rect" | "ellipse" | "arrow";

export type CanvasShape = {
  id: string;
  type: CanvasShapeType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  fill?: string;
};

export type CanvasState = {
  zoom: number;
  offsetX: number;
  offsetY: number;
  items: CanvasItem[];
  shapes: CanvasShape[];
  activeColor: string;
  strokeWidth: number;
};

export type SearchFilters = {
  pod?: string;
  container?: string;
  namespace?: string;
  level?: string;
  timeFrom?: number;
  timeTo?: number;
};

export type SearchOptions = {
  regex: boolean;
  caseSensitive: boolean;
  realtime: boolean;
  contextLines: number;
  maxResults: number;
  filters: SearchFilters;
};

export type WorkspaceManifest = {
  version: 1;
  id: string;
  name: string;
  storageFolder: string;
  createdAt: number;
  updatedAt: number;
  roots: RootArchive[];
  notes: string;
  canvas: CanvasState;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  storageFolder: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceIndex = {
  version: 1;
  workspaces: WorkspaceSummary[];
};

export type SearchResult = {
  id: string;
  fileKey: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  line: number;
  preview: string;
  before: string[];
  after: string[];
  timestamp?: number;
  traceId?: string;
  spanId?: string;
  pod?: string;
  container?: string;
  namespace?: string;
  level?: string;
  tags: string[];
};

export type TimelineEvent = {
  id: string;
  timestamp?: number;
  traceId?: string;
  spanId?: string;
  rootId: string;
  sourceName: string;
  filePath: string;
  line: number;
  message: string;
  level?: string;
};

export type SearchAggregation = {
  byLevel: Record<string, number>;
  byPod: Record<string, number>;
  byNamespace: Record<string, number>;
  bySource: Record<string, number>;
  byTag: Record<string, number>;
};
