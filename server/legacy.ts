import express, { type Express, type Request } from 'express';
import multer from 'multer';
import NodeRSA from 'node-rsa';
import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { type FtpService } from './ftp.ts';
import { type Transfers } from './transfers.ts';
import { type Credentials, ApiError } from './types.ts';
import { absolutePath, relativePath } from './paths.ts';
import { route } from './app.ts';

interface Services { root: string; directory: string; keyDirectory: string; ftp: FtpService; transfers: Transfers; login: (request: Request, credentials: Credentials) => Promise<void>; logout: (request: Request) => Promise<void> }
/** Preserve the old Android/Web JSON envelope while sharing isolated FTP operations. */
export function installLegacy(app: Express, services: Services) {
  const { ftp, login, logout, root } = services;
  const prefix = '/ftp/api/';
  const temp = path.join(services.directory, 'legacy'); mkdirSync(temp, { recursive: true, mode: 0o700 });
  // Legacy requests cannot resume. Remove only Multer-owned orphan names before serving traffic.
  for (const name of readdirSync(temp)) if (/^[a-f\d]{32}$/u.test(name)) unlinkSync(path.join(temp, name));
  const upload = multer({ dest: temp, limits: { fileSize: 100 * 1048576, files: 1, fields: 8 } });
  const resolve = (request: Request, value: unknown) => typeof value === 'string' && value.startsWith('/') ? absolutePath(value) : absolutePath(path.posix.join(request.session.user!.cwd, relativePath(value)));
  const success = (result?: unknown) => result === undefined ? { message: 'success' } : { message: 'success', result };
  app.use('/ftp/img', express.static(path.join(root, 'img'))); app.use('/ftp/js', express.static(path.join(root, 'js')));
  app.get('/ftp/login.html', (_request, response) => response.sendFile(path.join(root, 'login.html')));
  // The retired page interpolated FTP filenames into inline onclick handlers.
  app.get('/ftp/index.html', (_request, response) => response.redirect('/ftp/app/'));
  app.get(prefix + 'pub_rsa', (_request, response) => response.type('text/plain').sendFile(path.join(services.keyDirectory, 'pub_key.rsa')));
  app.post(prefix + 'login', route(async (request, response) => {
    if (typeof request.body?.user !== 'string' || typeof request.body?.password !== 'string' || request.body.user.length > 4096 || request.body.password.length > 4096) throw new ApiError(400, 'INVALID_CREDENTIALS', '登录信息格式无效');
    if (!existsSync(path.join(services.keyDirectory, 'pri_key.rsa'))) throw new ApiError(503, 'RSA_UNAVAILABLE', '旧版登录密钥未配置');
    let credentials: Credentials;
    try {
      const key = new NodeRSA(readFileSync(path.join(services.keyDirectory, 'pri_key.rsa'))); key.setOptions({ encryptionScheme: 'pkcs1', environment: 'browser' });
      credentials = { username: key.decrypt(request.body.user, 'utf8'), password: key.decrypt(request.body.password, 'utf8') };
    } catch { throw new ApiError(400, 'INVALID_CREDENTIALS', '登录信息无法解密'); }
    await login(request, credentials!); response.json(success());
  }));
  app.use(prefix, (request, response, next) => request.session.user ? next() : response.json({ message: 'Need login' }));
  app.get(prefix + 'get_dir', route(async (request, response) => {
    const items = await ftp.list(request.session.user!.id, request.session.user!.cwd);
    response.json(success(items.map(item => ({ name: item.name, type: item.type === 'directory' ? 'd' : item.type === 'link' ? 'l' : '-', size: item.size, date: item.modifiedAt }))));
  }));
  app.get(prefix + 'pwd', (request, response) => response.json(success(request.session.user!.cwd)));
  app.post(prefix + 'change_dir', route(async (request, response) => {
    const value = request.body.path;
    const target = value === '..' ? path.posix.dirname(request.session.user!.cwd) : resolve(request, value);
    await ftp.list(request.session.user!.id, target); request.session.user!.cwd = target; response.json(success(target));
  }));
  app.get(prefix + 'download/:path', route(async (request, response) => {
    const target = resolve(request, request.params.path); const abort = new AbortController();
    response.once('close', () => { if (!response.writableFinished) abort.abort(); });
    response.attachment(path.posix.basename(target)); await ftp.download(request.session.user!.id, target, response, { signal: abort.signal, onMetadata: size => { response.set('Content-Length', String(size)); response.type('application/octet-stream'); response.set('X-Content-Type-Options', 'nosniff'); } });
  }));
  app.post(prefix + 'upload', route(async (request, response) => {
    const declared = Number(request.get('content-length'));
    const size = Number.isSafeInteger(declared) && declared >= 0 ? Math.min(declared, 100 * 1048576) : 100 * 1048576;
    const reservation = await services.transfers.reserveLegacy(request.session.user!.id, size);
    let cleaned = false;
    try {
      await new Promise<void>((resolve, reject) => upload.single('file')(request, response, error => error ? reject(error) : resolve()));
      if (!request.file) throw new ApiError(400, 'FILE_REQUIRED', '请选择文件');
      const directory = resolve(request, request.body.path || request.session.user!.cwd);
      const filename = relativePath(request.body.name || request.file.originalname);
      if (filename.includes('/')) throw new ApiError(400, 'INVALID_NAME', '文件名不能包含目录');
      const target = path.posix.join(directory, filename);
      await services.transfers.checkQuota(request.session.user!.id, 0);
      await ftp.use(request.session.user!.id, async client => { await ftp.guard(client, target); await client.uploadFrom(request.file!.path, ftp.remote(target)); });
    } finally {
      try { if (request.file) await unlink(request.file.path); cleaned = true; }
      finally { if (cleaned) services.transfers.legacyReservations.delete(reservation); }
    }
    response.json(success());
  }));
  app.post(prefix + 'mkdir', route(async (request, response) => { await ftp.mkdir(request.session.user!.id, resolve(request, request.body.path)); response.json(success()); }));
  app.post(prefix + 'rename', route(async (request, response) => { await ftp.rename(request.session.user!.id, resolve(request, request.body.old_path), resolve(request, request.body.new_path)); response.json(success()); }));
  for (const [endpoint, directory] of [['rmdir', true], ['delete_file', false]] as const) app.post(prefix + endpoint, route(async (request, response) => { await ftp.remove(request.session.user!.id, resolve(request, request.body.path), directory); response.json(success()); }));
  app.get(prefix + 'logout', route(async (request, response) => { await logout(request); response.json(success()); }));
}
