export type TaskState = 'RECEIVING' | 'VERIFYING' | 'QUEUED' | 'TRANSFERRING' | 'COMMITTING' | 'PAUSED' | 'AUTH_REQUIRED' | 'FAILED' | 'COMPLETED' | 'CANCELLED' | 'SKIPPED' | 'EXPIRED';
export interface Task {
  id: string; owner: string; batchId: string; relativePath: string; destinationPath: string;
  type: 'file' | 'directory'; size: number; lastModified: number; state: TaskState;
  uploadId: string | null; uploadUrl: string | null; uploadedBytes: number; transferredBytes: number;
  sha256: string | null; verified: boolean; conflictPolicy: 'skip' | 'keep-both' | 'replace';
  createdAt: number; updatedAt: number; expiresAt: number; attempts: number;
  error: { code: string; message: string } | null; resumeState?: TaskState;
  renameIntent?: boolean; cleanupPending?: boolean; destinationVersion?: string | null;
}
export interface Entry { id: string; relativePath: string; type: 'file' | 'directory'; size: number; lastModified: number; destinationPath: string; conflict: boolean; destinationVersion?: string | null }
export interface Batch { id: string; owner: string; destination: string; entries: Entry[]; state: 'DRAFT' | 'COMMITTED'; idempotencyKey: string; createdAt: number }
export interface Identity { id: string; username: string; cwd: string }
export interface Credentials { username: string; password: string }
export interface FileItem { name: string; path: string; type: 'file' | 'directory' | 'link'; size: number; modifiedAt: string | null }
export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
declare module 'express-session' { interface SessionData { user?: Identity; csrfToken?: string } }
