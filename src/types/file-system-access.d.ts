type WellKnownDirectory =
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos";

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: WellKnownDirectory | FileSystemHandle;
}

interface Window {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
