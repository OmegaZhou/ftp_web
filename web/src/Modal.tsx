import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native dialogs provide focus trapping, inert background, Escape and focus restoration. */
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    document.dispatchEvent(new CustomEvent('ftp-modal-change', { detail: true }));
    const cancel = (event: Event) => { event.preventDefault(); closeRef.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); document.dispatchEvent(new CustomEvent('ftp-modal-change', { detail: !!document.querySelector('dialog[open]') })); if (previous?.isConnected) previous.focus({ preventScroll: true }); else document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭弹窗">×</button></header>{children}</dialog>;
}
