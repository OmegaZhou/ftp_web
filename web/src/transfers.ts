import { Upload } from 'tus-js-client';
import { API, ApiError, getSessionToken, post, request, type Session } from './api';
import { fingerprint, type Selection } from './files';
import { deleteRecord, readRecords, saveRecord, type UploadRecord } from './storage';

export interface Task {
  id: string; batchId: string; relativePath: string; destinationPath: string; type: 'file' | 'directory';
  size: number; lastModified: number; state: string; uploadId: string; uploadUrl: string | null;
  uploadedBytes: number; transferredBytes: number; sha256: string | null; verified: boolean;
  createdAt: string | number; updatedAt: string | number; expiresAt: string | number; attempts: number;
  error: { code: string; message: string } | null; actions: string[]; canClosePage: boolean;
}
export interface ClientProgress { bytes: number; hashBytes: number; busy: boolean; error?: string; needsFile?: boolean }
interface Running { upload?: Upload; worker?: Worker; controller: AbortController }
interface Snapshot { ownerId: string | null; tasks: Task[]; progress: Record<string, ClientProgress>; error: string; storageWarning: string; online: boolean }
export type BulkAction = 'pause' | 'resume' | 'retry';
export interface BulkResult { requested: number; completed: number; failed: number; skipped: number; interrupted: boolean; failures: { id: string; message: string }[] }
export interface BatchSummary { id: string; label: string; createdAt: number; total: number; files: number; directories: number; succeeded: number; failed: number; skipped: number; cancelled: number; expired: number; active: number }
const FINISHED = new Set(['COMPLETED', 'CANCELLED', 'SKIPPED', 'EXPIRED']);
export const STATE_LABELS: Record<string, string> = {
  RECEIVING: '上传至服务器', VERIFYING: '服务器校验中', QUEUED: '等待转存', TRANSFERRING: '转存至 FTP',
  COMMITTING: '确认目标文件', PAUSED: '已暂停', AUTH_REQUIRED: '等待重新授权', FAILED: '传输失败',
  COMPLETED: '已完成', CANCELLED: '已取消', SKIPPED: '已跳过', EXPIRED: '暂存已到期',
};

