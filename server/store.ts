import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import type { Batch, Task } from './types.ts';
import { ApiError } from './types.ts';

/** Durable ownership and state; credentials are deliberately never stored here. */
export class Store {
  db: DatabaseSync;
  token = randomUUID();
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, destination TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_owner ON tasks(owner);
      CREATE UNIQUE INDEX IF NOT EXISTS task_upload ON tasks(json_extract(data,'$.uploadId')) WHERE json_extract(data,'$.uploadId') IS NOT NULL;
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,key));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tus_metadata (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_lock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      PRAGMA user_version=1;`);
    // File and FTP locks are process-local; prevent two workers opening the same data directory.
    try {
      this.transaction(() => {
        const previous = this.db.prepare('SELECT pid FROM runtime_lock WHERE singleton=1').get();
        if (previous) {
          let alive = true;
          try { process.kill(Number(previous.pid), 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          if (alive) throw new Error('FTP Web data directory is already owned by a running process');
        }
        this.db.prepare('INSERT OR REPLACE INTO runtime_lock VALUES(1,?,?)').run(process.pid, this.token);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveTask(task: Task) {
    task.updatedAt = Date.now();
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data,destination=excluded.destination')
      .run(task.id, task.owner, task.state, task.destinationPath, JSON.stringify(task));
  }
  getTask(id: string, owner?: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    const task = JSON.parse(row.data) as Task;
    if (owner && task.owner !== owner) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    return task;
  }
  tasks(owner?: string): Task[] {
    const rows = owner ? this.db.prepare('SELECT data FROM tasks WHERE owner=?').all(owner) : this.db.prepare('SELECT data FROM tasks').all();
    return rows.map(row => JSON.parse(row.data as string));
  }
  taskByUpload(uploadId: string): Task | undefined {
    const row = this.db.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.uploadId')=?").get(uploadId);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveBatch(batch: Batch) {
    this.db.prepare('INSERT INTO batches VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(batch.id, batch.owner, batch.idempotencyKey, JSON.stringify(batch));
  }
  getBatch(id: string, owner: string): Batch {
    const row = this.db.prepare('SELECT data FROM batches WHERE id=? AND owner=?').get(id, owner);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '批次不存在');
    return JSON.parse(row.data as string);
  }
  findBatch(owner: string, key: string): Batch | undefined {
    const row = this.db.prepare('SELECT data FROM batches WHERE owner=? AND key=?').get(owner, key);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  close() { this.db.prepare('DELETE FROM runtime_lock WHERE token=?').run(this.token); this.db.close(); }
}

/** Sessions persist identity/CSRF only; FTP reauthorization is required after restart. */
export class SqliteSessions extends session.Store {
  store: Store;
  constructor(store: Store) { super(); this.store = store; }
  get(id: string, callback: (error?: unknown, session?: session.SessionData | null) => void) {
    try {
      const row = this.store.db.prepare('SELECT data FROM sessions WHERE id=? AND expires>?').get(id, Date.now());
      callback(null, row ? JSON.parse(row.data as string) : null);
    } catch (error) { callback(error); }
  }
  set(id: string, value: session.SessionData, callback?: (error?: unknown) => void) {
    try {
      const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 1800000;
      this.store.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(id, expires, JSON.stringify(value));
      callback?.();
    } catch (error) { callback?.(error); }
  }
  destroy(id: string, callback?: (error?: unknown) => void) {
    try { this.store.db.prepare('DELETE FROM sessions WHERE id=?').run(id); callback?.(); }
    catch (error) { callback?.(error); }
  }
}
