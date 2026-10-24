import { useEffect, useRef, useState } from 'react';
import { ApiError, formatBytes, post, request, API, type Directory, type RemoteFile } from './api';
import { Modal } from './Modal';

interface Props { onError: (error: unknown) => void; onUpload: (directory: boolean) => void; onPath: (path: string) => void; refreshToken: number; onMessage: (message: string) => void }
const ROW_HEIGHT = 62;
const fileSymbol = (file: RemoteFile) => file.type === 'directory' ? '▰' : /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name) ? '▧' : /\.(zip|rar|7z|tar|gz)$/i.test(file.name) ? '▤' : '▱';
export function FileBrowser({ onError, onUpload, onPath, refreshToken, onMessage }: Props) {
  const [path, setPath] = useState('/');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState('name');
  const [direction, setDirection] = useState('asc');
  const [data, setData] = useState<Directory>({ path: '/', items: [], nextCursor: null, snapshot: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [selected, setSelected] = useState<RemoteFile[]>([]);
  const [operation, setOperation] = useState<{ kind: 'new' | 'rename' | 'delete'; files: RemoteFile[] } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState('');
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setSelected([]); setScroll(0); viewport.current?.scrollTo(0, 0); setLoading(true); loadingRef.current = true; setError('');
    setData({ path, items: [], nextCursor: null, snapshot: '' }); onPath(path);
    request<Directory>(`/list?${new URLSearchParams({ path, query: debounced, sort, direction, limit: '200' })}`, { signal: controller.signal })
      .then(result => { if (current === generation.current) { setData(result); onPath(result.path); } })
      .catch(error => { if (!controller.signal.aborted && current === generation.current) { setError(error.message); onError(error); } })
      .finally(() => { if (current === generation.current) { setLoading(false); loadingRef.current = false; } });
    return () => controller.abort();
  }, [path, debounced, sort, direction, revision, refreshToken]);
  async function more() {
    if (!data.nextCursor || loadingRef.current) return;
    loadingRef.current = true; setLoading(true); const current = generation.current;
    try {
      const page = await request<Directory>(`/list?${new URLSearchParams({ path, query: debounced, sort, direction, limit: '200', cursor: data.nextCursor })}`);
      if (current !== generation.current) return;
      if (page.snapshot !== data.snapshot) { setRevision(value => value + 1); return; }
      setData(previous => ({ ...page, items: [...previous.items, ...page.items] }));
    } catch (error) { if (error instanceof ApiError && error.code === 'STALE_CURSOR') setRevision(value => value + 1); else onError(error); }
    finally { loadingRef.current = false; setLoading(false); }
  }
  const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 4);
  const visible = data.items.slice(start, start + 18);
  function openOperation(kind: 'new' | 'rename' | 'delete', files: RemoteFile[] = []) { setName(kind === 'rename' ? files[0].name : ''); setOperationError(''); setOperation({ kind, files }); }
  async function execute() {
    if (!operation) return;
    if (operation.kind !== 'delete' && (!name.trim() || /[/\\\0\r\n]/.test(name) || ['.', '..'].includes(name))) { setOperationError('名称不能为空，也不能包含斜杠或特殊路径片段。'); return; }
    setBusy(true); setOperationError('');
    try {
      if (operation.kind === 'new') await post('/mkdir', { path: `${path === '/' ? '' : path}/${name}` });
      if (operation.kind === 'rename') await post('/rename', { path: operation.files[0].path, newPath: `${path === '/' ? '' : path}/${name}` });
      if (operation.kind === 'delete') for (const file of operation.files) {
        await post('/delete', { path: file.path, type: file.type, confirm: true });
        setOperation(current => current && { ...current, files: current.files.filter(item => item.path !== file.path) });
      }
      onMessage(operation.kind === 'new' ? '文件夹已创建。' : operation.kind === 'rename' ? '名称已更新。' : '所选项目已删除。');
      setOperation(null); setSelected([]); setRevision(value => value + 1);
    } catch (error) { onError(error); setOperationError(error instanceof Error ? error.message : '操作失败'); setRevision(value => value + 1); }
    finally { setBusy(false); }
  }
  const toggleFile = (file: RemoteFile) => setSelected(current => current.some(item => item.path === file.path) ? current.filter(item => item.path !== file.path) : [...current, file]);
  const crumbs = path.split('/').filter(Boolean);
  return <section className="file-workspace" aria-label="文件工作台" tabIndex={-1} data-focus-fallback><div className="section-heading"><div><span className="eyebrow">MY ARCHIVE</span><h2>我的文件 <small>{data.items.length}{data.nextCursor ? '+' : ''}</small></h2></div><button className="icon-button" onClick={() => setRevision(value => value + 1)} aria-label="刷新目录" disabled={loading}>↻</button></div>
    <nav className="breadcrumbs" aria-label="当前位置"><button onClick={() => setPath('/')}>全部文件</button>{crumbs.map((crumb, index) => <span key={index}> / <button onClick={() => setPath(`/${crumbs.slice(0, index + 1).join('/')}`)}>{crumb}</button></span>)}</nav>
    <div className="file-toolbar"><label className="search"><span aria-hidden="true">⌕</span><input placeholder="搜索当前文件夹…" aria-label="搜索当前文件夹" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="清空搜索" onClick={() => setQuery('')}>×</button>}</label><div className="toolbar-actions"><button onClick={() => openOperation('new')}>＋ 新建文件夹</button><button onClick={() => onUpload(true)}>上传文件夹</button><button className="primary" onClick={() => onUpload(false)}>↑ 上传文件</button></div></div>
    <div className="list-heading"><label><input type="checkbox" aria-label="选择所有已载入文件" checked={!!data.items.length && selected.length === data.items.length} onChange={event => setSelected(event.target.checked ? [...data.items] : [])}/>{selected.length ? `已选 ${selected.length} 项` : '文件名称'}</label><div>{selected.length > 0 && <button className="danger-text" onClick={() => openOperation('delete', selected)}>删除所选</button>}<select aria-label="排序方式" value={sort} onChange={event => setSort(event.target.value)}><option value="name">名称</option><option value="modifiedAt">修改时间</option><option value="size">大小</option></select><button className="icon-button" aria-label={direction === 'asc' ? '改为降序' : '改为升序'} onClick={() => setDirection(direction === 'asc' ? 'desc' : 'asc')}>{direction === 'asc' ? '↑' : '↓'}</button></div></div>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!data.items.length && !loading && !error ? <div className="empty-state"><span>✧</span><h3>{query ? '没有找到这个名字' : '这里，还留着一页空白'}</h3><p>{query ? '试试其他关键词，或清空搜索。' : '拖入文件或文件夹，把值得收藏的东西放进来。'}</p><button className="primary" onClick={() => query ? setQuery('') : onUpload(false)}>{query ? '清空搜索' : '上传第一份文件'}</button></div> : <div className="file-viewport" ref={viewport} onScroll={event => { const element = event.currentTarget; setScroll(element.scrollTop); if (element.scrollHeight - element.scrollTop - element.clientHeight < 250) void more(); }} role="list" aria-label="文件列表" aria-busy={loading}>
      <div style={{ height: data.items.length * ROW_HEIGHT, position: 'relative' }}>{visible.map((file, index) => <div key={file.path} className={`file-row ${selected.some(item => item.path === file.path) ? 'selected' : ''}`} style={{ position: 'absolute', top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }} role="listitem"><input type="checkbox" aria-label={`选择 ${file.name}`} checked={selected.some(item => item.path === file.path)} onChange={() => toggleFile(file)}/><span className={`file-symbol ${file.type}`}>{fileSymbol(file)}</span><div className="file-name"><button title={file.name} onClick={() => file.type === 'directory' ? setPath(file.path) : toggleFile(file)}>{file.name}</button><small>{file.type === 'directory' ? '文件夹' : formatBytes(file.size)}{file.modifiedAt && ` · ${new Date(file.modifiedAt).toLocaleDateString('zh-CN')}`}</small></div><details className="file-menu"><summary aria-label={`${file.name} 的操作`}>···</summary><div>{file.type === 'file' && <a href={`${API}/download?${new URLSearchParams({ path: file.path })}`} download>下载文件</a>}<button onClick={() => openOperation('rename', [file])}>重命名</button><button className="danger-text" onClick={() => openOperation('delete', [file])}>删除</button></div></details></div>)}</div>
    </div>}
    <footer className="file-footer"><span>{loading ? '正在读取目录…' : `${data.items.length} 项${data.nextCursor ? '已载入' : ''}`}</span>{data.nextCursor && <button disabled={loading} onClick={() => void more()}>加载更多</button>}<span>支持拖入文件与文件夹</span></footer>
    {operation && <Modal title={operation.kind === 'new' ? '新建文件夹' : operation.kind === 'rename' ? '重命名' : '删除项目'} close={() => { if (!busy) setOperation(null); }}><form onSubmit={event => { event.preventDefault(); void execute(); }}>{operation.kind === 'delete' ? <><p>确认删除这 {operation.files.length} 个项目？文件夹中的内容也会删除，此操作无法撤销。</p><ul className="operation-files">{operation.files.slice(0, 8).map(file => <li key={file.path}>{file.name}</li>)}</ul></> : <label className="field">名称<input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={255} required/></label>}{operationError && <p className="inline-error" role="alert">{operationError}</p>}<div className="modal-actions"><button type="button" onClick={() => setOperation(null)} disabled={busy}>取消</button><button className={operation.kind === 'delete' ? 'danger' : 'primary'} disabled={busy}>{busy ? '处理中…' : '确认'}</button></div></form></Modal>}
  </section>;
}
