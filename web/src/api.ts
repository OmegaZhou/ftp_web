export const API = '/ftp/api/v2';
let csrfToken = '';
export class ApiError extends Error {
  constructor(public status: number, message: string, public code = '', public detail?: unknown) { super(message); }
}
export interface Session {
  authenticated: boolean;
  ftpAuthorized?: boolean;
  user?: { id: string; username: string };
  csrfToken: string;
  config: { chunkSize: number; chunkSizeStatus: string; maxChunkSize: number; maxFileSize: number; maxBatchEntries: number };
}
export interface RemoteFile { name: string; path: string; type: 'file' | 'directory' | 'link'; size: number; modifiedAt: string }
export interface Directory { path: string; items: RemoteFile[]; nextCursor: string | null; snapshot: string }

/** All mutations share the current session token. Passwords never enter persistent storage. */
export function setSessionToken(session: Session) { csrfToken = session.csrfToken || ''; }
export function getSessionToken() { return csrfToken; }

/** Bound control requests; a transient FTP/HTTP failure must not clear the user's session. */
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers = new Headers(options.headers);
    if (options.body) headers.set('Content-Type', 'application/json');
    if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfToken);
    const response = await fetch(`${API}${path}`, { ...options, credentials: 'same-origin', headers, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body?.error;
      throw new ApiError(response.status, error?.message || body?.message || `请求失败（${response.status}）`, error?.code || body?.code, body);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(0, '请求超时或已中止，请重试。');
    throw new ApiError(0, '连接暂时中断，请检查网络后重试。');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
export function post<T>(path: string, body: unknown = {}) { return request<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}
