import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, stat, statfs, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import type { Upload } from '@tus/utils';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { Store } from './store.ts';
import { FtpService } from './ftp.ts';
import { absolutePath, destinationPath, relativePath, siblingName } from './paths.ts';
import { ApiError, type Batch, type Entry, type Task, type TaskState } from './types.ts';

const RETENTION = 7 * 86400000;
const TERMINAL = new Set<TaskState>(['COMPLETED', 'CANCELLED', 'SKIPPED', 'EXPIRED']);
export interface TransferConfig { directory: string; chunkSize: number; maxChunkSize: number; maxFileSize: number; userQuota: number; globalQuota: number; reserveBytes: number; reserveRatio: number; maxBatchEntries: number }

/** FileStore remains the tus implementation; fsync checkpoints make acknowledged bytes durable. */
class DurableFiles extends FileStore {
  store: Store;
  pendingWrites = new Map<string, Promise<number>>();
  constructor(directory: string, store: Store) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    super({ directory, configstore: {
      async get(id) { const row = store.db.prepare('SELECT data FROM tus_metadata WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; },
      async set(id, value) { store.db.prepare('INSERT OR REPLACE INTO tus_metadata VALUES(?,?)').run(id, JSON.stringify(value)); },
      async delete(id) { store.db.prepare('DELETE FROM tus_metadata WHERE id=?').run(id); },
      async list() { return store.db.prepare('SELECT id FROM tus_metadata').all().map(row => row.id as string); },
    } });
    this.store = store;
    this.extensions = ['creation', 'termination'];
  }
  override async create(upload: Upload) {
    const task = this.store.taskByUpload(upload.id);
    if (!task || task.state !== 'RECEIVING') throw new ApiError(409, 'INVALID_STATE', '任务不能接收上传');
    const created = await super.create(upload);
    const file = await open(path.join(this.directory, upload.id), 'r+');
    try { await file.sync(); } finally { await file.close(); }
    task.uploadUrl = `/ftp/api/v2/uploads/${upload.id}`;
    this.store.saveTask(task);
    return created;
  }
  override async write(readable: IncomingMessage | Readable, id: string, offset: number) {
    const pending = (async () => {
      try { return await super.write(readable, id, offset); }
      finally {
        const file = await open(path.join(this.directory, id), 'r+');
        try {
          await file.sync();
          const size = (await file.stat()).size;
          const task = this.store.taskByUpload(id);
          if (task) { task.uploadedBytes = size; task.expiresAt = Date.now() + RETENTION; this.store.saveTask(task); }
        } finally { await file.close(); }
      }
    })();
    this.pendingWrites.set(id, pending);
    try { return await pending; }
    finally { if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id); }
  }
  async waitForWrite(id: string) { await this.pendingWrites.get(id); }
}

