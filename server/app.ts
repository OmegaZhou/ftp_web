import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, SqliteSessions } from './store.ts';
import { FtpService, type FtpConfig } from './ftp.ts';
import { Transfers, type TransferConfig } from './transfers.ts';
import { absolutePath } from './paths.ts';
import { ApiError, type Credentials } from './types.ts';
import { installLegacy } from './legacy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = '/ftp/api/v2';
const MiB = 1048576;
export interface AppOptions { directory?: string; secret?: string; ftp?: Partial<FtpConfig>; transfer?: Partial<TransferConfig>; production?: boolean; origin?: string; legacyKeyDirectory?: string }
type AsyncRoute = (request: Request, response: Response) => Promise<unknown>;
export const route = (handler: AsyncRoute) => (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };

function numberSetting(name: string, fallback: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function sessionSecret(directory: string, supplied: string | undefined, production: boolean) {
  if (supplied) return supplied;
  if (production) throw new Error('SESSION_SECRET is required in production');
  const location = path.join(directory, 'session-secret');
  if (!existsSync(location)) writeFileSync(location, randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' });
  return readFileSync(location, 'utf8');
}
export function requireUser(request: Request, _response: Response, next: NextFunction) {
  if (!request.session.user) return next(new ApiError(401, 'AUTH_REQUIRED', '请先登录'));
  next();
}
function validateOrigin(request: Request, origin?: string) {
  const supplied = request.get('origin');
  const expected = origin ?? `${request.protocol}://${request.get('host')}`;
  if ((supplied && supplied !== expected) || request.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'ORIGIN_DENIED', '请求来源不受信任');
}
function csrf(request: Request, _response: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const actual = Buffer.from(request.get('x-csrf-token') ?? '');
  const expected = Buffer.from(request.session.csrfToken ?? '');
  if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return next(new ApiError(403, 'CSRF_INVALID', '安全令牌已过期，请刷新登录状态'));
  next();
}

/** Build an isolated app for production or protocol integration tests; never starts a listener itself. */
export async function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const directory = path.resolve(options.directory ?? process.env.FTP_WEB_DATA_DIR ?? path.join(ROOT, '.data'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secret = sessionSecret(directory, options.secret ?? process.env.SESSION_SECRET, production);
  if (production && options.transfer?.chunkSize === undefined && process.env.UPLOAD_CHUNK_SIZE === undefined) throw new Error('UPLOAD_CHUNK_SIZE must be explicitly configured in production after benchmark approval');
  const ftp = new FtpService({ host: process.env.FTP_HOST ?? '127.0.0.1', port: numberSetting('FTP_PORT', 21), secure: process.env.FTP_TLS === 'true', root: process.env.FTP_ROOT ?? '/', timeout: 30000, ...options.ftp });
  const config: TransferConfig = { directory, chunkSize: numberSetting('UPLOAD_CHUNK_SIZE', 8 * MiB), maxChunkSize: 64 * MiB, maxFileSize: numberSetting('UPLOAD_MAX_FILE_BYTES', 8 * 1024 * MiB), userQuota: numberSetting('UPLOAD_USER_QUOTA_BYTES', 12 * 1024 * MiB), globalQuota: numberSetting('UPLOAD_GLOBAL_QUOTA_BYTES', 20 * 1024 * MiB), reserveBytes: numberSetting('UPLOAD_RESERVE_BYTES', 5 * 1024 * MiB), reserveRatio: numberSetting('UPLOAD_RESERVE_RATIO', .2), maxBatchEntries: 10000, ...options.transfer };
  if (!Number.isInteger(config.chunkSize) || config.chunkSize < MiB || config.chunkSize > config.maxChunkSize) throw new Error('UPLOAD_CHUNK_SIZE must be 1–64 MiB; selection is benchmark-pending');
  const store = new Store(directory);
  let initializedTransfers: Transfers | undefined;
  try {
    const transfers = new Transfers(store, ftp, config);
    initializedTransfers = transfers;
    await transfers.recover();
    const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
    app.use(session({ name: 'connect.sid', secret, store: new SqliteSessions(store), rolling: true, saveUninitialized: false, resave: false, cookie: { maxAge: 1800000, httpOnly: true, sameSite: 'lax', secure: production ? 'auto' : false } }));
    app.use('/ftp/api', (request, response, next) => {
      response.set('Cache-Control', 'no-store');
      try { validateOrigin(request, options.origin ?? process.env.PUBLIC_ORIGIN); next(); } catch (error) { next(error); }
    });
    app.use(express.json({ limit: '2mb' })); app.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const publicConfig = { chunkSize: config.chunkSize, chunkSizeStatus: 'benchmark-pending', maxChunkSize: config.maxChunkSize, maxFileSize: config.maxFileSize, maxBatchEntries: config.maxBatchEntries, manifestPageSize: 500, ftpResumeSupported: false, downloadRangeSupported: false };
    const sessionView = (request: Request) => ({ authenticated: Boolean(request.session.user), user: request.session.user ? { id: request.session.user.id, username: request.session.user.username } : null, csrfToken: request.session.csrfToken ?? null, ftpAuthorized: Boolean(request.session.user && ftp.credentials.has(request.session.user.id)), config: publicConfig });
    const failures = new Map<string, { count: number; until: number }>();
    const login = async (request: Request, credentials: Credentials) => {
      if (typeof credentials?.username !== 'string' || typeof credentials?.password !== 'string' || !credentials.username || credentials.username.length > 256 || credentials.password.length > 4096 || /[\r\n\0]/u.test(credentials.username + credentials.password)) throw new ApiError(400, 'INVALID_CREDENTIALS', '账号或密码格式无效');
      const key = request.ip ?? 'unknown'; const failure = failures.get(key);
      if (failure && failure.until > Date.now() && failure.count >= 3) throw new ApiError(429, 'LOGIN_LIMIT', '登录失败次数过多，请一小时后重试');
      let owner: string;
      try { owner = await ftp.authenticate(credentials); }
      catch (error) {
        if ((error as { code?: number }).code === 530) { failures.set(key, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 3600000 }); throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码不正确'); }
        throw new ApiError(502, 'FTP_UNAVAILABLE', '无法连接 FTP 服务，请稍后重试');
      }
      failures.delete(key);
      if (request.session.user && request.session.user.id !== owner) transfers.revoke(request.session.user.id);
      await new Promise<void>((resolve, reject) => request.session.regenerate(error => error ? reject(error) : resolve()));
      request.session.user = { id: owner, username: credentials.username, cwd: '/' }; request.session.csrfToken = randomBytes(32).toString('hex');
      await new Promise<void>((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));
      transfers.reauthorize(owner);
    };
    const logout = async (request: Request) => {
      if (request.session.user) transfers.revoke(request.session.user.id);
      await new Promise<void>((resolve, reject) => request.session.destroy(error => error ? reject(error) : resolve()));
    };
    app.get(`${API}/session`, (request, response) => response.json(sessionView(request)));
    app.post(`${API}/login`, route(async (request, response) => { await login(request, request.body); response.json(sessionView(request)); }));
    app.use(API, requireUser, csrf);
    app.post(`${API}/logout`, route(async (request, response) => { await logout(request); response.json({ ok: true }); }));
    app.get(`${API}/list`, route(async (request, response) => {
      const directory = absolutePath(request.query.path ?? '/');
      const query = String(request.query.query ?? '').toLocaleLowerCase();
      const sort = String(request.query.sort ?? 'name'); const direction = request.query.direction === 'desc' ? -1 : 1;
      const items = (await ftp.list(request.session.user!.id, directory)).filter(item => item.name.toLocaleLowerCase().includes(query));
      items.sort((a, b) => (a.type === 'directory' ? -1 : 0) - (b.type === 'directory' ? -1 : 0) || direction * (sort === 'size' ? a.size - b.size : sort === 'modifiedAt' ? String(a.modifiedAt).localeCompare(String(b.modifiedAt)) : a.name.localeCompare(b.name)) || a.name.localeCompare(b.name));
      const snapshot = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
      const cursor = String(request.query.cursor ?? '');
      const [revision, position] = cursor.split(':'); const offset = cursor ? Number(position) : 0;
      if (cursor && (revision !== snapshot || !Number.isSafeInteger(offset) || offset < 0)) throw new ApiError(409, 'STALE_CURSOR', '目录已变化，请刷新列表');
      const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 200));
      response.json({ path: directory, items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? `${snapshot}:${offset + limit}` : null, snapshot, total: items.length });
    }));
    app.post(`${API}/mkdir`, route(async (request, response) => { await ftp.mkdir(request.session.user!.id, absolutePath(request.body.path)); response.json({ ok: true }); }));
    app.post(`${API}/rename`, route(async (request, response) => { await ftp.rename(request.session.user!.id, absolutePath(request.body.path), absolutePath(request.body.newPath)); response.json({ ok: true }); }));
    app.post(`${API}/delete`, route(async (request, response) => { if (request.body.confirm !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', '删除需要明确确认'); await ftp.remove(request.session.user!.id, absolutePath(request.body.path), request.body.type === 'directory'); response.json({ ok: true }); }));
    app.get(`${API}/download`, route(async (request, response) => {
      const target = absolutePath(request.query.path); const abort = new AbortController();
      response.once('close', () => { if (!response.writableFinished) abort.abort(); });
      response.attachment(path.posix.basename(target));
      await ftp.download(request.session.user!.id, target, response, { signal: abort.signal, onMetadata: size => { response.set('Content-Length', String(size)); response.type('application/octet-stream'); response.set('X-Content-Type-Options', 'nosniff'); } });
    }));
    const batchView = (batch: any) => { const { owner: _owner, ...view } = batch; return { ...view, conflicts: batch.entries.filter((entry: any) => entry.conflict) }; };
    app.post(`${API}/batches`, route(async (request, response) => response.status(201).json(batchView(await transfers.createBatch(request.session.user!.id, request.body)))));
    app.post(`${API}/batches/:id/entries`, route(async (request, response) => response.json(batchView(await transfers.appendBatch(request.params.id, request.session.user!.id, request.body.entries)))));
    app.post(`${API}/batches/:id/commit`, route(async (request, response) => { const result = await transfers.commitBatch(request.params.id, request.session.user!.id, request.body); response.json({ ...result, batch: batchView(result.batch) }); }));
    app.get(`${API}/tasks`, (request, response) => { const tasks = store.tasks(request.session.user!.id).sort((a, b) => b.createdAt - a.createdAt); const offset = Math.max(0, Math.floor(Number(request.query.cursor) || 0)); const limit = Math.min(500, Math.max(1, Math.floor(Number(request.query.limit) || 200))); response.json({ tasks: tasks.slice(offset, offset + limit).map(task => transfers.publicTask(task)), nextCursor: offset + limit < tasks.length ? String(offset + limit) : null }); });
    app.post(`${API}/tasks/reauthorize`, (request, response, next) => { if (!ftp.credentials.has(request.session.user!.id)) return next(new ApiError(401, 'AUTH_REQUIRED', '请重新登录')); transfers.reauthorize(request.session.user!.id); response.json({ ok: true }); });
    app.get(`${API}/tasks/:id`, route(async (request, response) => response.json(transfers.publicTask(store.getTask(request.params.id, request.session.user!.id)))));
    app.post(`${API}/tasks/:id/:action`, route(async (request, response) => response.json(await transfers.action(request.params.id, request.session.user!.id, request.params.action))));
    app.post(`${API}/uploads/:id/complete`, route(async (request, response) => { const task = await transfers.complete(request.params.id, request.session.user!.id, request.body.sha256); response.status(202).json({ task: transfers.publicTask(task), statusUrl: `${API}/tasks/${task.id}` }); }));
    app.all([`${API}/uploads`, `${API}/uploads/:id`], route(async (request, response) => {
      if (request.get('x-http-method-override')) throw new ApiError(400, 'METHOD_OVERRIDE_DENIED', '请使用原生 HTTP 方法');
      if (request.method === 'OPTIONS') { await transfers.tus.handle(request, response); return; }
      let task;
      if (request.method === 'POST') {
        const metadata = request.get('upload-metadata') ?? '';
        const fields = metadata.split(',').map(item => item.trim().split(' '));
        if (fields.filter(field => field[0] === 'taskId').length !== 1 || request.params.id) throw new ApiError(400, 'INVALID_METADATA', '必须提供唯一 taskId');
        const encoded = fields.find(field => field[0] === 'taskId')?.[1];
        task = store.getTask(encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '', request.session.user!.id);
        if (task.type !== 'file') throw new ApiError(400, 'INVALID_TASK', '目录不能接收文件正文');
        request.headers['upload-metadata'] = 'taskId ' + Buffer.from(task.id).toString('base64');
        if (request.get('transfer-encoding') || Number(request.get('content-length') ?? 0) !== 0) throw new ApiError(400, 'CREATION_BODY_DENIED', '创建请求不携带文件正文');
      } else task = store.taskByUpload(request.params.id);
      if (!task || task.owner !== request.session.user!.id) throw new ApiError(404, 'NOT_FOUND', '上传不存在');
      if (request.method === 'DELETE') { await transfers.action(task.id, task.owner, 'cancel'); response.set('Tus-Resumable', '1.0.0').status(204).end(); return; }
      const id = task.id;
      await transfers.lock(id, async () => {
        task = store.getTask(id, request.session.user!.id);
        if (request.method === 'POST' || request.method === 'PATCH') {
          if (task.state !== 'RECEIVING') throw new ApiError(409, 'INVALID_STATE', '任务当前不能接收文件');
          if (request.method === 'PATCH') {
            const length = Number(request.get('content-length'));
            if (!Number.isSafeInteger(length) || length < 0 || length > config.maxChunkSize) throw new ApiError(413, 'CHUNK_LIMIT', '每块必须有明确长度且不超过 64 MiB');
            await transfers.checkQuota(task.owner, 0);
          }
        }
        await transfers.tus.handle(request, response);
      });
    }));
    installLegacy(app, { root: ROOT, directory, keyDirectory: options.legacyKeyDirectory ?? process.env.FTP_RSA_DIR ?? ROOT, ftp, transfers, login, logout });
    app.use('/ftp/app', express.static(path.join(ROOT, 'web/dist'), { index: 'index.html', maxAge: 0 }));
    app.get('/ftp/app/*', (_request, response) => response.sendFile(path.join(ROOT, 'web/dist/index.html')));
    app.get(['/ftp', '/ftp/'], (_request, response) => response.redirect('/ftp/app/'));
    app.use(`${API}`, (_request, _response, next) => next(new ApiError(404, 'NOT_FOUND', '接口不存在')));
    app.use((error: any, request: Request, response: Response, _next: NextFunction) => {
      if (response.headersSent) { response.destroy(error); return; }
      const status = error instanceof ApiError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : error.code === 550 ? 404 : 502;
      const code = error instanceof ApiError ? error.code : error.code === 'ENOSPC' ? 'DISK_FULL' : error.code === 550 ? 'FTP_NOT_FOUND' : 'REQUEST_FAILED';
      const message = error instanceof ApiError ? error.message : '请求失败，请检查目标或稍后重试';
      if (request.path.startsWith('/ftp/api/') && !request.path.startsWith(API)) response.status(200).json({ message: status === 401 ? 'Need login' : message });
      else response.status(error.code === 'ENOSPC' ? 507 : status).json({ error: { code, message } });
    });
    return { app, store, ftp, transfers, config: publicConfig, async close() { await transfers.close(); ftp.credentials.clear(); store.close(); } };
  } catch (error) {
    await initializedTransfers?.close(); store.close(); throw error;
  }
}
