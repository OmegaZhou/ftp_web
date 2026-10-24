export interface ManifestEntry { relativePath: string; type: 'file' | 'directory'; size?: number; lastModified?: number }
export interface Selection { entries: ManifestEntry[]; files: Map<string, File>; preservesEmptyDirectories: boolean }
export interface ScanOptions { signal?: AbortSignal; onProgress?: (entries: number) => void }
interface DirectoryHandle { kind: 'directory'; name: string; values(): AsyncIterable<DirectoryHandle | FileHandle> }
interface FileHandle { kind: 'file'; name: string; getFile(): Promise<File> }
type PickerWindow = Window & { showDirectoryPicker?: () => Promise<DirectoryHandle> };
const MAX_ENTRIES = 10000;
const selectionPaths = new WeakMap<Selection, Set<string>>();

/** Reject ambiguous local paths before any task is created; the server repeats validation. */
export function validateRelativePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || /[\0\r\n]/.test(path)) throw new Error('文件路径无效。');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('文件路径包含不安全的目录片段。');
  if (parts.length > 64) throw new Error('目录层级过深（最多 64 层）。');
  return path;
}
function addEntry(selection: Selection, entry: ManifestEntry, file?: File) {
  validateRelativePath(entry.relativePath);
  if (selection.entries.length >= MAX_ENTRIES) throw new Error('一次最多选择 10,000 个文件与目录，请分批上传。');
  const paths = selectionPaths.get(selection) || new Set<string>();
  selectionPaths.set(selection, paths);
  if (paths.has(entry.relativePath)) throw new Error(`存在重复路径：${entry.relativePath}`);
  paths.add(entry.relativePath);
  selection.entries.push(entry);
  if (file) selection.files.set(entry.relativePath, file);
}
export function fromFileList(files: FileList | File[], directory = false): Selection {
  const selection: Selection = { entries: [], files: new Map(), preservesEmptyDirectories: !directory };
  const directories = new Set<string>();
  for (const file of Array.from(files)) {
    const path = directory ? file.webkitRelativePath || file.name : file.name;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    addEntry(selection, { relativePath: path, type: 'file', size: file.size, lastModified: file.lastModified }, file);
  }
  for (const path of directories) addEntry(selection, { relativePath: path, type: 'directory' });
  return selection;
}
function checkScan(selection: Selection, options: ScanOptions) {
  if (options.signal?.aborted) throw new DOMException('已取消扫描', 'AbortError');
  if (selection.entries.length % 25 === 0) options.onProgress?.(selection.entries.length);
}
async function walkHandle(handle: DirectoryHandle | FileHandle, parent: string, result: Selection, options: ScanOptions): Promise<void> {
  checkScan(result, options);
  const path = parent ? `${parent}/${handle.name}` : handle.name;
  if (handle.kind === 'file') {
    const file = await handle.getFile();
    checkScan(result, options);
    addEntry(result, { relativePath: path, type: 'file', size: file.size, lastModified: file.lastModified }, file);
    return;
  }
  addEntry(result, { relativePath: path, type: 'directory' });
  for await (const child of handle.values()) await walkHandle(child, path, result, options);
}
export async function pickDirectory(options: ScanOptions = {}): Promise<Selection | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  const directory = await picker.call(window);
  const selection: Selection = { entries: [], files: new Map(), preservesEmptyDirectories: true };
  await walkHandle(directory, '', selection, options);
  checkScan(selection, options); options.onProgress?.(selection.entries.length);
  return selection;
}
async function readEntry(entry: FileSystemEntry, parent: string, selection: Selection, options: ScanOptions): Promise<void> {
  checkScan(selection, options);
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    checkScan(selection, options);
    addEntry(selection, { relativePath: path, type: 'file', size: file.size, lastModified: file.lastModified }, file);
    return;
  }
  addEntry(selection, { relativePath: path, type: 'directory' });
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // Chromium returns directory entries in pages; stop only after an empty page.
  while (true) {
    checkScan(selection, options);
    const page = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!page.length) break;
    for (const child of page) await readEntry(child, path, selection, options);
  }
}
export async function readDrop(data: DataTransfer, options: ScanOptions = {}): Promise<Selection> {
  const entries = Array.from(data.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
  if (!entries.length || entries.some(entry => !entry)) return fromFileList(data.files, true);
  const selection: Selection = { entries: [], files: new Map(), preservesEmptyDirectories: true };
  for (const entry of entries) await readEntry(entry!, '', selection, options);
  checkScan(selection, options); options.onProgress?.(selection.entries.length);
  return selection;
}

/** Small candidate fingerprint is only a re-selection guard; full SHA-256 remains mandatory. */
export async function fingerprint(file: File) {
  const sample = new Uint8Array(await new Blob([file.slice(0, 65536), file.slice(Math.max(65536, file.size - 65536))]).arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', sample);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
