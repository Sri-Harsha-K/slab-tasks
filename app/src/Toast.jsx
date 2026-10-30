import React from 'react';

const SANS = 'var(--sans)';
const MONO = 'var(--mono)';

const btn = { flex: 1, padding: '7px 0', border: '2px solid #111', borderRadius: 999, background: '#fff', color: '#111', fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1, cursor: 'pointer' };

/**
 * One neobrutal toast. Used in-app and, unchanged, in the desktop reminder pop-up (Notifier).
 * Reminders (t.snooze) get a Snooze button next to Dismiss.
 */
export function Toast({ t, onDismiss, onOpen, onSnooze, fading }) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div style={{ opacity: fading ? 0 : 1, transform: fading ? 'translateX(12px)' : 'none', transition: 'opacity .4s ease, transform .4s ease' }}>
      <div role="status" onClick={onOpen} title={onOpen ? 'Open in Slab Tasks' : undefined}
        style={{ display: 'flex', background: '#FFF4E0', border: '3px solid #111', boxShadow: '6px 6px 0 #111', borderRadius: 14, overflow: 'hidden', fontFamily: SANS, color: '#111', cursor: onOpen ? 'pointer' : 'default' }}>
        <div style={{ flex: 1, minWidth: 0, padding: '14px 14px 12px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{t.kind}</span>
          <span style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>{t.title}</span>
          <span style={{ fontFamily: MONO, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.body}</span>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="h-modalx" onClick={stop(onDismiss)} aria-label="Dismiss" style={btn}>DISMISS</button>
            {onSnooze && t.snooze && <button className="h-modalx" onClick={stop(onSnooze)} style={{ ...btn, background: '#FFD23F' }}>SNOOZE 10 MIN</button>}
          </div>
        </div>
        <span style={{ width: 22, flex: 'none', background: t.color || '#FFD23F', borderLeft: '3px solid #111' }} />
      </div>
    </div>
  );
}
