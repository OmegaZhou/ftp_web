import path from 'node:path';
import { ApiError } from './types.ts';

function validateSegments(value: unknown, absolute: boolean): string[] {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/u.test(value)) throw new ApiError(400, 'INVALID_PATH', '路径格式无效');
  if (absolute !== value.startsWith('/') || value.startsWith('//') || /^[a-z]:/iu.test(value)) throw new ApiError(400, 'INVALID_PATH', '路径格式无效');
  const segments = value.split('/').filter(Boolean);
  if (segments.length > 32 || segments.some(part => part === '.' || part === '..' || part.length > 255)) throw new ApiError(400, 'INVALID_PATH', '路径层级或名称无效');
  // Literal percent names stay literal: Express/JSON already decoded the transport boundary.
  return segments;
}
export function absolutePath(value: unknown): string { return '/' + validateSegments(value, true).join('/'); }
export function relativePath(value: unknown): string {
  const result = validateSegments(value, false).join('/');
  if (!result) throw new ApiError(400, 'INVALID_PATH', '相对路径不能为空');
  return result;
}
export function destinationPath(root: string, relative: string): string { return path.posix.join(absolutePath(root), relativePath(relative)); }
export function siblingName(value: string, suffix: number): string {
  const extension = path.posix.extname(value);
  return value.slice(0, value.length - extension.length) + ` (${suffix})` + extension;
}
