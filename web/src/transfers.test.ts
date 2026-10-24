import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './transfers';
import type { Session } from './api';
const { requestMock, postMock, uploads, saved } = vi.hoisted(() => ({ requestMock: vi.fn(), postMock: vi.fn(), uploads: [] as any[], saved: [] as any[] }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), request: requestMock, post: postMock }));
vi.mock('./storage', () => ({ readRecords: async () => [], saveRecord: async (record: unknown) => { saved.push(record); }, deleteRecord: async () => {} }));
vi.mock('tus-js-client', () => ({ Upload: class { url: string | null = null; options: any; constructor(_: unknown, options: any) { this.options = options; uploads.push(this); } start() {} abort() { return Promise.resolve(); } } }));
vi.stubGlobal('navigator', { onLine: true });
vi.stubGlobal('document', { hidden: false });
vi.stubGlobal('Worker', class { onmessage?: (event: { data: unknown }) => void; postMessage() {} terminate() {} });
const { TransferQueue, backgroundNotice, summarizeBatches } = await import('./transfers');
const session = { authenticated: true, user: { id: 'owner', username: 'test' }, csrfToken: 'token', config: { chunkSize: 4 * 1024 * 1024 } } as Session;
const task = (patch: Partial<Task> = {}): Task => ({ id: 'one', batchId: 'batch', relativePath: 'one.txt', destinationPath: '/one.txt', type: 'file', size: 3, lastModified: 123, state: 'RECEIVING', uploadId: 'upload-one', uploadUrl: null, uploadedBytes: 0, transferredBytes: 0, sha256: null, verified: false, createdAt: '', updatedAt: '', expiresAt: '', attempts: 0, error: null, actions: ['pause', 'cancel'], canClosePage: false, ...patch });
let queue: InstanceType<typeof TransferQueue>;
beforeEach(() => { uploads.length = 0; saved.length = 0; requestMock.mockReset(); postMock.mockReset(); requestMock.mockResolvedValue({ tasks: [], nextCursor: null }); queue = new TransferQueue(); });
afterEach(async () => { await queue.stop(); });

