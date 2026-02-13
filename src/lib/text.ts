const LOG_FILE_EXTENSIONS = new Set([
  "log",
  "txt",
  "out",
  "err",
  "json",
  "yaml",
  "yml",
  "xml",
  "csv",
  "conf",
  "cfg",
  "ini",
  "trace",
  "md",
]);

export function isLikelyText(bytes: Uint8Array, name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext && LOG_FILE_EXTENSIONS.has(ext)) {
    return true;
  }

  const sampleLength = Math.min(bytes.length, 2048);
  if (sampleLength === 0) {
    return true;
  }

  let binaryPoints = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const value = bytes[i];
    if (value === 0) {
      return false;
    }
    if (value < 9 || (value > 13 && value < 32)) {
      binaryPoints += 1;
    }
  }

  return binaryPoints / sampleLength < 0.08;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function createPreview(line: string, query: string, maxLength = 160): string {
  if (line.length <= maxLength) {
    return line;
  }

  const lowerLine = line.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerLine.indexOf(lowerQuery);

  if (index < 0) {
    return `${line.slice(0, maxLength)}...`;
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(line.length, index + lowerQuery.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < line.length ? "..." : "";
  return `${prefix}${line.slice(start, end)}${suffix}`;
}
