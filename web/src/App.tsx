import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, post, request, setSessionToken, type Session } from './api';
import { Appearance, Companion, Pet, artUrl, loadPreferences, savePreferences, type Artwork, type Preferences } from './Companion';
import { FileBrowser } from './FileBrowser';
import { fromFileList, pickDirectory, readDrop, type ScanOptions, type Selection } from './files';
import { Modal } from './Modal';
import { TransferPanel } from './TransferPanel';
import { backgroundNotice, transferQueue, isFinished } from './transfers';
import { UploadDialog } from './UploadDialog';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);
  const [artwork, setArtwork] = useState<Artwork | null>(null);
  const [prefs, setPrefs] = useState(loadPreferences);
  const [appearance, setAppearance] = useState(false);
  const [logout, setLogout] = useState(false);
  const [view, setView] = useState('files');
  const [path, setPath] = useState('/');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [drop, setDrop] = useState(false);
  const [reading, setReading] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const scanController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const reselectFiles = useRef<HTMLInputElement>(null), reselectFolder = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const snapshot = useSyncExternalStore(transferQueue.subscribe, transferQueue.getSnapshot);
  const active = snapshot.tasks.filter(task => !isFinished(task));
  const localRequired = active.some(task => !task.canClosePage);
  const scene = artwork?.scenes.find(item => item.id === prefs.scene) || artwork?.scenes[0];
  const character = artwork?.characters.find(item => item.id === prefs.character) || artwork?.characters[0];
  const modalOpen = appearance || logout || !!selection || expired;
  const updatePrefs = (patch: Partial<Preferences>) => setPrefs(current => { const next = { ...current, ...patch }; savePreferences(next); return next; });
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { setExpired(true); void transferQueue.stop(); }
    setError(error instanceof Error ? error.message : '操作失败，请重试。');
  }
  async function adoptSession(next: Session) {
    setSessionToken(next); setSession(next); setExpired(false); setError('');
    if (next.authenticated) {
      if (next.ftpAuthorized === false) { setExpired(true); await transferQueue.connect(next); return; }
      await post('/tasks/reauthorize'); await transferQueue.connect(next); setRefresh(value => value + 1);
    }
  }
  useEffect(() => {
    transferQueue.onAuthRequired = () => setExpired(true);
    request<Session>('/session').then(adoptSession).catch(handleError).finally(() => setChecking(false));
    fetch(`${import.meta.env.BASE_URL}art/manifest.json`).then(response => { if (!response.ok) throw new Error('场景素材加载失败'); return response.json(); }).then(setArtwork).catch(() => setMessage('场景暂时未加载，文件功能仍可正常使用。'));
    return () => { void transferQueue.stop(); };
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (localRequired) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [localRequired]);
  useEffect(() => {
    const online = () => { setMessage('网络已恢复，正在同步任务。'); void transferQueue.refresh(); };
    const visibility = () => setPageHidden(document.hidden);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  async function choose(directory: boolean) {
    if (!directory) { fileInput.current?.click(); return; }
    await scan(async options => { const result = await pickDirectory(options); if (!result) folderInput.current?.click(); return result; });
  }
  async function scan(read: (options: ScanOptions) => Promise<Selection | null>) {
    scanController.current?.abort();
    const controller = new AbortController(); scanController.current = controller;
    setReading(true); setScanCount(0);
    try {
      const result = await read({ signal: controller.signal, onProgress: setScanCount });
      if (result && !controller.signal.aborted) setSelection(result);
    } catch (error) { if ((error as Error).name !== 'AbortError') handleError(error); }
    finally { if (scanController.current === controller) { setReading(false); scanController.current = null; } }
  }
  async function restore(files: FileList | null) {
    if (!files) return;
    scanController.current?.abort();
    const controller = new AbortController(); scanController.current = controller; setReading(true); setScanCount(0);
    try { const count = await transferQueue.reselect(Array.from(files), { signal: controller.signal, onProgress: setScanCount }); setMessage(count ? `已关联 ${count} 个原文件，可继续接收。已暂停的任务请点击“继续”。` : '没有匹配的未完成文件。请重选原文件或原文件夹，文件内容需保持一致。'); }
    catch (error) { if ((error as Error).name !== 'AbortError') handleError(error); }
    finally { if (scanController.current === controller) { setReading(false); scanController.current = null; } }
  }
  function chooseFiles(files: FileList | null, directory = false) {
    if (!files) return;
    try { setSelection(fromFileList(files, directory)); }
    catch (error) { handleError(error); }
  }
  const companionMessage = expired ? '连接需要重新授权，重新登录后继续就好，已收的字节还在。' : active.length ? backgroundNotice(active).message : '整理收藏、上传新文件，或换一扇窗外的风景。';
  return <div className={`app ${prefs.focus ? 'focus-mode' : ''} ${prefs.motion ? 'motion' : ''} ${pageHidden ? 'page-hidden' : ''}`} data-tone={scene?.tone || 'day'}>
    <div className="scene-layer" aria-hidden="true">{scene && <img src={artUrl(scene.src)} alt=""/>}<div className="scene-wash"/>{prefs.motion && <div className="motes">{[0,1,2,3,4,5].map(value => <i key={value} style={{ left: `${12 + value * 16}%`, animationDelay: `${value * -2}s` }}/>)}</div>}</div>
    <header className="topbar"><a className="brand" href={import.meta.env.BASE_URL}><span className="brand-mark">✦</span><span>云端资料室<small>FTP WEB · A PLACE FOR YOUR FILES</small></span></a><div className="account"><span className={`status-dot ${session?.authenticated ? 'connected' : ''}`}/><span>{session?.authenticated ? session.user?.username : '未连接'}</span>{session?.authenticated && <button onClick={() => setLogout(true)}>退出</button>}</div></header>
    <nav className="navigation" aria-label="主导航"><div className="nav-pages"><button aria-current={view === 'files' ? 'page' : undefined} onClick={() => setView('files')}>▰ 全部文件</button><button aria-current={view === 'transfers' ? 'page' : undefined} onClick={() => setView('transfers')}>↕ 传输中心{active.length > 0 && <b>{active.length}</b>}</button></div><div className="appearance-tools"><button onClick={() => setAppearance(true)} disabled={!artwork}>✧ 装扮与场景</button><button onClick={() => updatePrefs({ focus: !prefs.focus })} aria-pressed={prefs.focus}>{prefs.focus ? '✦ 陪伴模式' : '▣ 专注模式'}</button></div></nav>
    <main className="shell">{!prefs.focus && <Companion character={character} message={companionMessage}/>}
      <div className="workspace" onDragEnter={event => { if (!event.dataTransfer.types.includes('Files') || !session?.authenticated) return; event.preventDefault(); depth.current++; setDrop(true); }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDragLeave={event => { event.preventDefault(); if (--depth.current <= 0) setDrop(false); }} onDrop={event => { event.preventDefault(); depth.current = 0; setDrop(false); if (!session?.authenticated) return; void scan(options => readDrop(event.dataTransfer, options)); }}>
      {error && <div className="alert-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误提示">×</button></div>}
      {message && <div className="message-banner" role="status"><span>{message}</span><button onClick={() => setMessage('')} aria-label="关闭提示">×</button></div>}
      {checking ? <div className="empty-state"><span>✧</span><h2>正在连接资料室…</h2></div> : !session?.authenticated ? <Login onLogin={adoptSession} onError={handleError}/> : <><div hidden={view !== 'files'}><FileBrowser onError={handleError} onUpload={directory => void choose(directory)} onPath={setPath} refreshToken={refresh} onMessage={setMessage}/></div><div className={view === 'transfers' ? 'full-transfers' : ''}><TransferPanel onReselect={directory => directory ? reselectFolder.current?.click() : reselectFiles.current?.click()} onError={handleError} onReauthorize={() => setExpired(true)}/></div></>}
      {(drop || reading) && <div className="drop-layer"><span>↓</span><h2>{reading ? '正在读取文件结构…' : '放进资料室吧'}</h2><p>{reading ? `已发现 ${scanCount} 个文件与目录` : '文件与文件夹都可以，保留原来的目录结构。'}</p>{reading && <button onClick={() => { scanController.current?.abort(); setReading(false); setMessage('已停止读取；已有传输任务不受影响。'); }}>取消读取</button>}</div>}</div>
    </main><footer className="app-footer"><p>好好收藏，每一个值得记住的日常。</p><small>角色原案 <a href="https://space.bilibili.com/4168597" target="_blank" rel="noreferrer">ZipZipPipe</a> · AI 同人演绎</small></footer>
    <input hidden ref={fileInput} type="file" multiple onChange={event => { chooseFiles(event.target.files); event.target.value = ''; }}/>
    <input hidden ref={folderInput} type="file" multiple {...{ webkitdirectory: '' }} onChange={event => { chooseFiles(event.target.files, true); event.target.value = ''; }}/>
    <input hidden ref={reselectFiles} type="file" multiple onChange={event => { void restore(event.target.files); event.target.value = ''; }}/>
    <input hidden ref={reselectFolder} type="file" multiple {...{ webkitdirectory: '' }} onChange={event => { void restore(event.target.files); event.target.value = ''; }}/>
    {appearance && artwork && <Modal title="装扮与场景" wide close={() => setAppearance(false)}><Appearance artwork={artwork} prefs={prefs} update={updatePrefs}/></Modal>}
    {selection && <UploadDialog selection={selection} destination={path} close={() => setSelection(null)} onError={handleError} onComplete={() => { setView('transfers'); setMessage('任务已建立。进度会分别显示上传和 FTP 转存。'); setRefresh(value => value + 1); }}/>}
    {expired && session?.authenticated && <Modal title="重新连接资料室" close={() => setExpired(false)}><p className="notice">连接需要重新授权。任务与服务器已收字节会保留，请重新登录同一账号。</p><Login compact onLogin={adoptSession} onError={handleError}/></Modal>}
    {logout && <Modal title="退出登录" close={() => setLogout(false)}><p>退出会撤销服务器的 FTP 授权，未完成的任务将等待重新登录。已完成的文件会保留。</p><div className="modal-actions"><button onClick={() => setLogout(false)}>继续整理</button><button className="primary" onClick={() => { void transferQueue.stop().then(() => post('/logout')).then(() => { setSession(null); setSessionToken({ csrfToken: '' } as Session); setLogout(false); }).catch(handleError); }}>确认退出</button></div></Modal>}
    {artwork && <Pet src={artwork.pet.src} prefs={prefs} update={updatePrefs} modalOpen={modalOpen}/>}
  </div>;
}
function Login({ onLogin, onError, compact = false }: { onLogin: (session: Session) => Promise<void>; onError: (error: unknown) => void; compact?: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const session = await post<Session>('/login', { username, password }); await onLogin(session); }
    catch (error) { setError(error instanceof Error ? error.message : '连接失败'); onError(error); }
    finally { setPassword(''); setBusy(false); }
  }
  return <form className={`login ${compact ? 'compact' : ''}`} onSubmit={event => void submit(event)}>{!compact && <><span className="eyebrow">WELCOME HOME</span><h2>打开你的云端收藏</h2><p>连接 FTP 账号，文件与回忆都在这里。</p></>}<label className="field">账号<input name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required autoFocus/></label><label className="field">密码<input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required/></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '正在连接…' : '进入资料室 →'}</button><small>密码仅用于本次连接，不会保存在浏览器的任务记录中。</small></form>;
}