/** Single-process durable queue. SQL state is authoritative; timers only wake the worker. */
export class Transfers {
  store: Store; ftp: FtpService; config: TransferConfig; files: DurableFiles; tus: Server;
  locks = new Map<string, Promise<unknown>>();
  active = new Map<string, AbortController>();
  legacyReservations = new Map<string, { owner: string; size: number }>();
  timer: NodeJS.Timeout; running = false; closed = false; ready = false;
  constructor(store: Store, ftp: FtpService, config: TransferConfig) {
    this.store = store; this.ftp = ftp; this.config = config;
    this.files = new DurableFiles(path.join(config.directory, 'uploads'), store);
    this.tus = new Server({ path: '/ftp/api/v2/uploads', datastore: this.files, relativeLocation: true,
      maxSize: config.maxFileSize, allowedOrigins: [],
      namingFunction: async (_request, metadata) => {
        const task = store.getTask(metadata?.taskId ?? '');
        if (task.uploadUrl) throw { status_code: 409, body: 'Upload already exists; resume using HEAD' };
        return task.uploadId!;
      },
      onUploadCreate: async (_request, upload) => {
        const task = store.taskByUpload(upload.id);
        if (!task || upload.size !== task.size) throw { status_code: 409, body: 'Upload-Length does not match manifest' };
        return {};
      },
    });
    this.timer = setInterval(() => { void this.tick().catch(error => console.error('queue', error)); }, 500);
    this.timer.unref();
  }
  async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async recover() {
    for (const task of this.store.tasks()) {
      if (task.uploadId && !TERMINAL.has(task.state)) {
        try {
          const length = (await stat(this.filePath(task))).size;
          if (length > task.uploadedBytes) await truncate(this.filePath(task), task.uploadedBytes);
          if (length < task.uploadedBytes) { task.state = 'FAILED'; task.error = { code: 'STAGING_MISSING', message: '暂存长度与持久记录不符，请重新上传' }; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (task.uploadedBytes || task.uploadUrl) { task.state = 'FAILED'; task.error = { code: 'STAGING_MISSING', message: '暂存文件丢失，请重新上传' }; }
        }
      }
      if (['QUEUED', 'TRANSFERRING', 'COMMITTING'].includes(task.state)) task.state = 'AUTH_REQUIRED';
      this.store.saveTask(task);
    }
    this.ready = true;
  }
  filePath(task: Task) { return path.join(this.files.directory, task.uploadId!); }
  publicTask(task: Task) {
    const { owner: _owner, ...view } = task;
    const actions: string[] = [];
    if (['RECEIVING', 'VERIFYING', 'QUEUED', 'TRANSFERRING'].includes(task.state)) actions.push('pause');
    if (task.state === 'PAUSED') actions.push('resume');
    if (task.state === 'FAILED' && task.error?.code !== 'HASH_MISMATCH' && task.error?.code !== 'STAGING_MISSING') actions.push('retry');
    if (task.state === 'AUTH_REQUIRED') actions.push('reauthorize');
    if (!TERMINAL.has(task.state) && task.state !== 'COMMITTING') actions.push('cancel');
    return { ...view, actions, canClosePage: task.verified && ['QUEUED', 'TRANSFERRING', 'COMMITTING'].includes(task.state) };
  }
  async inspectEntries(owner: string, destination: string, input: unknown, prior: Entry[] = []): Promise<Entry[]> {
    if (!Array.isArray(input) || input.length > 500 || input.length + prior.length > this.config.maxBatchEntries) throw new ApiError(413, 'MANIFEST_LIMIT', '每批清单最多 500 条，请分批提交');
    const names = new Set(prior.map(entry => entry.relativePath.normalize('NFC').toLocaleLowerCase('en-US')));
    const entries = input.map(item => {
      if (!item || typeof item !== 'object') throw new ApiError(400, 'INVALID_MANIFEST', '清单条目格式无效');
      const relative = relativePath(item.relativePath);
      const key = relative.normalize('NFC').toLocaleLowerCase('en-US');
      if (names.has(key)) throw new ApiError(409, 'DUPLICATE_PATH', '清单中存在大小写或 Unicode 等价路径');
      names.add(key);
      if (!['file', 'directory'].includes(item.type) || !Number.isSafeInteger(item.type === 'directory' ? 0 : item.size) || item.size < 0 || item.size > this.config.maxFileSize) throw new ApiError(413, 'FILE_LIMIT', '文件类型或大小超出限制');
      return { id: randomUUID(), relativePath: relative, type: item.type, size: item.type === 'directory' ? 0 : item.size, lastModified: Number(item.lastModified) || 0, destinationPath: destinationPath(destination, relative), conflict: false } as Entry;
    });
    const all = [...prior, ...entries];
    const fileNames = new Set(all.filter(entry => entry.type === 'file').map(entry => entry.relativePath));
    for (const entry of all) {
      let parent = path.posix.dirname(entry.relativePath);
      while (parent !== '.') {
        if (fileNames.has(parent)) throw new ApiError(409, 'PATH_BLOCKED', '清单文件不能同时作为其他条目的父目录');
        parent = path.posix.dirname(parent);
      }
    }
    const listing = new Map<string, Awaited<ReturnType<FtpService['list']>> | null>();
    const lookup = async (directory: string): Promise<Awaited<ReturnType<FtpService['list']>> | null> => {
      if (listing.has(directory)) return listing.get(directory)!;
      if (directory !== '/') {
        const parent = await lookup(path.posix.dirname(directory));
        const entry = parent?.find(item => item.name === path.posix.basename(directory));
        if (!entry) { listing.set(directory, null); return null; }
        if (entry.type !== 'directory') throw new ApiError(409, 'PATH_BLOCKED', '目标路径经过文件或符号链接');
      }
      const result = await this.ftp.list(owner, directory); listing.set(directory, result); return result;
    };
    for (const entry of entries) {
      const found = (await lookup(path.posix.dirname(entry.destinationPath)))?.find(item => item.name.normalize('NFC').toLocaleLowerCase('en-US') === path.posix.basename(entry.destinationPath).normalize('NFC').toLocaleLowerCase('en-US'));
      if (found?.type === 'link' || (found && found.type !== entry.type)) throw new ApiError(409, 'TYPE_CONFLICT', '文件和目录类型冲突，或目标是符号链接');
      if (found && found.name !== path.posix.basename(entry.destinationPath)) throw new ApiError(409, 'AMBIGUOUS_PATH', '目标存在大小写或 Unicode 等价名称');
      entry.conflict = Boolean(found);
      entry.destinationVersion = found ? JSON.stringify([found.type, found.size, found.modifiedAt]) : null;
    }
    return entries;
  }
  async createBatch(owner: string, body: any): Promise<Batch> {
    const key = String(body.idempotencyKey ?? randomUUID());
    if (key.length > 128) throw new ApiError(400, 'INVALID_KEY', '幂等键过长');
    const existing = this.store.findBatch(owner, key);
    if (existing) return existing;
    const destination = absolutePath(body.destination);
    const entries = await this.inspectEntries(owner, destination, body.entries);
    const batch: Batch = { id: randomUUID(), owner, destination, entries, state: 'DRAFT', idempotencyKey: key, createdAt: Date.now() };
    this.store.saveBatch(batch); return batch;
  }
  async appendBatch(id: string, owner: string, input: unknown) {
    return this.lock(`batch:${id}`, async () => {
      const batch = this.store.getBatch(id, owner);
      if (batch.state !== 'DRAFT') throw new ApiError(409, 'INVALID_STATE', '批次已提交');
      batch.entries.push(...await this.inspectEntries(owner, batch.destination, input, batch.entries));
      this.store.saveBatch(batch); return batch;
    });
  }
  async checkQuota(owner: string, bytes: number) {
    const retained = this.store.tasks().filter(task => !TERMINAL.has(task.state) || task.cleanupPending);
    const sum = (tasks: Task[]) => tasks.reduce((total, task) => total + task.size, 0);
    const legacy = [...this.legacyReservations.values()];
    const legacyBytes = legacy.reduce((total, item) => total + item.size, 0);
    const legacyUserBytes = legacy.filter(item => item.owner === owner).reduce((total, item) => total + item.size, 0);
    if (sum(retained) + bytes + legacyBytes > this.config.globalQuota || sum(retained.filter(task => task.owner === owner)) + bytes + legacyUserBytes > this.config.userQuota) throw new ApiError(507, 'QUOTA_EXCEEDED', '暂存配额不足，请先完成或取消已有任务');
    const disk = await statfs(this.config.directory);
    const reserve = Math.max(this.config.reserveBytes, disk.blocks * disk.bsize * this.config.reserveRatio);
    const unreceived = retained.reduce((total, task) => total + task.size - task.uploadedBytes, 0);
    // Conservatively budget a second copy for FTP targets that share this filesystem.
    const transferCopies = retained.filter(task => !TERMINAL.has(task.state)).reduce((total, task) => total + task.size, 0);
    // Existing .part files already reduce bavail. Reserving a full remote copy remains conservative.
    if (disk.bavail * disk.bsize - bytes * 2 - unreceived - transferCopies - legacyBytes * 2 < reserve) throw new ApiError(507, 'DISK_RESERVE', '磁盘可用空间低于预留线');
  }
  async reserveLegacy(owner: string, size: number) {
    return this.lock('commit', async () => {
      if (this.legacyReservations.size >= 2) throw new ApiError(429, 'LEGACY_BUSY', '旧版同时最多上传两个文件，请稍后重试');
      await this.checkQuota(owner, size);
      const id = randomUUID(); this.legacyReservations.set(id, { owner, size }); return id;
    });
  }
  async commitBatch(id: string, owner: string, body: any) {
    return this.lock('commit', async () => {
      const batch = this.store.getBatch(id, owner);
      if (batch.state === 'COMMITTED') return { batch, tasks: this.store.tasks(owner).filter(task => task.batchId === id).map(task => this.publicTask(task)) };
      const policy = body.conflictPolicy;
      if (!['skip', 'keep-both', 'replace'].includes(policy)) throw new ApiError(409, 'CONFLICT_POLICY_REQUIRED', '请选择同名文件处理方式');
      if (policy === 'replace' && body.confirmReplace !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', '覆盖文件需要明确确认');
      // Recheck immediately before reservation: preflight results can become stale.
      const checked: Entry[] = [];
      for (let offset = 0; offset < batch.entries.length; offset += 500) checked.push(...await this.inspectEntries(owner, batch.destination, batch.entries.slice(offset, offset + 500), checked));
      if (policy === 'replace' && checked.some(entry => entry.destinationVersion !== batch.entries.find(original => original.relativePath === entry.relativePath)?.destinationVersion)) throw new ApiError(409, 'DESTINATION_CHANGED', '目标已在预检后变化，请重新预检后确认覆盖');
      const activePaths = new Set(this.store.tasks(owner).filter(task => !TERMINAL.has(task.state)).map(task => task.destinationPath));
      const tasks: Task[] = [];
      const remappedDirectories = new Map<string, string>();
      for (const entry of checked.sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length || Number(b.type === 'directory') - Number(a.type === 'directory') || a.relativePath.localeCompare(b.relativePath))) {
        const remapped = [...remappedDirectories].find(([oldPath]) => entry.destinationPath.startsWith(oldPath + '/'));
        if (remapped) { entry.destinationPath = remapped[1] + entry.destinationPath.slice(remapped[0].length); entry.conflict = false; entry.destinationVersion = null; }
        const isConflict = entry.conflict || activePaths.has(entry.destinationPath);
        if (isConflict && policy === 'keep-both') {
          const original = entry.destinationPath;
          for (let suffix = 1; suffix <= 9999; suffix++) {
            entry.destinationPath = siblingName(original, suffix);
            if (!activePaths.has(entry.destinationPath) && !await this.ftp.stat(owner, entry.destinationPath)) break;
            if (suffix === 9999) throw new ApiError(409, 'NAME_EXHAUSTED', '无法生成不重复的文件名');
          }
          if (entry.type === 'directory') remappedDirectories.set(original, entry.destinationPath);
          entry.destinationVersion = null;
        }
        if (activePaths.has(entry.destinationPath) && policy === 'replace') throw new ApiError(409, 'DESTINATION_BUSY', '另一个任务正在写入相同目标');
        const task: Task = { ...entry, id: randomUUID(), owner, batchId: id, state: isConflict && policy === 'skip' && entry.type === 'file' ? 'SKIPPED' : entry.type === 'directory' ? 'QUEUED' : 'RECEIVING', uploadId: entry.type === 'file' ? randomUUID() : null, uploadUrl: null, uploadedBytes: 0, transferredBytes: 0, sha256: null, verified: entry.type === 'directory', conflictPolicy: policy, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + RETENTION, attempts: 0, error: null };
        tasks.push(task); activePaths.add(task.destinationPath);
      }
      await this.checkQuota(owner, tasks.filter(task => task.state !== 'SKIPPED').reduce((total, task) => total + task.size, 0));
      this.store.transaction(() => { tasks.forEach(task => this.store.saveTask(task)); batch.state = 'COMMITTED'; this.store.saveBatch(batch); });
      return { batch, tasks: tasks.map(task => this.publicTask(task)) };
    });
  }
  async complete(uploadId: string, owner: string, sha256: unknown) {
    const found = this.store.taskByUpload(uploadId);
    if (!found || found.owner !== owner) throw new ApiError(404, 'NOT_FOUND', '上传不存在');
    return this.lock(found.id, async () => {
      const task = this.store.getTask(found.id, owner);
      if (typeof sha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(sha256)) throw new ApiError(400, 'INVALID_HASH', '需要完整 SHA-256 摘要');
      if (task.sha256 && task.sha256 !== sha256.toLowerCase()) throw new ApiError(409, 'HASH_CONFLICT', '摘要与首次完成声明不一致');
      if (TERMINAL.has(task.state) && task.state !== 'COMPLETED') throw new ApiError(409, 'INVALID_STATE', '任务已终止');
      if (task.sha256) return task;
      const upload = await this.files.getUpload(uploadId);
      if (upload.offset !== task.size || task.uploadedBytes !== task.size) throw new ApiError(409, 'INCOMPLETE', '上传尚未完整接收');
      if (task.state !== 'RECEIVING') throw new ApiError(409, 'INVALID_STATE', '请先恢复上传任务');
      task.sha256 = sha256.toLowerCase(); task.state = 'VERIFYING';
      this.store.transaction(() => this.store.saveTask(task));
      return task;
    });
  }
  async action(id: string, owner: string, action: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id, owner);
      if (!this.publicTask(task).actions.includes(action)) throw new ApiError(409, 'INVALID_STATE', '当前状态不支持此操作');
      if (action === 'pause') { task.resumeState = task.verified ? 'QUEUED' : task.sha256 ? 'VERIFYING' : 'RECEIVING'; task.state = 'PAUSED'; }
      if (action === 'resume' || action === 'retry') { task.state = task.verified ? 'QUEUED' : task.sha256 ? 'VERIFYING' : 'RECEIVING'; task.error = null; }
      if (action === 'cancel') { task.state = 'CANCELLED'; task.cleanupPending = true; }
      task.expiresAt = Date.now() + RETENTION;
      this.store.saveTask(task);
      this.active.get(id)?.abort();
      if (action === 'cancel' && !this.active.has(id)) await this.cleanup(task);
      return this.publicTask(this.store.getTask(id));
    });
  }
  reauthorize(owner: string) {
    for (const task of this.store.tasks(owner)) if (task.state === 'AUTH_REQUIRED') { task.state = task.verified ? 'QUEUED' : task.sha256 ? 'VERIFYING' : 'RECEIVING'; task.error = null; this.store.saveTask(task); }
  }
  revoke(owner: string) {
    this.ftp.credentials.delete(owner);
    for (const task of this.store.tasks(owner)) if (['QUEUED', 'TRANSFERRING'].includes(task.state)) { task.state = 'AUTH_REQUIRED'; this.store.saveTask(task); this.active.get(task.id)?.abort(); }
  }
  async cleanup(task: Task) {
    if (!task.uploadId) { task.cleanupPending = false; this.store.saveTask(task); return; }
    try { await unlink(this.filePath(task)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { task.cleanupPending = true; this.store.saveTask(task); return; } }
    await this.files.configstore.delete(task.uploadId);
    if (['CANCELLED', 'COMPLETED'].includes(task.state) && task.attempts > 0) {
      if (!this.ftp.credentials.has(task.owner)) return;
      try { await this.ftp.removeTemporary(task); }
      catch { task.cleanupPending = true; this.store.saveTask(task); return; }
    }
    task.cleanupPending = false; this.store.saveTask(task);
  }
  async tick() {
    if (this.running || this.closed || !this.ready) return;
    this.running = true;
    try {
      for (const snapshot of this.store.tasks()) {
        if (this.closed) break;
        const task = this.store.getTask(snapshot.id);
        if (task.cleanupPending && !this.active.has(task.id)) await this.cleanup(task);
        if (['RECEIVING', 'PAUSED'].includes(task.state) && !task.verified && !task.sha256 && task.expiresAt < Date.now() && !this.locks.has(task.id)) { task.state = 'EXPIRED'; task.cleanupPending = true; this.store.saveTask(task); await this.cleanup(task); }
        if (!['VERIFYING', 'QUEUED'].includes(task.state) || this.active.has(task.id)) continue;
        await this.run(task);
      }
      this.store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    } finally { this.running = false; }
  }
  async run(task: Task) {
    task = this.store.getTask(task.id);
    if (!['VERIFYING', 'QUEUED'].includes(task.state) || this.active.has(task.id)) return;
    const abort = new AbortController(); this.active.set(task.id, abort);
    try {
      if (task.state === 'VERIFYING') {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(this.filePath(task), { signal: abort.signal })) hash.update(chunk);
        abort.signal.throwIfAborted();
        if (hash.digest('hex') !== task.sha256) throw new ApiError(422, 'HASH_MISMATCH', '文件摘要不一致，请重新选择原文件上传');
        task.verified = true; task.state = 'QUEUED'; this.store.saveTask(task);
      }
      abort.signal.throwIfAborted();
      if (!this.ftp.credentials.has(task.owner)) { task.state = 'AUTH_REQUIRED'; this.store.saveTask(task); return; }
      await this.checkQuota(task.owner, 0);
      abort.signal.throwIfAborted();
      task.state = 'TRANSFERRING'; task.attempts++; task.transferredBytes = 0; this.store.saveTask(task);
      if (task.renameIntent) {
        const target = await this.ftp.stat(task.owner, task.destinationPath);
        if (target?.type === 'file' && target.size === task.size && await this.ftp.digest(task.owner, task.destinationPath, abort.signal) === task.sha256) { task.state = 'COMPLETED'; task.transferredBytes = task.size; task.cleanupPending = true; this.store.saveTask(task); return; }
      }
      if (task.type === 'directory') await this.ftp.mkdir(task.owner, task.destinationPath);
      else await this.ftp.transfer(task, this.filePath(task), { signal: abort.signal,
        progress: bytes => { const latest = this.store.getTask(task.id); if (latest.state === 'TRANSFERRING') { latest.transferredBytes = Math.min(bytes, task.size); this.store.saveTask(latest); } },
        committing: () => { abort.signal.throwIfAborted(); task.state = 'COMMITTING'; task.renameIntent = true; this.store.saveTask(task); },
      });
      abort.signal.throwIfAborted();
      task.state = 'COMPLETED'; task.transferredBytes = task.size; task.cleanupPending = true; this.store.saveTask(task);
    } catch (error) {
      const latest = this.store.getTask(task.id);
      if (!abort.signal.aborted && !['PAUSED', 'CANCELLED', 'AUTH_REQUIRED'].includes(latest.state)) {
        latest.state = 'FAILED'; latest.error = { code: error instanceof ApiError ? error.code : 'FTP_ERROR', message: error instanceof ApiError ? error.message : 'FTP 传输或校验失败，可重试' }; this.store.saveTask(latest);
      }
    } finally {
      this.active.delete(task.id);
      const latest = this.store.getTask(task.id);
      if (latest.cleanupPending) await this.cleanup(latest);
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    this.active.forEach(controller => controller.abort());
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