/** The transfer store lives outside route components, so navigation never interrupts upload. */
export class TransferQueue {
  private snapshot: Snapshot = { ownerId: null, tasks: [], progress: {}, error: '', storageWarning: '', online: navigator.onLine };
  private listeners = new Set<() => void>();
  private files = new Map<string, File>();
  private records = new Map<string, UploadRecord>();
  private running = new Map<string, Running>();
  private blocked = new Set<string>();
  private session?: Session;
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private polling = false;
  private epoch = 0;
  private bulkToken: symbol | null = null;
  onAuthRequired: () => void = () => {};
  getSnapshot = () => this.snapshot;
  getContext = () => `${this.session?.user?.id || ''}:${this.epoch}`;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(update: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...update }; this.listeners.forEach(listener => listener()); }
  private progress(id: string, update: Partial<ClientProgress>) {
    this.publish({ progress: { ...this.snapshot.progress, [id]: { ...(this.snapshot.progress[id] || { bytes: 0, hashBytes: 0, busy: false }), ...update } } });
  }
  private async persist(record: UploadRecord) {
    this.records.set(record.id, record);
    try { await saveRecord(record); }
    catch { this.publish({ storageWarning: '浏览器未允许保存恢复信息。服务器任务仍保留；刷新后需重新选择原文件。' }); }
  }
  async connect(session: Session) {
    const changed = this.session?.user?.id !== session.user?.id;
    if (changed) { await this.stop(); this.files.clear(); this.records.clear(); this.publish({ ownerId: session.user?.id || null, tasks: [], progress: {}, error: '', storageWarning: '' }); }
    this.session = session;
    this.enabled = session.authenticated;
    if (!this.enabled || !session.user) return;
    try { for (const record of await readRecords(session.user.id)) this.records.set(record.id, record); }
    catch { this.publish({ storageWarning: '恢复信息无法读取，请重新选择原文件以继续未完成的上传。' }); }
    this.blocked.clear();
    await this.refresh();
  }
  async stop() {
    this.enabled = false;
    this.epoch++; this.polling = false;
    this.bulkToken = null;
    clearTimeout(this.timer);
    await Promise.all([...this.running.keys()].map(id => this.abort(id)));
  }
  async refresh() {
    if (!this.enabled || this.polling) return;
    const epoch = this.epoch;
    this.polling = true;
    try {
      let cursor: string | null = null;
      const tasks: Task[] = [];
      do {
        const page: { tasks: Task[]; nextCursor: string | null } = await request(`/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        tasks.push(...page.tasks); cursor = page.nextCursor;
      } while (cursor);
      if (!this.enabled || epoch !== this.epoch) return;
      this.publish({ tasks, error: '', online: navigator.onLine });
      for (const task of tasks) {
        if (FINISHED.has(task.state)) {
          this.files.delete(task.id);
          if (this.records.delete(task.id)) deleteRecord(task.id).catch(() => this.publish({ storageWarning: '本地已完成任务的记录清理失败。' }));
        }
      }
      this.pump();
    } catch (error) { if (epoch === this.epoch) this.handleError(error); }
    finally {
      if (epoch === this.epoch) {
        this.polling = false;
        clearTimeout(this.timer);
        if (this.enabled) this.timer = setTimeout(() => void this.refresh(), document.hidden ? 10000 : 2500);
      }
    }
  }
  private handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      void this.stop(); this.onAuthRequired();
      this.publish({ error: '登录已过期。重新登录后可继续，已收字节会保留。' });
    } else this.publish({ error: error instanceof Error ? error.message : '暂时无法取得任务状态。', online: navigator.onLine });
  }
  async add(tasks: Task[], selection: Selection) {
    this.publish({ tasks: [...tasks, ...this.snapshot.tasks.filter(existing => !tasks.some(task => task.id === existing.id))] });
    for (const task of tasks) {
      const file = selection.files.get(task.relativePath);
      if (file && !FINISHED.has(task.state)) this.files.set(task.id, file);
    }
    this.pump();
  }
  async reselect(files: File[], options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}) {
    let matched = 0;
    let examined = 0;
    for (const task of this.snapshot.tasks.filter(task => !FINISHED.has(task.state) && task.type === 'file')) {
      if (options.signal?.aborted) throw new DOMException('已取消读取', 'AbortError');
      const record = this.records.get(task.id);
      const candidates = files.filter(file => (file.webkitRelativePath === task.relativePath || file.name === task.relativePath.split('/').pop()) && file.size === task.size);
      for (const file of candidates) {
        if (record?.fingerprint && await fingerprint(file) !== record.fingerprint) continue;
        if (options.signal?.aborted) throw new DOMException('已取消读取', 'AbortError');
        if (!record?.fingerprint && task.lastModified && file.lastModified !== task.lastModified) continue;
        this.files.set(task.id, file); this.blocked.delete(task.id); this.progress(task.id, { needsFile: false, error: undefined }); matched++;
        break;
      }
      options.onProgress?.(++examined);
    }
    this.pump();
    return matched;
  }
  private pump() {
    if (!this.enabled || !this.session?.config.chunkSize || !navigator.onLine) return;
    for (const task of this.snapshot.tasks) {
      if (this.running.size >= 2) break;
      if (task.type !== 'file' || task.state !== 'RECEIVING' || this.running.has(task.id) || this.blocked.has(task.id)) continue;
      const file = this.files.get(task.id);
      if (!file) { this.progress(task.id, { needsFile: true }); continue; }
      const running: Running = { controller: new AbortController() };
      this.running.set(task.id, running);
      void this.run(task, file, running).finally(() => { if (this.running.get(task.id) === running) this.running.delete(task.id); this.pump(); });
    }
  }
  private async run(task: Task, file: File, running: Running) {
    this.progress(task.id, { busy: true, needsFile: false, error: undefined });
    try {
      const previous = this.records.get(task.id);
      const record: UploadRecord = { id: task.id, owner: this.session!.user!.id, relativePath: task.relativePath,
        name: file.name, size: file.size, lastModified: file.lastModified, fingerprint: await fingerprint(file),
        uploadUrl: task.uploadUrl || previous?.uploadUrl, sha256: previous?.sha256 };
      await this.persist(record);
      if (running.controller.signal.aborted) return;
      // Hashing and transmission start together. Only two file workers can exist at a time.
      const [sha256] = await Promise.all([this.hash(task, file, running), this.upload(task, file, running, record)]);
      if (running.controller.signal.aborted) return;
      record.sha256 = sha256; await this.persist(record);
      const result = await post<{ task: Task }>(`/uploads/${task.uploadId}/complete`, { sha256 });
      this.replaceTask(result.task);
    } catch (error) {
      if (!running.controller.signal.aborted) {
        running.controller.abort(); running.worker?.terminate(); await running.upload?.abort();
        this.blocked.add(task.id);
        this.progress(task.id, { error: error instanceof Error ? error.message : '上传失败，请重试。' });
        this.handleError(error);
      }
    } finally { this.progress(task.id, { busy: false }); }
  }
  private hash(task: Task, file: File, running: Running): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
      running.worker = worker;
      running.controller.signal.addEventListener('abort', () => { worker.terminate(); reject(new Error('已暂停')); }, { once: true });
      worker.onmessage = event => {
        if (event.data.error) { worker.terminate(); reject(new Error(event.data.error)); return; }
        this.progress(task.id, { hashBytes: event.data.bytes });
        if (event.data.sha256) { worker.terminate(); resolve(event.data.sha256); }
      };
      worker.onerror = () => { worker.terminate(); reject(new Error('文件校验线程未能启动，请重试。')); };
      worker.postMessage({ file });
    });
  }
  private upload(task: Task, file: File, running: Running, record: UploadRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const upload = new Upload(file, {
        endpoint: `${API}/uploads`, uploadUrl: record.uploadUrl, metadata: { taskId: task.id },
        chunkSize: this.session!.config.chunkSize, parallelUploads: 1, retryDelays: [0, 1000, 3000, 5000, 10000],
        storeFingerprintForResuming: false, removeFingerprintOnSuccess: true,
        headers: { 'X-CSRF-Token': getSessionToken() },
        onBeforeRequest: request => { const xhr = request.getUnderlyingObject(); xhr.withCredentials = true; xhr.timeout = 120_000; },
        onShouldRetry: error => { const status = error.originalResponse?.getStatus(); return status !== 401 && status !== 403 && status !== 404 && status !== 413 && status !== 507; },
        onProgress: bytes => this.progress(task.id, { bytes }),
        onAfterResponse: () => { if (upload.url && record.uploadUrl !== upload.url) { record.uploadUrl = upload.url; void this.persist(record); } },
        onSuccess: () => resolve(),
        onError: error => { const status = 'originalResponse' in error ? error.originalResponse?.getStatus() || 0 : 0; reject(new ApiError(status, status === 401 ? '登录已过期，请重新登录。' : '上传连接中断或被服务器拒绝，可重试继续已收偏移。')); },
      });
      running.upload = upload;
      running.controller.signal.addEventListener('abort', () => { void upload.abort().then(() => reject(new Error('已暂停'))); }, { once: true });
      upload.start();
    });
  }
  private replaceTask(task: Task) { this.publish({ tasks: this.snapshot.tasks.map(existing => existing.id === task.id ? task : existing) }); }
  private async abort(id: string) {
    const running = this.running.get(id);
    if (!running) return;
    running.controller.abort(); running.worker?.terminate();
    await running.upload?.abort(); this.running.delete(id);
  }
  async action(task: Task, action: string) {
    const context = this.getContext();
    if (action === 'pause' || action === 'cancel') { this.blocked.add(task.id); await this.abort(task.id); }
    try {
      if (context !== this.getContext() || !this.enabled) throw new ApiError(0, '连接已变化，请在当前账号下重试。', 'CONTEXT_CHANGED');
      const updated = await post<Task>(`/tasks/${task.id}/${action}`);
      if (context !== this.getContext()) throw new ApiError(0, '连接已变化，此操作结果不属于当前账号。', 'CONTEXT_CHANGED');
      this.replaceTask(updated);
      if (action === 'resume' || action === 'retry') { this.blocked.delete(task.id); this.progress(task.id, { error: undefined }); }
      this.pump();
    } catch (error) { if (context === this.getContext()) this.handleError(error); throw error; }
  }
  /** Sequential commands avoid thousands of parallel requests; state and identity are rechecked per item. */
  async bulkAction(action: BulkAction, batchId = '', options: { signal?: AbortSignal; onProgress?: (result: BulkResult) => void } = {}): Promise<BulkResult> {
    if (this.bulkToken) throw new ApiError(409, '已有批量操作正在执行，请等待完成。', 'BULK_BUSY');
    const token = Symbol('bulk'); this.bulkToken = token;
    const context = this.getContext();
    const ids = this.snapshot.tasks.filter(task => (!batchId || task.batchId === batchId) && task.actions.includes(action)).map(task => task.id);
    const result: BulkResult = { requested: ids.length, completed: 0, failed: 0, skipped: 0, interrupted: false, failures: [] };
    const isCurrent = () => context === this.getContext() && this.enabled && this.bulkToken === token;
    const notify = () => { if (isCurrent()) options.onProgress?.({ ...result, failures: [...result.failures] }); };
    notify();
    try {
      for (const id of ids) {
        if (!isCurrent() || options.signal?.aborted) { result.interrupted = true; break; }
        const task = this.snapshot.tasks.find(task => task.id === id);
        if (!task?.actions.includes(action)) { result.skipped++; notify(); continue; }
        try { await this.action(task, action); result.completed++; }
        catch (error) {
          if (!isCurrent()) { result.interrupted = true; break; }
          result.failed++;
          if (result.failures.length < 5) result.failures.push({ id, message: `${task.relativePath}：${error instanceof Error ? error.message : '操作失败'}` });
        }
        notify();
      }
      return result;
    } finally { if (this.bulkToken === token) this.bulkToken = null; }
  }
  async retryClient(task: Task) { this.blocked.delete(task.id); this.progress(task.id, { error: undefined }); this.pump(); }
}
export const transferQueue = new TransferQueue();
export function isFinished(task: Task) { return FINISHED.has(task.state); }
/** Status totals include both files and directory tasks; directory count is never labelled as empty folders. */
export function summarizeBatches(tasks: Task[]): BatchSummary[] {
  const batches = new Map<string, BatchSummary>();
  for (const task of tasks) {
    const createdAt = typeof task.createdAt === 'number' ? task.createdAt : Date.parse(task.createdAt) || 0;
    let summary = batches.get(task.batchId);
    if (!summary) {
      summary = { id: task.batchId, label: task.relativePath.split('/')[0], createdAt, total: 0, files: 0, directories: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, expired: 0, active: 0 };
      batches.set(task.batchId, summary);
    }
    summary.createdAt = Math.min(summary.createdAt, createdAt);
    summary.total++; summary[task.type === 'directory' ? 'directories' : 'files']++;
    if (task.state === 'COMPLETED') summary.succeeded++;
    else if (task.state === 'FAILED') summary.failed++;
    else if (task.state === 'SKIPPED') summary.skipped++;
    else if (task.state === 'CANCELLED') summary.cancelled++;
    else if (task.state === 'EXPIRED') summary.expired++;
    else summary.active++;
  }
  return [...batches.values()].sort((a, b) => b.createdAt - a.createdAt);
}
/** Closing-page promises must cover every active item, including directory tasks. */
export function backgroundNotice(tasks: Task[]): { safe: boolean; message: string } {
  const active = tasks.filter(task => !isFinished(task));
  if (!active.length) return { safe: false, message: '' };
  if (active.every(task => task.canClosePage)) return { safe: true, message: '这些任务已通过校验并由服务器接管。服务进程与授权保持有效时，关闭页面也可继续转存。' };
  if (active.some(task => task.state === 'AUTH_REQUIRED')) return { safe: false, message: '有任务等待重新登录授权。服务器保留任务与已收字节；授权后才能继续 FTP 转存。' };
  if (active.some(task => task.state === 'RECEIVING' && task.type === 'file')) return { safe: false, message: '请保持页面打开：仍有本机文件未上传或未完成校验。刷新后可重选原文件恢复。' };
  if (active.some(task => task.state === 'PAUSED' || task.state === 'FAILED')) return { safe: false, message: '有任务已暂停或需要重试，暂时不会继续转存。服务器会按保留期限保存任务，未传完的本机文件重开页面后需重新选择。' };
  return { safe: false, message: '服务器正在校验或准备任务。请等待“服务器已接管”确认后，再关闭页面。' };
}
