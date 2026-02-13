const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".zip", ".tar"];

export function normalizePath(input: string): string {
  const cleaned = input.replaceAll("\\", "/").replace(/\/+/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  const safe: string[] = [];

  for (const part of parts) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      safe.pop();
      continue;
    }
    safe.push(part);
  }

  return safe.join("/");
}

export function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized ? normalized.split("/") : [];
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

export function getBaseName(path: string): string {
  const segments = splitPath(path);
  return segments[segments.length - 1] ?? "";
}

export function stripArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return fileName.slice(0, -ext.length);
    }
  }
  return fileName;
}

export function isArchiveFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isZipFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".zip");
}

export function isTarGzFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

export function isTarFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".tar");
}