describe('accurate background promises', () => {
  it('does not promise a waiting directory can continue', () => {
    expect(backgroundNotice([task({ type: 'directory', state: 'AUTH_REQUIRED' })])).toEqual({ safe: false, message: '有任务等待重新登录授权。服务器保留任务与已收字节；授权后才能继续 FTP 转存。' });
  });
  it('distinguishes server pauses from an active local upload', () => {
    expect(backgroundNotice([task({ state: 'PAUSED' })]).message).toContain('暂时不会继续');
    expect(backgroundNotice([task({ state: 'PAUSED' })]).message).not.toContain('请保持页面打开');
  });
  it('requires every active task to pass the server gate', () => {
    expect(backgroundNotice([task({ canClosePage: true, state: 'TRANSFERRING' }), task({ id: 'two', state: 'VERIFYING' })]).safe).toBe(false);
    expect(backgroundNotice([task({ canClosePage: true, state: 'TRANSFERRING' })]).safe).toBe(true);
  });
});
describe('transfer recovery and ownership', () => {
  it('limits simultaneous file uploads and uses the server chunk configuration', async () => {
    await queue.connect(session);
    const tasks = [0, 1, 2].map(index => task({ id: String(index), relativePath: `${index}.txt` }));
    const files = new Map(tasks.map(item => [item.relativePath, new File(['abc'], item.relativePath, { lastModified: 123 })]));
    await queue.add(tasks, { entries: [], files, preservesEmptyDirectories: true });
    await vi.waitFor(() => expect(uploads.length).toBe(2));
    expect(uploads.every(upload => upload.options.chunkSize === 4 * 1024 * 1024 && upload.options.parallelUploads === 1)).toBe(true);
    expect(saved.every(record => record.owner === 'owner' && !('password' in record))).toBe(true);
  });
  it('resumes a saved server URL instead of creating a second upload', async () => {
    await queue.connect(session);
    const item = task({ uploadUrl: '/ftp/api/v2/uploads/existing', uploadedBytes: 2 });
    await queue.add([item], { entries: [], files: new Map([['one.txt', new File(['abc'], 'one.txt')]]), preservesEmptyDirectories: true });
    await vi.waitFor(() => expect(uploads.length).toBe(1));
    expect(uploads[0].options.uploadUrl).toBe('/ftp/api/v2/uploads/existing');
  });
  it('keeps refreshed tasks waiting until matching files are reselected', async () => {
    requestMock.mockResolvedValue({ tasks: [task()], nextCursor: null });
    await queue.connect(session);
    expect(queue.getSnapshot().progress.one.needsFile).toBe(true);
    expect(await queue.reselect([new File(['wrong size'], 'one.txt', { lastModified: 123 })])).toBe(0);
    expect(uploads.length).toBe(0);
    expect(await queue.reselect([new File(['abc'], 'one.txt', { lastModified: 123 })])).toBe(1);
    await vi.waitFor(() => expect(uploads.length).toBe(1));
  });
  it('discards an old account response after switching accounts', async () => {
    let resolveFirst!: (value: unknown) => void;
    requestMock.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
    const first = queue.connect(session);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    await queue.connect({ ...session, user: { id: 'other', username: 'other' } });
    resolveFirst({ tasks: [task()], nextCursor: null });
    await first;
    expect(queue.getSnapshot().tasks).toEqual([]);
  });
  it('discards an old account failure without expiring the new login', async () => {
    const { ApiError } = await import('./api');
    let rejectFirst!: (error: unknown) => void;
    const authRequired = vi.fn(); queue.onAuthRequired = authRequired;
    requestMock.mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }));
    const first = queue.connect(session);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    await queue.connect({ ...session, user: { id: 'other', username: 'other' } });
    rejectFirst(new ApiError(401, 'old session expired'));
    await first;
    expect(authRequired).not.toHaveBeenCalled();
    expect(queue.getSnapshot().error).toBe('');
  });
});

