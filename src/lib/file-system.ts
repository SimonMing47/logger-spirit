import type { WorkspaceIndex, WorkspaceManifest } from "@/types/logspace";
import { joinPath, splitPath } from "@/lib/path";

export const APP_DATA_DIR = ".logger-spirit-data";
export const WORKSPACES_DIR = "workspaces";
export const INDEX_FILE = "index.json";
export const MANIFEST_FILE = "manifest.json";

const HANDLE_DB_NAME = "logger-spirit";
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE_NAME = "fs-handles";
const ROOT_HANDLE_ID = "root-storage";

type RootDirectoryHandleRecord = {
  id: string;
  handle: FileSystemDirectoryHandle;
  updatedAt: number;
};

type DirectoryPermissionMode = "read" | "readwrite";

type DirectoryHandleWithPermissions = {
  queryPermission?: (descriptor?: { mode?: DirectoryPermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: DirectoryPermissionMode }) => Promise<PermissionState>;
};

const DEFAULT_INDEX: WorkspaceIndex = {
  version: 1,
  workspaces: [],
};

export function supportsFileSystemApi(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ mode: "readwrite" });
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

async function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB database"));
  });
}

export async function rememberRootDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  if (!canUseIndexedDb()) {
    return;
  }

  try {
    const db = await openHandleDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(HANDLE_STORE_NAME);

      store.put({
        id: ROOT_HANDLE_ID,
        handle,
        updatedAt: Date.now(),
      } satisfies RootDirectoryHandleRecord);

      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    });
  } catch {
    // Ignore persistence failures (private mode / storage restrictions).
  }
}

export async function forgetRememberedRootDirectoryHandle(): Promise<void> {
  if (!canUseIndexedDb()) {
    return;
  }

  try {
    const db = await openHandleDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(HANDLE_STORE_NAME);
      store.delete(ROOT_HANDLE_ID);

      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    });
  } catch {
    // Ignore deletion failures.
  }
}

export async function loadRememberedRootDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!canUseIndexedDb()) {
    return null;
  }

  try {
    const db = await openHandleDatabase();
    const record = await new Promise<RootDirectoryHandleRecord | undefined>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE_NAME, "readonly");
      const store = transaction.objectStore(HANDLE_STORE_NAME);
      const request = store.get(ROOT_HANDLE_ID);

      request.onsuccess = () => resolve(request.result as RootDirectoryHandleRecord | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to read IndexedDB record"));
    });

    return record?.handle ?? null;
  } catch {
    return null;
  }
}

export async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: DirectoryPermissionMode = "readwrite",
): Promise<PermissionState> {
  try {
    const permissions = handle as unknown as DirectoryHandleWithPermissions;
    if (typeof permissions.queryPermission !== "function") {
      return "prompt";
    }
    return await permissions.queryPermission({ mode });
  } catch {
    return "prompt";
  }
}

export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: DirectoryPermissionMode = "readwrite",
): Promise<PermissionState> {
  try {
    const permissions = handle as unknown as DirectoryHandleWithPermissions;
    if (typeof permissions.requestPermission !== "function") {
      return "denied";
    }
    return await permissions.requestPermission({ mode });
  } catch {
    return "denied";
  }
}

export async function ensureDirectory(
  parent: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  const segments = splitPath(path);
  let current = parent;

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }

  return current;
}

async function getFileHandleForPath(
  parent: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const segments = splitPath(path);
  if (segments.length === 0) {
    throw new Error("Invalid file path");
  }

  const fileName = segments[segments.length - 1];
  const dirPath = segments.slice(0, -1).join("/");
  const dirHandle = await ensureDirectory(parent, dirPath);
  return dirHandle.getFileHandle(fileName, { create });
}

