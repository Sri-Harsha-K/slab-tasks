import React from 'react';
import { Toast } from './Toast.jsx';
import { chime } from './chime.js';

export const NOTIFIER_W = 342;  // 320px toast + room for its 6px hard shadow; keep in sync with electron/main.cjs

/**
 * The desktop reminder pop-up: a transparent, always-on-top Electron window in the corner of the screen
 * that renders the same Toast as the app. The main process owns the list; this window just draws it
 * and reports its height so the window can hug the stack.
 */
export default function Notifier() {
  const [toasts, setToasts] = React.useState([]);
  const ref = React.useRef(null);
  const seen = React.useRef(new Set());
  const report = () => window.slab.resizeNotifier(Math.ceil(ref.current.getBoundingClientRect().height));
  React.useEffect(() => {
    const off = window.slab.onToasts((list) => {
      if (list.some(t => !seen.current.has(t.id) && t.sound)) {
        chime().then(state => { const d = document.documentElement.dataset; d.chimes = String(+(d.chimes || 0) + 1); d.audio = state; });
      }
      list.forEach(t => seen.current.add(t.id));
      setToasts(list);
    });
    window.slab.notifierReady();
    const ro = new ResizeObserver(report);  // e.g. when fonts finish loading
    ro.observe(ref.current);
    return () => { off(); ro.disconnect(); };
  }, []);
  // Measured on every change too: a hidden window gets no ResizeObserver callbacks, and it's hidden whenever the stack is empty.
  React.useLayoutEffect(report, [toasts]);
  return (
    <div ref={ref} style={{ width: NOTIFIER_W, padding: '8px 14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {toasts.map(t => <Toast key={t.id} t={t} onDismiss={() => window.slab.dismissToast(t.id)} onOpen={() => window.slab.openToast(t.id)} />)}
    </div>
  );
}
