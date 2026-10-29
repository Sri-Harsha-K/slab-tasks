import React from 'react';

const SANS = 'var(--sans)';
const MONO = 'var(--mono)';

/** One neobrutal toast. Used in-app and, unchanged, in the desktop reminder pop-up (Notifier). */
export function Toast({ t, onDismiss, onOpen }) {
  return (
    <div role="status" onClick={onOpen} title={onOpen ? 'Open in Slab Tasks' : undefined}
      style={{ display: 'flex', background: '#FFF4E0', border: '3px solid #111', boxShadow: '6px 6px 0 #111', borderRadius: 14, overflow: 'hidden', fontFamily: SANS, color: '#111', cursor: onOpen ? 'pointer' : 'default' }}>
      <span style={{ width: 14, flex: 'none', background: t.color || '#FFD23F', borderRight: '3px solid #111' }} />
      <div style={{ flex: 1, minWidth: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{t.kind}</span>
        <span style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>{t.title}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.body}</span>
      </div>
      <button className="h-modalx" onClick={(e) => { e.stopPropagation(); onDismiss(); }} aria-label="Dismiss" style={{ width: 44, flex: 'none', border: 'none', borderLeft: '3px solid #111', background: '#fff', color: '#111', fontWeight: 800, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
    </div>
  );
}