async function getDirectoryIfExists(
  parent: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle | null> {
  const segments = splitPath(path);
  let current = parent;

  for (const segment of segments) {
    try {
      current = await current.getDirectoryHandle(segment);
    } catch {
      return null;
    }
  }

  return current;
}

async function removeEntryByPath(
  parent: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const segments = splitPath(path);
  if (segments.length === 0) {
    return;
  }

  const entryName = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const directory = parentPath
    ? await getDirectoryIfExists(parent, parentPath)
    : parent;

  if (!directory) {
    return;
  }

  try {
    await directory.removeEntry(entryName, { recursive: true });
  } catch {
    // Ignore deletion failures for missing folder.
  }
}

export async function writeBinaryFile(
  parent: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const fileHandle = await getFileHandleForPath(parent, path, true);
  const writable = await fileHandle.createWritable();
  const cloned = new Uint8Array(bytes.byteLength);
  cloned.set(bytes);
  await writable.write(cloned);
  await writable.close();
}

export async function writeTextFile(
  parent: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<void> {
  const fileHandle = await getFileHandleForPath(parent, path, true);
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function readTextFile(
  parent: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const fileHandle = await getFileHandleForPath(parent, path, false);
  const file = await fileHandle.getFile();
  return file.text();
}

export async function readBinaryFile(
  parent: FileSystemDirectoryHandle,
  path: string,
): Promise<Uint8Array> {
  const fileHandle = await getFileHandleForPath(parent, path, false);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function ensureAppStorage(
  rootDirectory: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  return ensureDirectory(rootDirectory, APP_DATA_DIR);
}

export async function getWorkspaceDirectory(
  rootDirectory: FileSystemDirectoryHandle,
  workspaceId: string,
): Promise<FileSystemDirectoryHandle> {
  return ensureDirectory(
    rootDirectory,
    joinPath(APP_DATA_DIR, WORKSPACES_DIR, workspaceId),
  );
}

export async function loadWorkspaceIndex(
  rootDirectory: FileSystemDirectoryHandle,
): Promise<WorkspaceIndex> {
  await ensureAppStorage(rootDirectory);
  const indexPath = joinPath(APP_DATA_DIR, INDEX_FILE);

  try {
    const raw = await readTextFile(rootDirectory, indexPath);
    const parsed = JSON.parse(raw) as WorkspaceIndex;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
      return DEFAULT_INDEX;
    }
    return parsed;
  } catch {
    await saveWorkspaceIndex(rootDirectory, DEFAULT_INDEX);
    return DEFAULT_INDEX;
  }
}

export async function saveWorkspaceIndex(
  rootDirectory: FileSystemDirectoryHandle,
  index: WorkspaceIndex,
): Promise<void> {
  const indexPath = joinPath(APP_DATA_DIR, INDEX_FILE);
  await writeTextFile(rootDirectory, indexPath, JSON.stringify(index, null, 2));
}

export async function loadWorkspaceManifest(
  rootDirectory: FileSystemDirectoryHandle,
  workspaceId: string,
): Promise<WorkspaceManifest | null> {
  const manifestPath = joinPath(
    APP_DATA_DIR,
    WORKSPACES_DIR,
    workspaceId,
    MANIFEST_FILE,
  );

  try {
    const raw = await readTextFile(rootDirectory, manifestPath);
    const parsed = JSON.parse(raw) as WorkspaceManifest;
    if (parsed.version !== 1 || parsed.id !== workspaceId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveWorkspaceManifest(
  rootDirectory: FileSystemDirectoryHandle,
  manifest: WorkspaceManifest,
): Promise<void> {
  const manifestPath = joinPath(
    APP_DATA_DIR,
    WORKSPACES_DIR,
    manifest.id,
    MANIFEST_FILE,
  );

  await writeTextFile(rootDirectory, manifestPath, JSON.stringify(manifest, null, 2));
}

export async function removeWorkspaceFromIndex(
  rootDirectory: FileSystemDirectoryHandle,
  workspaceId: string,
): Promise<void> {
  const index = await loadWorkspaceIndex(rootDirectory);
  const next: WorkspaceIndex = {
    ...index,
    workspaces: index.workspaces.filter((item) => item.id !== workspaceId),
  };
  await saveWorkspaceIndex(rootDirectory, next);
}

export async function deleteWorkspaceData(
  rootDirectory: FileSystemDirectoryHandle,
  workspaceId: string,
  storageFolder?: string,
): Promise<void> {
  await removeEntryByPath(
    rootDirectory,
    joinPath(APP_DATA_DIR, WORKSPACES_DIR, workspaceId),
  );

  if (storageFolder) {
    await removeEntryByPath(rootDirectory, storageFolder);
  }

  await removeWorkspaceFromIndex(rootDirectory, workspaceId);
}
