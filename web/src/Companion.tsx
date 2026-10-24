import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

export interface Art { id: string; name: string; src: string; tone?: string; description?: string }
export interface Artwork { scenes: Art[]; characters: Art[]; pet: { src: string }; attribution: { label: string; url: string } }
export interface Preferences { scene: string; character: string; focus: boolean; motion: boolean; pet: boolean; autonomy: boolean; petX: number; petY: number }
const DEFAULTS: Preferences = { scene: 'day', character: 'academy', focus: false, motion: true, pet: true, autonomy: true, petX: .94, petY: .9 };
export const artUrl = (src: string) => `${import.meta.env.BASE_URL}art/${src}`;
export function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem('ftp-web-appearance') || '{}');
    const prefs = { ...DEFAULTS };
    for (const key of ['focus', 'motion', 'pet', 'autonomy'] as const) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
    for (const key of ['scene', 'character'] as const) if (typeof saved[key] === 'string') prefs[key] = saved[key];
    for (const key of ['petX', 'petY'] as const) if (Number.isFinite(saved[key])) prefs[key] = Math.max(0, Math.min(1, saved[key]));
    return prefs;
  } catch { return DEFAULTS; }
}
export function savePreferences(prefs: Preferences) {
  try { localStorage.setItem('ftp-web-appearance', JSON.stringify(prefs)); }
  catch { /* Visual preferences are optional; storage restrictions must not break file operations. */ }
}
export function Companion({ character, message }: { character?: Art; message: string }) {
  return <aside className="companion"><div className="companion-heading"><span className="eyebrow">YOUR LITTLE CLOUD ARCHIVE</span><h1>云端资料室</h1><p>把重要的日常，好好收藏。</p></div>
    <div className="speech"><strong>今天，也一起整理吧。</strong><p>{message}</p></div>
    <div className="character-stage">{character && <img className="character-art" src={artUrl(character.src)} alt={character.description || character.name} />}</div>
  </aside>;
}
export function Appearance({ artwork, prefs, update }: { artwork: Artwork; prefs: Preferences; update: (patch: Partial<Preferences>) => void }) {
  return <div className="appearance"><h3>窗外的风景</h3><div className="art-options scenes">{artwork.scenes.map(scene => <button key={scene.id} aria-pressed={prefs.scene === scene.id} onClick={() => update({ scene: scene.id })}><img src={artUrl(scene.src)} alt="" loading="lazy"/><span>{scene.name}</span></button>)}</div>
    <h3>今天穿什么？</h3><div className="art-options characters">{artwork.characters.map(character => <button key={character.id} aria-pressed={prefs.character === character.id} onClick={() => update({ character: character.id })}><img src={artUrl(character.src)} alt="" loading="lazy"/><span>{character.name}</span></button>)}</div>
    <div className="preference-list">{([['motion', '启用动态效果', '场景和 Q 宠轻动，主立绘保持清晰。'], ['pet', '显示 Q 版龙娘', '自由拖动，点击可以一起玩。'], ['autonomy', 'Q 宠自主活动', '闲下来时偶尔招手、散步。']] as const).map(([key, label, hint]) => <label key={key}><span><strong>{label}</strong><small>{hint}</small></span><input type="checkbox" checked={prefs[key]} onChange={event => update({ [key]: event.target.checked })}/></label>)}</div>
    <p className="muted small">系统开启“减少动态效果”时优先使用静态效果。</p></div>;
}
const POSES = ['idle', 'wave', 'walk', 'jump', 'sleep', 'drag'];
export function Pet({ src, prefs, update, modalOpen }: { src: string; prefs: Preferences; update: (patch: Partial<Preferences>) => void; modalOpen: boolean }) {
  const [position, setPosition] = useState({ x: prefs.petX, y: prefs.petY });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [pose, setPose] = useState('idle');
  const [action, setAction] = useState('');
  const [menu, setMenu] = useState(false);
  const [message, setMessage] = useState('');
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [nativeModal, setNativeModal] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canAnimate = prefs.motion && !hidden && !reduced && !modalOpen && !nativeModal;
  const maxX = Math.max(1, viewport.width - 102), maxY = Math.max(1, viewport.height - 106);
  const x = Math.round(position.x * maxX), y = Math.round(position.y * maxY);
  const move = (nextX: number, nextY: number, persist = true) => {
    const next = { x: Math.min(1, Math.max(0, nextX / maxX)), y: Math.min(1, Math.max(0, nextY / maxY)) };
    setPosition(next); if (persist) update({ petX: next.x, petY: next.y });
  };
  useEffect(() => {
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    const visibility = () => setHidden(document.hidden);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    const modal = (event: Event) => setNativeModal((event as CustomEvent<boolean>).detail);
    document.addEventListener('ftp-modal-change', modal);
    window.addEventListener('resize', resize); document.addEventListener('visibilitychange', visibility); media.addEventListener('change', change);
    return () => { window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', change); document.removeEventListener('ftp-modal-change', modal); };
  }, []);
  useEffect(() => {
    if (!canAnimate || menu || !prefs.autonomy || !prefs.pet || pose !== 'idle' || drag.current) return;
    const timer = setTimeout(() => perform(Math.random() > .5 ? 'wave' : 'walk'), 12000 + Math.random() * 6000);
    return () => clearTimeout(timer);
  }, [canAnimate, menu, prefs.autonomy, prefs.pet, pose, position]);
  useEffect(() => {
    if (!modalOpen && !nativeModal && prefs.pet && !hidden) return;
    if (drag.current && button.current?.hasPointerCapture(drag.current.id)) button.current.releasePointerCapture(drag.current.id);
    drag.current = null; setMenu(false); setAction(''); if (pose !== 'sleep') setPose('idle');
  }, [modalOpen, nativeModal, prefs.pet, hidden]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: globalThis.PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  function perform(next: string) {
    setMenu(false); setAction('');
    if (next === 'hide') { update({ pet: false }); return; }
    if (next === 'home') { move(maxX * .94, maxY * .9); setPose('idle'); return; }
    if (next === 'sleep') { setPose(pose === 'sleep' ? 'idle' : 'sleep'); setMessage(pose === 'sleep' ? '醒啦，一起继续吧。' : '在这里打个小盹…'); return; }
    setPose(next === 'pat' ? 'wave' : next);
    setMessage(({ pat: '摸摸头，今天也辛苦啦。', wave: '嗨，我在这里！', jump: '嘿咻！', walk: '去那边看看～' })[next] || '');
    if (next === 'walk' && canAnimate) move(x > maxX / 2 ? x - 40 : x + 40, y);
    if (canAnimate) setAction(next); // Reduced motion still permits a manual pose change.
  }
  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    suppressClick.current = false; setAction(''); setMessage('');
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: x, startY: y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function travel(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) <= 5) return;
    current.moved = true; setMenu(false); setPose('drag'); move(current.startX + dx, current.startY + dy, false);
  }
  function release(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressClick.current = current.moved;
    if (current.moved) { move(x, y); setPose('idle'); setAction(canAnimate ? 'land' : ''); }
  }
  if (!prefs.pet) return null;
  const index = Math.max(0, POSES.indexOf(pose));
  const spriteStyle = { backgroundImage: `url(${artUrl(src)})`, backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 100}%` } as CSSProperties;
  return <div className="pet-layer" inert={modalOpen || undefined}><div className={`pet ${canAnimate ? `pet-${action || pose}` : ''}`} style={{ left: x, top: y }} onAnimationEnd={() => { setAction(''); if (pose !== 'sleep') setPose('idle'); }}>
    {message && <p className={`pet-speech ${x < viewport.width / 2 ? 'right' : ''}`} aria-live="polite">{message}</p>}
    <button ref={button} className="pet-button" aria-label="龙娘动作菜单；可拖动，方向键移动" aria-expanded={menu} onPointerDown={start} onPointerMove={travel} onPointerUp={release} onPointerCancel={release}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (pose === 'sleep') setPose('idle'); setMenu(value => !value); }}
      onKeyDown={event => { const offset: Record<string, number[]> = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }; if (offset[event.key]) { event.preventDefault(); move(x + offset[event.key][0], y + offset[event.key][1]); } if (event.key === 'Escape') setMenu(false); }}><span className="pet-sprite" style={spriteStyle}/></button>
  </div>{menu && <div ref={menuRef} className="pet-menu" style={{ left: Math.max(6, Math.min(viewport.width - 226, x - 100)), top: Math.max(6, y > 300 ? y - 292 : Math.min(viewport.height - 292, y + 102)) }} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); button.current?.focus(); } }}><strong>一起玩一会儿</strong><div>{[['pat','摸摸头'],['wave','打招呼'],['jump','跳一下'],['walk','散步'],['sleep',pose === 'sleep' ? '醒醒' : '打盹'],['home','回到角落'],['hide','收起']].map(([key, label]) => <button key={key} onClick={() => perform(key)}>{label}</button>)}</div><small>拖动可搬家 · 方向键也能移动</small></div>}</div>;
}
