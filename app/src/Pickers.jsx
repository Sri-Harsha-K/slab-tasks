import React from 'react';

const SANS = 'var(--sans)';
const MONO = 'var(--mono)';
const stop = (e) => e.stopPropagation();

const panel = (align, width) => ({
  position: 'absolute', top: 'calc(100% + 8px)', [align === 'right' ? 'right' : 'left']: 0, zIndex: 5, width,
  background: '#FFF4E0', border: '3px solid #111', borderRadius: 14, boxShadow: '6px 6px 0 #111', padding: 10,
  display: 'flex', flexDirection: 'column', gap: 8, fontFamily: MONO,
});
const arrow = { width: 32, height: 32, border: '2px solid #111', borderRadius: 8, background: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer', color: '#111' };
const pill = { height: 32, padding: '0 12px', border: '2px solid #111', borderRadius: 999, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer' };

/** The V0 neobrutal date picker. `cells` are the Date objects of the month grid. */
export function DatePicker({ title, cells, month, order, dayLetters, value, min, todayStr, fmt, onPrev, onNext, onPick, clear, align, mobile }) {
  return (
    <div onClick={stop} style={panel(align, mobile ? 300 : 272)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="h-yellow" onClick={onPrev} style={{ ...arrow, ...(mobile && { width: 44, height: 44 }) }}>‹</button>
        <span style={{ fontFamily: SANS, fontSize: 16, fontWeight: 800, textTransform: 'uppercase' }}>{title}</span>
        <button className="h-yellow" onClick={onNext} style={{ ...arrow, ...(mobile && { width: 44, height: 44 }) }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 3 }}>
        {order.map(i => <div key={'w' + i} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, padding: '2px 0' }}>{dayLetters[i]}</div>)}
        {cells.map(d => {
          const k = fmt(d), inM = d.getMonth() === month, sel = k === value, dis = !!min && k < min, isT = k === todayStr;
          return (
            <button key={k} className="h-dpcell" onClick={() => { if (!dis) onPick(k); }}
              style={{ aspectRatio: '1', border: isT && !sel ? '2px solid #FF5C5C' : sel ? '2px solid #111' : inM && !dis ? '2px solid #111' : '2px solid transparent', borderRadius: 8, background: sel ? '#111' : dis ? 'transparent' : '#fff', color: sel ? '#FFD23F' : dis ? '#C9BEA8' : inM ? '#111' : '#9C907A', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: dis ? 'not-allowed' : 'pointer', padding: 0 }}>{d.getDate()}</button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {clear && <button className="h-noend" onClick={clear.onClick} style={{ ...pill, background: '#fff', color: '#111' }}>{clear.label}</button>}
        <button className="h-dptoday" onClick={() => { if (!min || todayStr >= min) onPick(todayStr); }} style={{ ...pill, background: '#111', color: '#FFD23F' }}>TODAY</button>
      </div>
    </div>
  );
}

/**
 * P6: 15-minute slot list in the date picker's style. `slots` are { t, label }; `value` is highlighted,
 * or, when it isn't a slot (e.g. while typing), the nearest slot is scrolled into view.
 */
export function TimePicker({ slots, value, onPick, align, mobile }) {
  const listRef = React.useRef(null);
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const near = value && !slots.some(s => s.t === value)
    ? slots.reduce((b, s) => Math.abs(toMin(s.t) - toMin(value)) < Math.abs(toMin(b.t) - toMin(value)) ? s : b, slots[0]).t : null;
  React.useEffect(() => {
    const el = listRef.current, target = el && (el.querySelector('[data-sel="1"]') || el.querySelector('[data-near="1"]'));
    if (target) el.scrollTop = target.offsetTop - el.clientHeight / 2 + target.offsetHeight / 2;
  }, [value]);
  return (
    <div onClick={stop} data-timepicker style={panel(align, 176)}>
      <div ref={listRef} tabIndex={-1} style={{ maxHeight: 248, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 4px 4px 2px', position: 'relative' }}>
        {slots.map(s => {
          const sel = s.t === value;
          return (
            <button key={s.t} tabIndex={-1} data-sel={sel ? '1' : '0'} data-near={s.t === near ? '1' : '0'} className="h-dpcell" onClick={() => onPick(s.t)}
              style={{ flex: 'none', height: mobile ? 44 : 32, border: '2px solid #111', borderRadius: 8, background: sel ? '#111' : '#fff', color: sel ? '#FFD23F' : '#111', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left', padding: '0 10px', whiteSpace: 'nowrap' }}>{s.label}</button>
          );
        })}
      </div>
    </div>
  );
}

export const SearchIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
);
export const DotsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#111" aria-hidden="true"><circle cx="5" cy="12" r="2.6" /><circle cx="12" cy="12" r="2.6" /><circle cx="19" cy="12" r="2.6" /></svg>
);
