import { Client } from 'basic-ftp';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError, type Credentials, type FileItem, type Task } from './types.ts';
import { absolutePath } from './paths.ts';

export interface FtpConfig { host: string; port: number; secure: boolean; root: string; timeout: number }
/** A fresh connection per operation prevents cwd/transfer commands from corrupting browsing. */
export class FtpService {
  config: FtpConfig;
  credentials = new Map<string, Credentials>();
  constructor(config: FtpConfig) { this.config = config; }
  async connect(credentials: Credentials): Promise<Client> {
    const client = new Client(this.config.timeout);
    try {
      await client.access({ host: this.config.host, port: this.config.port, user: credentials.username, password: credentials.password, secure: this.config.secure });
      await client.cd(this.config.root);
      return client;
    } catch (error) { client.close(); throw error; }
  }
  async authenticate(credentials: Credentials): Promise<string> {
    const client = await this.connect(credentials);
    try { await client.pwd(); } finally { client.close(); }
    const owner = createHash('sha256').update(JSON.stringify([this.config.host, this.config.port, this.config.root, credentials.username])).digest('hex');
    this.credentials.set(owner, credentials);
    return owner;
  }
  async use<T>(owner: string, action: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const credentials = this.credentials.get(owner);
    if (!credentials) throw new ApiError(401, 'AUTH_REQUIRED', '请重新登录以授权 FTP 操作');
    const client = await this.connect(credentials);
    const abort = () => client.close();
    signal?.addEventListener('abort', abort, { once: true });
    try { signal?.throwIfAborted(); return await action(client); }
    finally { signal?.removeEventListener('abort', abort); client.close(); }
  }
  remote(value: string): string { return path.posix.join(this.config.root, absolutePath(value)); }
  async guard(client: Client, value: string, createParents = false, directoryOnly = false) {
    const segments = absolutePath(value).split('/').filter(Boolean);
    let parent = '/';
    for (const segment of segments) {
      const entries = await client.list(this.remote(parent));
      const entry = entries.find(item => item.name === segment);
      if (entry?.isSymbolicLink) throw new ApiError(403, 'SYMLINK_DENIED', '不允许通过符号链接访问文件');
      parent = path.posix.join(parent, segment);
      if (entry && !entry.isDirectory && (createParents || directoryOnly || parent !== absolutePath(value))) throw new ApiError(409, 'PATH_BLOCKED', '路径中的目录位置已被普通文件占用');
      if (!entry && createParents) await client.ensureDir(this.remote(parent));
      if (!entry && !createParents) break;
    }
  }
  async list(owner: string, value: string): Promise<FileItem[]> {
    const directory = absolutePath(value);
    return this.use(owner, async client => {
      await this.guard(client, directory, false, true);
      const entries = await client.list(this.remote(directory));
      return entries.map(item => ({ name: item.name, path: path.posix.join(directory, item.name), type: item.isSymbolicLink ? 'link' : item.isDirectory ? 'directory' : 'file', size: item.size, modifiedAt: item.modifiedAt?.toISOString() ?? null }));
    });
  }
  async stat(owner: string, value: string): Promise<FileItem | undefined> {
    if (value === '/') return { name: '/', path: '/', type: 'directory', size: 0, modifiedAt: null };
    const entries = await this.list(owner, path.posix.dirname(value));
    return entries.find(item => item.name === path.posix.basename(value));
  }
  async mkdir(owner: string, value: string) {
    return this.use(owner, async client => { await this.guard(client, value, true); });
  }
  async rename(owner: string, value: string, newValue: string) {
    return this.use(owner, async client => {
      await this.guard(client, value); await this.guard(client, path.posix.dirname(newValue));
      const entries = await client.list(this.remote(path.posix.dirname(newValue)));
      if (entries.some(item => item.name === path.posix.basename(newValue))) throw new ApiError(409, 'DESTINATION_EXISTS', '目标已存在');
      await client.rename(this.remote(value), this.remote(newValue));
    });
  }
  async remove(owner: string, value: string, directory: boolean) {
    if (value === '/') throw new ApiError(400, 'ROOT_PROTECTED', '不能删除根目录');
    return this.use(owner, async client => {
      await this.guard(client, value);
      if (directory) await client.removeDir(this.remote(value)); else await client.remove(this.remote(value));
    });
  }
  async download(owner: string, value: string, output: Writable, options: { signal?: AbortSignal; onMetadata?: (size: number) => void } = {}) {
    return this.use(owner, async client => {
      await this.guard(client, value);
      // basic-ftp ends its destination on RETR failure; fail before attaching HTTP output.
      const size = await client.size(this.remote(value));
      options.onMetadata?.(size);
      await client.downloadTo(output, this.remote(value));
    }, options.signal);
  }
  async removeTemporary(task: Task) {
    const temporary = path.posix.join(path.posix.dirname(task.destinationPath), `.ftp-web-${task.id}.part`);
    return this.use(task.owner, async client => {
      await this.guard(client, path.posix.dirname(temporary));
      const files = await client.list(this.remote(path.posix.dirname(temporary)));
      if (files.some(item => item.name === path.posix.basename(temporary))) await client.remove(this.remote(temporary));
    });
  }
  async digest(owner: string, value: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    await this.download(owner, value, new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } }), { signal });
    return hash.digest('hex');
  }
  async transfer(task: Task, localFile: string, options: { signal: AbortSignal; progress: (bytes: number) => void; committing: () => void }) {
    return this.use(task.owner, async client => {
      const directory = path.posix.dirname(task.destinationPath);
      await this.guard(client, directory, true);
      const temporary = path.posix.join(directory, `.ftp-web-${task.id}.part`);
      client.trackProgress(info => options.progress(info.bytesOverall));
      await client.uploadFrom(localFile, this.remote(temporary));
      client.trackProgress();
      if (await client.size(this.remote(temporary)) !== task.size) throw new ApiError(502, 'FTP_SIZE_MISMATCH', 'FTP 暂存长度不匹配');
      const existing = (await client.list(this.remote(directory))).find(item => item.name === path.posix.basename(task.destinationPath));
      if (existing && (task.conflictPolicy !== 'replace' || existing.isDirectory || existing.isSymbolicLink)) throw new ApiError(409, 'DESTINATION_CHANGED', '目标在上传后发生冲突，请重新选择目标');
      const version = existing ? JSON.stringify([existing.isDirectory ? 'directory' : 'file', existing.size, existing.modifiedAt?.toISOString() ?? null]) : null;
      if (version !== (task.destinationVersion ?? null)) throw new ApiError(409, 'DESTINATION_CHANGED', '目标文件已变化，不能覆盖新的内容');
      options.signal.throwIfAborted();
      options.committing();
      // Never delete the original first. Servers without atomic replacement fail safely here.
      await client.rename(this.remote(temporary), this.remote(task.destinationPath));
    }, options.signal);
  }
}
