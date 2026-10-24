import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fingerprint, fromFileList, readDrop, validateRelativePath } from './files';
import { hashFile } from './hash';

describe('folder manifests', () => {
  it('preserves Unicode and percent names while declaring empty-directory limitations', () => {
    const file = new File(['hello'], '旅行 100%.txt', { lastModified: 123 });
    Object.defineProperty(file, 'webkitRelativePath', { value: '回忆/秋日/旅行 100%.txt' });
    const result = fromFileList([file], true);
    expect(result.entries.map(entry => entry.relativePath)).toEqual(['回忆/秋日/旅行 100%.txt', '回忆', '回忆/秋日']);
    expect(result.preservesEmptyDirectories).toBe(false);
  });
  it.each(['/absolute', 'C:/file', '../file', 'a/../file', 'a//b', 'a\\b', 'a\0b'])('rejects unsafe path %s', path => {
    expect(() => validateRelativePath(path)).toThrow();
  });
  it('enumerates every drag-directory page and preserves empty folders', async () => {
    const file = new File(['data'], 'one.txt');
    const leaf = { name: 'one.txt', isFile: true, file: (done: (file: File) => void) => done(file) };
    const empty = { name: 'empty', isFile: false, createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done([]) }) };
    const pages = [[leaf], [empty], []];
    const entry = { name: 'root', isFile: false, createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done(pages.shift()!) }) };
    const drop = { items: [{ kind: 'file', webkitGetAsEntry: () => entry }] } as unknown as DataTransfer;
    const result = await readDrop(drop);
    expect(result.entries.map(item => item.relativePath)).toEqual(['root', 'root/one.txt', 'root/empty']);
    expect(result.preservesEmptyDirectories).toBe(true);
  });
  it('does not silently merge duplicate paths', () => {
    expect(() => fromFileList([new File(['one'], 'same.txt'), new File(['two'], 'same.txt')])).toThrow('重复路径');
  });
  it('cancels a directory scan while a file read is pending', async () => {
    const controller = new AbortController();
    const entry = { name: 'one.txt', isFile: true, file: (done: (file: File) => void) => { controller.abort(); done(new File(['one'], 'one.txt')); } };
    const drop = { items: [{ kind: 'file', webkitGetAsEntry: () => entry }] } as unknown as DataTransfer;
    await expect(readDrop(drop, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('reports a final count including empty directories', async () => {
    const entry = { name: 'empty', isFile: false, createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done([]) }) };
    const drop = { items: [{ kind: 'file', webkitGetAsEntry: () => entry }] } as unknown as DataTransfer;
    const progress = vi.fn();
    await readDrop(drop, { onProgress: progress });
    expect(progress).toHaveBeenLastCalledWith(1);
  });
  it('distinguishes same-size candidates with different contents', async () => {
    expect(await fingerprint(new File(['one'], 'same.txt'))).not.toBe(await fingerprint(new File(['two'], 'same.txt')));
  });
});

describe('bounded full-file integrity', () => {
  it('matches an independent SHA-256 across multiple read boundaries', async () => {
    const bytes = Uint8Array.from({ length: 5 * 1024 * 1024 + 19 }, (_, index) => index % 251);
    const blob = new Blob([bytes]);
    const slice = vi.spyOn(blob, 'slice');
    const progress: number[] = [];
    expect(await hashFile(blob, bytes => progress.push(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(slice.mock.calls.every(([start, end]) => (end || 0) - (start || 0) <= 2 * 1024 * 1024)).toBe(true);
    expect(progress).toEqual([2097152, 4194304, bytes.length]);
  });
  it('hashes empty files correctly', async () => {
    expect(await hashFile(new Blob([]), () => {})).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('reports local read errors instead of accepting partial hashes', async () => {
    const blob = new Blob(['broken']);
    vi.spyOn(blob, 'slice').mockReturnValue({ arrayBuffer: () => Promise.reject(new Error('read failed')) } as Blob);
    await expect(hashFile(blob, () => {})).rejects.toThrow('read failed');
  });
});
