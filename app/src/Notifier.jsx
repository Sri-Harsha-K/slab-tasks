import React from 'react';
import { Toast } from './Toast.jsx';
import { chime } from './chime.js';

export const NOTIFIER_W = 342;  // 320px toast + room for its 6px hard shadow; keep in sync with electron/main.cjs
const SHOW_MS = 5000;  // each pop-up fades out after this, unless the pointer is on it
const FADE_MS = 400;

/**
 * The desktop reminder pop-up: a small, solid, always-on-top Electron window in the corner of the screen
 * that renders the same Toast as the app. The main process owns the list; this window just draws it,
 * fades each toast out after a few seconds, and reports its height so the window can hug the stack.
 */
export default function Notifier() {
  const [toasts, setToasts] = React.useState([]);
  const [fading, setFading] = React.useState({});
  const [hover, setHover] = React.useState(false);
  const ref = React.useRef(null);
  const seen = React.useRef(new Set());
  const born = React.useRef({});  // toast id → when it first showed
  const report = () => window.slab.resizeNotifier(Math.ceil(ref.current.getBoundingClientRect().height));
  React.useEffect(() => {
    const off = window.slab.onToasts((list) => {
      if (list.some(t => !seen.current.has(t.id) && t.sound)) {
        chime().then(state => { const d = document.documentElement.dataset; d.chimes = String(+(d.chimes || 0) + 1); d.audio = state; });
      }
      list.forEach(t => { seen.current.add(t.id); if (!born.current[t.id]) born.current[t.id] = Date.now(); });
      setToasts(list);
    });
    window.slab.notifierReady();
    const ro = new ResizeObserver(report);  // e.g. when fonts finish loading
    ro.observe(ref.current);
    return () => { off(); ro.disconnect(); };
  }, []);
  // Fade out toasts older than SHOW_MS. Moving the pointer onto the stack holds them; a pop-up that merely
  // appears under a resting cursor doesn't count, or it would never fade.
  React.useEffect(() => {
    if (hover || !toasts.length) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const t of toasts) {
        if (fading[t.id] || now - born.current[t.id] < SHOW_MS) continue;
        setFading(f => ({ ...f, [t.id]: true }));
        setTimeout(() => window.slab.dismissToast(t.id), FADE_MS);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [toasts, fading, hover]);
  // The window hides when the stack empties, so the pointer never 'leaves': clear the hover hold then.
  React.useEffect(() => { if (!toasts.length) setHover(false); }, [toasts.length]);
  // Leaving the stack restarts the clock, so a toast you were reading doesn't vanish at once.
  const onLeave = () => { const now = Date.now(); toasts.forEach(t => { if (!fading[t.id]) born.current[t.id] = now; }); setHover(false); };
  // Measured on every change too: a hidden window gets no ResizeObserver callbacks, and it's hidden whenever the stack is empty.
  React.useLayoutEffect(report, [toasts]);
  return (
    <div ref={ref} onMouseMove={() => { if (!hover) setHover(true); }} onMouseLeave={onLeave}
      style={{ width: NOTIFIER_W, padding: '12px 14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {toasts.map(t => <Toast key={t.id} t={t} fading={!!fading[t.id]} onDismiss={() => window.slab.dismissToast(t.id)} onOpen={() => window.slab.openToast(t.id)} onSnooze={() => window.slab.snoozeToast(t.id)} />)}
    </div>
  );
}
