import { useRef, useState } from 'react';
import { ApiError, formatBytes, post } from './api';
import type { Selection } from './files';
import { Modal } from './Modal';
import { transferQueue, type Task } from './transfers';

interface Batch { id: string; conflicts: unknown[]; entries: { conflict: boolean }[] }
export function UploadDialog({ selection, destination, close, onError, onComplete }: { selection: Selection; destination: string; close: () => void; onError: (error: unknown) => void; onComplete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [policy, setPolicy] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [needsPreflight, setNeedsPreflight] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const files = selection.entries.filter(entry => entry.type === 'file');
  const directories = selection.entries.length - files.length;
  async function commit(id: string, conflictPolicy: string) {
    const result = await post<{ tasks: Task[] }>(`/batches/${id}/commit`, { conflictPolicy, confirmReplace: conflictPolicy === 'replace' && confirmed });
    await transferQueue.add(result.tasks, selection);
    onComplete(); close();
  }
  async function prepare() {
    setBusy(true); setError('');
    try {
      if (batch && !needsPreflight) { await commit(batch.id, policy); return; }
      if (needsPreflight) {
        idempotencyKey.current = crypto.randomUUID(); setBatch(null); setPolicy(''); setConfirmed(false); setNeedsPreflight(false);
      }
      const created = await post<Batch>('/batches', { destination, entries: selection.entries.slice(0, 500), idempotencyKey: idempotencyKey.current });
      let count = created.conflicts?.length || created.entries.filter(entry => entry.conflict).length;
      for (let offset = created.entries.length; offset < selection.entries.length; offset += 500) {
        const page = await post<Batch>(`/batches/${created.id}/entries`, { entries: selection.entries.slice(offset, offset + 500) });
        count = page.conflicts?.length || page.entries.filter(entry => entry.conflict).length;
      }
      if (count) { setBatch(created); setConflicts(count); }
      else await commit(created.id, 'skip');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DESTINATION_CHANGED') {
        setNeedsPreflight(true); setConfirmed(false); setError('服务器上的同名项目已变化。请重新预检，并再次确认处理方式。');
      } else setError(error instanceof Error ? error.message : '无法创建上传任务。');
      onError(error);
    }
    finally { setBusy(false); }
  }
  return <Modal title={batch ? '发现同名项目' : '准备上传'} close={() => { if (!busy) close(); }}><p className="upload-destination">收藏到 <strong>{destination}</strong></p><div className="selection-summary"><span><strong>{files.length}</strong> 个文件</span><span><strong>{directories}</strong> 个目录</span><span><strong>{formatBytes(files.reduce((total, file) => total + (file.size || 0), 0))}</strong></span></div>
    {!selection.preservesEmptyDirectories && <p className="notice">此浏览器的文件夹选择入口只提供文件，无法发现空目录。需要保留空目录时，请使用支持目录枚举的浏览器或拖入文件夹。</p>}
    <ul className="operation-files">{selection.entries.slice(0, 6).map(entry => <li key={entry.relativePath}>{entry.type === 'directory' ? '▰' : '▱'} {entry.relativePath}</li>)}{selection.entries.length > 6 && <li>以及其他 {selection.entries.length - 6} 项…</li>}</ul>
    {batch && <fieldset className="conflict-options"><legend>有 {conflicts} 个同名项目，如何处理这批文件？</legend>{[['skip','跳过同名文件','保留服务器上的文件。'],['keep-both','保留两份','新文件使用不重名的名称。'],['replace','替换已有文件','已有文件会被新内容覆盖。']].map(([value, label, hint]) => <label key={value}><input type="radio" name="conflict" value={value} checked={policy === value} onChange={() => setPolicy(value)}/><span><strong>{label}</strong><small>{hint}</small></span></label>)}{policy === 'replace' && <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>我确认替换这批同名文件</label>}</fieldset>}
    {error && <p className="inline-error" role="alert">{error}</p>}<p className="muted small">可以随时暂停。上传结束后还需校验并转存至 FTP，全部完成才会标为成功。</p><div className="modal-actions"><button onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy || !selection.entries.length || (!!batch && !needsPreflight && (!policy || policy === 'replace' && !confirmed))} onClick={() => void prepare()}>{busy ? '正在准备…' : needsPreflight ? '重新预检' : batch ? '按此方式上传' : '开始上传'}</button></div></Modal>;
}
