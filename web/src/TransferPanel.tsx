import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatBytes } from './api';
import { backgroundNotice, isFinished, STATE_LABELS, summarizeBatches, transferQueue, type BulkAction, type BulkResult, type Task } from './transfers';
import { Modal } from './Modal';

export function TransferPanel({ onReselect, onError, onReauthorize }: { onReselect: (directory: boolean) => void; onError: (error: unknown) => void; onReauthorize: () => void }) {
  const snapshot = useSyncExternalStore(transferQueue.subscribe, transferQueue.getSnapshot);
  const [tab, setTab] = useState('active');
  const [details, setDetails] = useState<Task | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Task | null>(null);
  const [busy, setBusy] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [coarse, setCoarse] = useState(() => matchMedia('(pointer:coarse)').matches);
  const [batchId, setBatchId] = useState('');
  const [bulk, setBulk] = useState<BulkAction | ''>('');
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const bulkAbort = useRef<AbortController | null>(null);
  const taskList = useRef<HTMLDivElement>(null);
  useEffect(() => { const media = matchMedia('(pointer:coarse)'); const change = () => setCoarse(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => { bulkAbort.current?.abort(); bulkAbort.current = null; setBatchId(''); setBulk(''); setBulkResult(null); setDetails(null); setConfirmCancel(null); setBusy(''); }, [snapshot.ownerId]);
  useEffect(() => () => bulkAbort.current?.abort(), []);
  useEffect(() => { setScrollTop(0); taskList.current?.scrollTo(0, 0); }, [batchId, tab]);
  const batches = useMemo(() => summarizeBatches(snapshot.tasks), [snapshot.tasks]);
  const scope = useMemo(() => snapshot.tasks.filter(task => !batchId || task.batchId === batchId), [snapshot.tasks, batchId]);
  const active = scope.filter(task => !isFinished(task));
  const shown = scope.filter(task => tab === 'active' ? !isFinished(task) : isFinished(task));
  const selectedBatch = batches.find(batch => batch.id === batchId);
  const totals = useMemo(() => batches.filter(batch => !batchId || batch.id === batchId).reduce((sum, batch) => ({ total: sum.total + batch.total, directories: sum.directories + batch.directories, succeeded: sum.succeeded + batch.succeeded, failed: sum.failed + batch.failed, skipped: sum.skipped + batch.skipped, cancelled: sum.cancelled + batch.cancelled, expired: sum.expired + batch.expired }), { total: 0, directories: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, expired: 0 }), [batches, batchId]);
  const counts = { pause: scope.filter(task => task.actions.includes('pause')).length, resume: scope.filter(task => task.actions.includes('resume')).length, retry: scope.filter(task => task.actions.includes('retry')).length };
  const rowHeight = coarse ? 196 : 146;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight) - 2, shown.length - 1));
  const visible = shown.length > 20 ? shown.slice(start, start + 10) : shown;
  const background = backgroundNotice(snapshot.tasks);
  const action = async (task: Task, value: string) => { const context = transferQueue.getContext(); setBusy(task.id); try { await transferQueue.action(task, value); } catch (error) { if (context === transferQueue.getContext()) onError(error); } finally { if (context === transferQueue.getContext()) setBusy(''); } };
  async function runBulk(value: BulkAction) {
    const context = transferQueue.getContext(), controller = new AbortController();
    bulkAbort.current = controller; setBulk(value); setBulkResult(null);
    try {
      const result = await transferQueue.bulkAction(value, batchId, { signal: controller.signal, onProgress: setBulkResult });
      if (context === transferQueue.getContext()) setBulkResult(result);
    } catch (error) { if (context === transferQueue.getContext()) onError(error); }
    finally { if (bulkAbort.current === controller) { bulkAbort.current = null; setBulk(''); if (context !== transferQueue.getContext()) setBulkResult(null); } }
  }
  const current = details && (snapshot.tasks.find(task => task.id === details.id) || details);
  return <section className="transfers" aria-label="传输中心"><div className="section-heading"><div><span className="eyebrow">TRANSFER STATION</span><h2>传输中心 <small>{active.length}</small></h2></div><button className="icon-button" aria-label="刷新任务" onClick={() => void transferQueue.refresh()}>↻</button></div>
    <div className="transfer-tabs"><button aria-pressed={tab === 'active'} onClick={() => setTab('active')}>进行中 {active.length}</button><button aria-pressed={tab === 'done'} onClick={() => setTab('done')}>历史记录 {scope.length - active.length}</button><span className="spacer"/><button onClick={() => onReselect(false)}>重选文件</button><button onClick={() => onReselect(true)}>重选文件夹</button></div>
    {batches.length > 0 && <details className="batch-summary"><summary><span>{selectedBatch ? `当前批次：${selectedBatch.label}` : `上传批次 · ${batches.length} 批`}</span><small>成功 {totals.succeeded} · 失败 {totals.failed} · 跳过 {totals.skipped}</small></summary><label>查看范围<select aria-label="选择上传批次" value={batchId} disabled={!!bulk} onChange={event => { setBatchId(event.target.value); setBulkResult(null); }}><option value="">全部批次</option>{batches.map(batch => <option key={batch.id} value={batch.id}>{batch.createdAt ? new Date(batch.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''} · {batch.label} · {batch.total} 项</option>)}</select></label><dl className="batch-totals"><div><dt>全部项目</dt><dd>{totals.total}</dd></div><div><dt>成功</dt><dd>{totals.succeeded}</dd></div><div><dt>失败</dt><dd>{totals.failed}</dd></div><div><dt>跳过</dt><dd>{totals.skipped}</dd></div><div><dt>目录</dt><dd>{totals.directories}</dd></div></dl><p>状态数量包含文件和目录；目录数包含所有目录层级。{totals.cancelled > 0 && ` 已取消 ${totals.cancelled} 项。`}{totals.expired > 0 && ` 已到期 ${totals.expired} 项。`}</p></details>}
    {scope.length > 0 && <div className="bulk-toolbar" aria-label="批量传输操作">{(['pause', 'resume', 'retry'] as const).map(value => <button key={value} disabled={!!bulk || !!busy || !counts[value]} onClick={() => void runBulk(value)}>{value === 'pause' ? batchId ? '暂停本批' : '全部暂停' : value === 'resume' ? batchId ? '继续本批' : '全部继续' : '失败重试'} <small>{counts[value]}</small></button>)}{bulk && <button onClick={() => bulkAbort.current?.abort()}>停止批量操作</button>}</div>}
    {bulkResult && <div className={`bulk-feedback ${bulkResult.failed ? 'has-failures' : ''}`} role="status"><p>{bulk ? `正在${({ pause: '暂停', resume: '继续', retry: '重试' })[bulk]}：${bulkResult.completed + bulkResult.failed + bulkResult.skipped} / ${bulkResult.requested}。` : bulkResult.interrupted ? '批量操作已停止。' : '批量操作完成。'}已处理 {bulkResult.completed} 项，失败 {bulkResult.failed} 项，状态变化跳过 {bulkResult.skipped} 项。{bulkResult.interrupted && ` 另有 ${bulkResult.requested - bulkResult.completed - bulkResult.failed - bulkResult.skipped} 项未执行。`}</p>{bulkResult.failures.length > 0 && <details><summary>查看失败原因{bulkResult.failed > 5 ? '（前 5 项）' : ''}</summary><ul>{bulkResult.failures.map(failure => <li key={failure.id}>{failure.message}</li>)}</ul></details>}</div>}
    {snapshot.error && <p className="inline-error" role="alert">{snapshot.error}</p>}{snapshot.storageWarning && <p className="notice">{snapshot.storageWarning}</p>}
    {background.message && <p className={`background-note ${background.safe ? 'safe' : ''}`}>{background.message}</p>}
    <div ref={taskList} className="task-list" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>{shown.length === 0 ? <div className="empty-transfers"><span>☁</span><p>{tab === 'active' ? '传输队列很安静，准备好接收你的收藏。' : '完成的传输会在这里留下记录。'}</p></div> : <div style={shown.length > 20 ? { height: shown.length * rowHeight, position: 'relative' } : undefined}>{visible.map((task, index) => {
      const local = snapshot.progress[task.id];
      const uploadBytes = Math.min(task.size, Math.max(task.uploadedBytes, local?.busy ? local.bytes : 0));
      const uploadPercent = task.size ? uploadBytes / task.size * 100 : task.uploadId ? 100 : 0;
      const serverPercent = task.size ? task.transferredBytes / task.size * 100 : task.state === 'COMPLETED' ? 100 : 0;
      return <article className="task" key={task.id} style={shown.length > 20 ? { position: 'absolute', top: (start + index) * rowHeight, height: rowHeight, width: '100%' } : undefined}><span className={`task-symbol ${task.state === 'COMPLETED' ? 'done' : ''}`}>{task.state === 'COMPLETED' ? '✓' : task.type === 'directory' ? '▰' : '↑'}</span><div className="task-main"><div className="task-title"><button title={task.relativePath} onClick={() => setDetails(task)}>{task.relativePath}</button><span>{local?.needsFile && task.state === 'RECEIVING' ? '需要重选原文件' : STATE_LABELS[task.state] || task.state}</span></div>
        <div className="phase-bars"><div title="浏览器上传进度" role="progressbar" aria-label={`${task.relativePath} 上传至服务器`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(uploadPercent)}><i style={{ width: `${uploadPercent}%` }}/></div><div title="FTP 转存进度" role="progressbar" aria-label={`${task.relativePath} 转存至 FTP`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, serverPercent))}><i style={{ width: `${Math.min(100, serverPercent)}%` }}/></div></div>
        <p className="task-meta">{formatBytes(task.size)}<span>上传 {formatBytes(uploadBytes)} · 转存 {formatBytes(task.transferredBytes)}</span></p>
        {(task.error?.message || local?.error) && <p className="task-error">{local?.error || task.error?.message}</p>}
        {task.state === 'RECEIVING' && local?.busy && local.hashBytes < task.size && <small className="muted">同步校验文件 {Math.round(local.hashBytes / task.size * 100)}%</small>}
        {task.canClosePage && !isFinished(task) && <small className="server-label">服务器已接管</small>}
      </div><div className="task-actions">{task.state === 'AUTH_REQUIRED' && <button onClick={onReauthorize}>重新授权</button>}{task.actions.filter(value => ['pause', 'resume', 'retry', 'cancel'].includes(value)).map(value => <button key={value} disabled={!!bulk || busy === task.id} onClick={() => value === 'cancel' ? setConfirmCancel(task) : void action(task, value)}>{({ pause: '暂停', resume: '继续', retry: '重试', cancel: '取消' })[value]}</button>)}{local?.error && task.state === 'RECEIVING' && <button disabled={!!bulk} onClick={() => void transferQueue.retryClient(task)}>重试上传</button>}</div></article>;
    })}</div>}</div>
    {current && <Modal title="传输详情" close={() => setDetails(null)}><dl className="task-details"><dt>文件</dt><dd>{current.relativePath}</dd><dt>目标位置</dt><dd>{current.destinationPath}</dd><dt>当前状态</dt><dd>{STATE_LABELS[current.state]}</dd><dt>服务器已接收</dt><dd>{formatBytes(current.uploadedBytes)} / {formatBytes(current.size)}</dd><dt>FTP 已传输</dt><dd>{formatBytes(current.transferredBytes)} / {formatBytes(current.size)}</dd><dt>完整性校验</dt><dd>{current.type === 'directory' ? '目录无需文件摘要' : current.verified ? '服务器 SHA-256 校验通过' : '尚未通过'}</dd><dt>暂存到期</dt><dd>{current.expiresAt ? new Date(current.expiresAt).toLocaleString('zh-CN') : '由服务器保留策略管理'}</dd>{current.error && <><dt>错误原因</dt><dd>{current.error.message}</dd></>}</dl>{!isFinished(current) && <p className="notice">{backgroundNotice([current]).message}</p>}</Modal>}
    {confirmCancel && <Modal title="取消传输" close={() => setConfirmCancel(null)}><p>取消“{confirmCancel.relativePath}”的未完成传输？服务器暂存会清理，已成功的其他文件不会删除。</p><div className="modal-actions"><button onClick={() => setConfirmCancel(null)}>继续传输</button><button className="danger" onClick={() => { void action(confirmCancel, 'cancel'); setConfirmCancel(null); }}>确认取消</button></div></Modal>}
  </section>;
}
