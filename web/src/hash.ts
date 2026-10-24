import { createSHA256 } from 'hash-wasm';

/** Stream 2 MiB slices without allocating a whole-file buffer. Called only in the worker. */
export async function hashFile(file: Blob, progress: (bytes: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const blockSize = 2 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += blockSize) {
    const block = new Uint8Array(await file.slice(offset, offset + blockSize).arrayBuffer());
    hasher.update(block);
    progress(Math.min(file.size, offset + blockSize));
  }
  return hasher.digest('hex');
}