describe('bounded bulk transfer commands', () => {
  it('executes eligible commands one at a time within the selected batch', async () => {
    const tasks = [task(), task({ id: 'two' }), task({ id: 'paused', state: 'PAUSED', actions: ['resume'] }), task({ id: 'other', batchId: 'other-batch' })];
    requestMock.mockResolvedValue({ tasks, nextCursor: null });
    await queue.connect(session);
    let finishFirst!: (value: Task) => void;
    postMock.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; })).mockResolvedValue(task({ id: 'two', state: 'PAUSED', actions: ['resume'] }));
    const running = queue.bulkAction('pause', 'batch');
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenNthCalledWith(1, '/tasks/one/pause');
    finishFirst(task({ state: 'PAUSED', actions: ['resume'] }));
    const result = await running;
    expect(postMock).toHaveBeenNthCalledWith(2, '/tasks/two/pause');
    expect(result).toMatchObject({ requested: 2, completed: 2, failed: 0, skipped: 0, interrupted: false });
  });
  it('reports a partial retry failure and continues only retryable tasks', async () => {
    const { ApiError } = await import('./api');
    requestMock.mockResolvedValue({ tasks: [task({ state: 'FAILED', actions: ['retry'] }), task({ id: 'two', state: 'FAILED', actions: ['retry'] }), task({ id: 'hash-failure', state: 'FAILED', actions: ['cancel'] })], nextCursor: null });
    await queue.connect(session);
    postMock.mockRejectedValueOnce(new ApiError(502, 'FTP 暂不可用')).mockResolvedValueOnce(task({ id: 'two', state: 'QUEUED' }));
    const result = await queue.bulkAction('retry');
    expect(result).toMatchObject({ requested: 2, completed: 1, failed: 1, skipped: 0, interrupted: false });
    expect(result.failures).toEqual([{ id: 'one', message: 'one.txt：FTP 暂不可用' }]);
    expect(postMock).toHaveBeenCalledTimes(2);
  });
  it('skips tasks whose available actions change while an earlier command is pending', async () => {
    const tasks = [task(), task({ id: 'two' })];
    requestMock.mockResolvedValue({ tasks, nextCursor: null });
    await queue.connect(session);
    let finishFirst!: (value: Task) => void;
    postMock.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }));
    const running = queue.bulkAction('pause');
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    requestMock.mockResolvedValue({ tasks: [task(), task({ id: 'two', state: 'COMPLETED', actions: [] })], nextCursor: null });
    await queue.refresh();
    finishFirst(task({ state: 'PAUSED', actions: ['resume'] }));
    expect(await running).toMatchObject({ requested: 2, completed: 1, skipped: 1 });
    expect(postMock).toHaveBeenCalledTimes(1);
  });
  it('stops scheduling after cancellation without undoing a confirmed command', async () => {
    requestMock.mockResolvedValue({ tasks: [task({ state: 'PAUSED', actions: ['resume'] }), task({ id: 'two', state: 'PAUSED', actions: ['resume'] })], nextCursor: null });
    await queue.connect(session);
    const controller = new AbortController();
    let finishFirst!: (value: Task) => void;
    postMock.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }));
    const running = queue.bulkAction('resume', '', { signal: controller.signal });
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    controller.abort(); finishFirst(task({ state: 'RECEIVING' }));
    expect(await running).toMatchObject({ requested: 2, completed: 1, interrupted: true });
    expect(postMock).toHaveBeenCalledTimes(1);
  });
  it('isolates late bulk failures from a newly logged-in owner', async () => {
    const { ApiError } = await import('./api');
    requestMock.mockResolvedValue({ tasks: [task(), task({ id: 'two' })], nextCursor: null });
    await queue.connect(session);
    let rejectFirst!: (error: unknown) => void;
    const onProgress = vi.fn(), onAuthRequired = vi.fn(); queue.onAuthRequired = onAuthRequired;
    postMock.mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }));
    const running = queue.bulkAction('pause', '', { onProgress });
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    requestMock.mockResolvedValue({ tasks: [task({ id: 'new-owner-task', state: 'PAUSED', actions: ['resume'] })], nextCursor: null });
    await queue.connect({ ...session, user: { id: 'new-owner', username: 'new' } });
    const progressCalls = onProgress.mock.calls.length;
    rejectFirst(new ApiError(401, 'old request expired'));
    expect(await running).toMatchObject({ interrupted: true, completed: 0 });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(progressCalls);
    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(queue.getSnapshot().ownerId).toBe('new-owner');
    expect(queue.getSnapshot().error).toBe('');
    expect(queue.getSnapshot().tasks.map(task => task.id)).toEqual(['new-owner-task']);
  });
});

describe('batch summaries', () => {
  it('aggregates actual states and counts all directory levels separately', () => {
    const tasks = [task({ type: 'directory', relativePath: 'folder', state: 'COMPLETED' }), task({ id: 'nested', type: 'directory', relativePath: 'folder/child', state: 'QUEUED' }), task({ id: 'ok', relativePath: 'folder/file.txt', state: 'COMPLETED' }), task({ id: 'bad', state: 'FAILED' }), task({ id: 'skip', state: 'SKIPPED' }), task({ id: 'cancel', state: 'CANCELLED' }), task({ id: 'expired', state: 'EXPIRED' }), task({ id: 'other', batchId: 'other', createdAt: 100 })];
    expect(summarizeBatches(tasks)).toEqual([
      { id: 'other', label: 'one.txt', createdAt: 100, total: 1, files: 1, directories: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, expired: 0, active: 1 },
      { id: 'batch', label: 'folder', createdAt: 0, total: 7, files: 5, directories: 2, succeeded: 2, failed: 1, skipped: 1, cancelled: 1, expired: 1, active: 1 },
    ]);
  });
});
