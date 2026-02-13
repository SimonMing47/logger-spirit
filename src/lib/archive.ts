import { gunzipSync, unzipSync } from "fflate";

import {
  getBaseName,
  isArchiveFile,
  isTarFile,
  isTarGzFile,
  isZipFile,
  joinPath,
  normalizePath,
  stripArchiveExtension,
} from "@/lib/path";
import { isLikelyText } from "@/lib/text";

export type ExtractedFile = {
  path: string;
  size: number;
  bytes: Uint8Array;
  textLike: boolean;
};

type ArchiveEntry = {
  path: string;
  bytes: Uint8Array;
  kind: "file" | "dir";
};

const MAX_DEPTH = 12;

function isIgnorableMetadataPath(entryPath: string): boolean {
  const normalized = normalizePath(entryPath);
  if (!normalized) {
    return true;
  }

  if (normalized.startsWith("__MACOSX/")) {
    return true;
  }

  const baseName = getBaseName(normalized);
  if (baseName.startsWith("._") || baseName === ".DS_Store") {
    return true;
  }

  return false;
}

function readAscii(view: Uint8Array, start: number, length: number): string {
  const end = start + length;
  let value = "";

  for (let i = start; i < end && i < view.length; i += 1) {
    const code = view[i];
    if (code === 0) {
      break;
    }
    value += String.fromCharCode(code);
  }

  return value.trim();
}

function parseTarSize(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) {
    return 0;
  }

  return Number.parseInt(normalized, 8) || 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const attrs: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex < 0) {
      continue;
    }
    const payload = trimmed.slice(spaceIndex + 1);
    const equals = payload.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const key = payload.slice(0, equals);
    const value = payload.slice(equals + 1);
    attrs[key] = value;
  }

  return attrs;
}

function parseTarEntries(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const isEmpty = header.every((value) => value === 0);

    if (isEmpty) {
      break;
    }

    const name = readAscii(header, 0, 100);
    const sizeRaw = readAscii(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const prefix = readAscii(header, 345, 155);

    const baseName = prefix ? `${prefix}/${name}` : name;
    const size = parseTarSize(sizeRaw);
    const contentStart = offset + 512;
    const contentEnd = Math.min(contentStart + size, bytes.length);
    const content = bytes.subarray(contentStart, contentEnd);

    if (typeFlag === "L") {
      pendingPath = readAscii(content, 0, content.length);
    } else if (typeFlag === "x") {
      const attrs = parsePax(content);
      if (attrs.path) {
        pendingPath = attrs.path;
      }
    } else {
      const resolved = normalizePath(pendingPath ?? baseName);
      pendingPath = undefined;

      if (resolved) {
        if (typeFlag === "5") {
          entries.push({ path: resolved, bytes: new Uint8Array(), kind: "dir" });
        } else {
          entries.push({ path: resolved, bytes: content.slice(), kind: "file" });
        }
      }
    }

    const blocks = Math.ceil(size / 512);
    offset = contentStart + blocks * 512;
  }

  return entries;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function hasGzipSignature(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function hasTarSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 265) {
    return false;
  }
  const signature = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(257, 262),
  );
  return signature.includes("ustar");
}

function parseArchiveEntries(fileName: string, bytes: Uint8Array): ArchiveEntry[] {
  const shortName = getBaseName(fileName);

  if (isZipFile(shortName) || hasZipSignature(bytes)) {
    const zipped = unzipSync(bytes);
    return Object.entries(zipped).map(([entryPath, entryBytes]) => ({
      path: normalizePath(entryPath),
      bytes: entryBytes,
      kind: entryPath.endsWith("/") ? "dir" : "file",
    }));
  }

  if (isTarGzFile(shortName) || hasGzipSignature(bytes)) {
    const tarBytes = gunzipSync(bytes);
    return parseTarEntries(tarBytes);
  }

  if (isTarFile(shortName) || hasTarSignature(bytes)) {
    return parseTarEntries(bytes);
  }

  throw new Error(`Unsupported archive type: ${fileName}`);
}

function walkArchive(
  fileName: string,
  bytes: Uint8Array,
  basePath: string,
  depth: number,
  output: ExtractedFile[],
): void {
  if (depth > MAX_DEPTH) {
    const finalPath = joinPath(basePath, getBaseName(fileName));
    output.push({
      path: finalPath,
      size: bytes.length,
      bytes,
      textLike: isLikelyText(bytes, finalPath),
    });
    return;
  }

  const entries = parseArchiveEntries(fileName, bytes);

  for (const entry of entries) {
    const entryPath = normalizePath(entry.path);
    if (!entryPath || entry.kind === "dir" || isIgnorableMetadataPath(entryPath)) {
      continue;
    }

    const mergedPath = joinPath(basePath, entryPath);
    const entryName = getBaseName(entryPath);

    if (isArchiveFile(entryName)) {
      const nextBase = stripArchiveExtension(mergedPath);
      try {
        walkArchive(entryName, entry.bytes, nextBase, depth + 1, output);
        continue;
      } catch {
        // Fallback for metadata artifacts or broken nested archives.
      }
    }

    output.push({
      path: mergedPath,
      size: entry.bytes.length,
      bytes: entry.bytes,
      textLike: isLikelyText(entry.bytes, entryName),
    });
  }
}

export function extractArchiveRecursively(
  fileName: string,
  bytes: Uint8Array,
): ExtractedFile[] {
  const output: ExtractedFile[] = [];
  walkArchive(fileName, bytes, "", 0, output);
  return output;
}
