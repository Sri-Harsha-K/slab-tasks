import React from 'react';
import tasksMark from './assets/tasks-mark.svg';
import { MONTHS, DAYS, fmt, parse, addDays, short, fmtLong, hhmm } from './lib/dates.js';
import { COLORS, DEFAULT_COLOR, normalizeDoc, viewTasks, groupTasks, counts, bucket } from '../shared/tasks.js';
import { api, desktop } from './lib/api.js';
import { DatePicker, TimePicker, SearchIcon, DotsIcon } from './Pickers.jsx';
import { Toast } from './Toast.jsx';

const SANS = 'var(--sans)';
const MONO = 'var(--mono)';
const NAME_KEY = 'slab-tasks-name', PREFS_KEY = 'slab-tasks-prefs';
const VIEWS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['all', 'All'], ['done', 'Done']];
const TITLES = { today: 'Today', upcoming: 'Upcoming', all: 'All tasks', done: 'Done' };
const COLOR_NAMES = ['Yellow', 'Orange', 'Red', 'Pink', 'Purple', 'Blue', 'Teal', 'Green'];
const TIME_SLOTS = [{ t: '', label: 'Any time' }, ...Array.from({ length: 96 }, (_, i) => ({ t: hhmm(i * 15), label: hhmm(i * 15) }))];
const FRESH_MS = 8000;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const loadPrefs = () => { try { return { view: 'all', groupBy: 'date', ...JSON.parse(store.get(PREFS_KEY) || '{}') }; } catch (e) { return { view: 'all', groupBy: 'date' }; } };
const stop = (e) => e.stopPropagation();
const monthOf = (k) => { const d = parse(k); return new Date(d.getFullYear(), d.getMonth(), 1); };
const ORDER = [1, 2, 3, 4, 5, 6, 0];  // weeks start on Monday, like Slab's default

export default class Tasks extends React.Component {
  prefs = loadPrefs();
  state = {
    doc: normalizeDoc(null), loaded: false, now: new Date(), vw: window.innerWidth,
    view: this.prefs.view, groupBy: this.prefs.groupBy, meetingId: '', query: '', searching: false,
    quick: '', quickDue: this.prefs.view === 'today' ? fmt(new Date()) : '', quickDp: null,
    draft: null, dp: null, menu: null, toasts: [], fresh: {}, autoStart: false,
    name: store.get(NAME_KEY), editingName: false, nameDraft: '',
  };
  quickRef = React.createRef();
  searchRef = React.createRef();
  menuRef = React.createRef();
  quickDpRef = React.createRef();

  componentDidMount() {
    api.get().then(doc => this.setState({ doc, loaded: true }));
    this.offChange = api.onChange((doc) => {
      const old = new Set(this.state.doc.tasks.map(t => t.id));
      const fresh = { ...this.state.fresh };
      for (const t of doc.tasks) if (!old.has(t.id) && t.createdBy === 'claude') fresh[t.id] = Date.now();
      this.setState({ doc, fresh });
      clearTimeout(this.freshTimer);
      this.freshTimer = setTimeout(() => this.setState({ fresh: {} }), FRESH_MS);
    });
    this.offOpen = api.onOpen(({ id }) => { const t = this.state.doc.tasks.find(x => x.id === id); if (t) this.openEdit(t); });
    this.onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.key === 'Escape') {
        if (this.state.dp || this.state.quickDp) return this.setState({ dp: null, quickDp: null });
        if (this.state.menu) return this.setState({ menu: null });
        if (this.state.draft) return this.setState({ draft: null });
        if (this.state.searching) return this.setState({ searching: false, query: '' });
        return this.setState({ editingName: false });
      }
      if (!e.isTrusted || tag === 'input' || tag === 'textarea' || this.state.draft) return;
      if (e.key === '/') { e.preventDefault(); this.setState({ searching: true }, () => this.searchRef.current && this.searchRef.current.focus()); }
      else if (e.key === 'n') { e.preventDefault(); this.quickRef.current && this.quickRef.current.focus(); }
      else if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') this.setView(VIEWS[+e.key - 1][0]);
    };
    window.addEventListener('keydown', this.onKey);
    this.onDown = (e) => {
      const t = e.target, s = this.state;
      if (s.menu && this.menuRef.current && !this.menuRef.current.contains(t) && !(t.closest && t.closest('[data-pop-trigger="menu"]'))) this.setState({ menu: null });
      if (s.quickDp && this.quickDpRef.current && !this.quickDpRef.current.contains(t)) this.setState({ quickDp: null });
    };
    document.addEventListener('mousedown', this.onDown);
    this.onResize = () => this.setState({ vw: window.innerWidth, menu: null });
    window.addEventListener('resize', this.onResize);
    // Keeps "today" right across midnight.
    this.timer = setInterval(() => this.setState({ now: new Date() }), 60000);
  }
  componentWillUnmount() {
    window.removeEventListener('keydown', this.onKey); document.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('resize', this.onResize); clearInterval(this.timer); clearTimeout(this.freshTimer);
    if (this.offChange) this.offChange();
    if (this.offOpen) this.offOpen();
  }

  // ---- changes --------------------------------------------------------------------------------
  apply = (p) => p.then(doc => { if (doc) this.setState({ doc }); return doc; });
  setPref(k, v) { this.prefs = { ...this.prefs, [k]: v }; store.set(PREFS_KEY, JSON.stringify(this.prefs)); }
  setView(view) {
    this.setPref('view', view);
    const todayStr = fmt(this.state.now);
    this.setState({ view, quickDue: view === 'today' ? todayStr : view === 'upcoming' ? addDays(todayStr, 1) : '', quickDp: null });
  }
  setGroup(groupBy) { this.setPref('groupBy', groupBy); this.setState({ groupBy }); }
  addQuick = () => {
    const title = this.state.quick.trim();
    if (!title) return;
    this.apply(api.add({ title, due: this.state.quickDue }));
    this.setState({ quick: '' });
  };
  toggle(t) { this.apply(api.update(t.id, { done: !t.done })); }
  commitName = () => {
    const v = this.state.nameDraft.trim().slice(0, 28);
    if (v) store.set(NAME_KEY, v);
    this.setState({ editingName: false, name: v || this.state.name });
  };
  toast(t) {
    const id = Date.now() + Math.random();
    this.setState(s => ({ toasts: [...s.toasts, { color: '#FFD23F', ...t, id }].slice(-3) }));
    setTimeout(() => this.dismiss(id), 5000);
  }
  dismiss(id) { this.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) })); }

  openNew = () => this.setState({ draft: { id: '', title: this.state.quick.trim(), notes: '', due: this.state.quickDue, time: '', color: DEFAULT_COLOR, done: false, source: null, createdBy: 'me' }, dp: null, menu: null });
  openEdit(t) { this.setState({ draft: { ...t }, dp: null, menu: null }); }
  setDraft(p) { this.setState(s => ({ draft: { ...s.draft, ...(typeof p === 'function' ? p(s.draft) : p) } })); }
  closeForm = () => this.setState({ draft: null, dp: null });
  save = () => {
    const d = this.state.draft, title = d.title.trim() || 'Untitled';
    const fields = { title, notes: d.notes, due: d.due, time: d.due ? d.time : '', color: d.color };
    if (d.id) this.apply(api.update(d.id, { ...fields, done: d.done }));
    else { this.apply(api.add(fields)); if (title === this.state.quick.trim()) this.setState({ quick: '' }); }
    this.closeForm();
  };
  remove = () => {
    const d = this.state.draft;
    this.apply(api.remove(d.id));
    this.toast({ kind: 'DELETED', title: d.title, body: 'Task removed', color: '#FF5C5C' });
    this.closeForm();
  };
  clearDone = () => {
    const n = this.state.doc.tasks.filter(t => t.done).length;
    this.apply(api.clearDone());
    this.setState({ menu: null });
    this.toast({ kind: 'CLEARED', title: n === 1 ? '1 done task cleared' : n + ' done tasks cleared', body: 'Open tasks are untouched' });
  };
  copyConfig = () => {
    window.slab.copyMcpConfig().then(() => this.toast({ kind: 'CLAUDE', title: 'MCP config copied', body: 'Paste into claude_desktop_config.json', color: '#4FD1C5' }));
    this.setState({ menu: null });
  };
  toggleAutoStart = () => { window.slab.setAutoStart(!this.state.autoStart).then(v => this.setState({ autoStart: v })); };

  // ---- helpers --------------------------------------------------------------------------------
  gridFor(first) {
    const start = new Date(first); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const n = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7) * 7;
    return Array.from({ length: n }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }
  dateLabel = (k) => {
    const todayStr = fmt(this.state.now);
    if (k === todayStr) return 'Today';
    if (k === addDays(todayStr, 1)) return 'Tomorrow';
    return fmtLong(k);
  };
  chipDate(k, todayStr) {
    if (!k) return 'NO DATE';
    if (k === todayStr) return 'TODAY';
    if (k === addDays(todayStr, 1)) return 'TMRW';
    return short(parse(k)).toUpperCase();
  }

  // ---- render --------------------------------------------------------------------------------
  render() {
    const { doc, view, groupBy, meetingId, query, draft, menu, vw } = this.state;
    const narrow = vw < 1000, mobile = vw < 600;
    const todayStr = fmt(this.state.now);
    const c = counts(doc.tasks, todayStr);
    const list = viewTasks(doc.tasks, view, todayStr, { meetingId, query });
    const groups = groupTasks(list, view === 'done' ? 'done' : groupBy, todayStr, this.dateLabel);
    const ui = { narrow, mobile, todayStr, c };
    return (
      <div style={{ height: '100vh', background: '#FFF4E0', color: '#111', fontFamily: SANS, padding: mobile ? '12px 12px 8px' : narrow ? '18px 20px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20, overflow: 'hidden' }}>
        {this.renderHeader(ui)}
        <div style={{ display: 'flex', gap: 28, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
            {view !== 'done' && this.renderQuickAdd(ui)}
            {this.renderToolbar(ui, list.length)}
            <div data-list style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 10px 12px 2px', display: 'flex', flexDirection: 'column', gap: 18 }}>
              {groups.map(g => (
                <section key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: g.key === 'overdue' ? '#FF3B30' : '#111' }}>
                    <span>{g.label}</span><span style={{ flex: 1, height: 3, background: '#111', borderRadius: 2, opacity: 0.12 }} /><span>{g.tasks.length}</span>
                  </div>
                  {g.tasks.map(t => this.renderTask(t, ui))}
                </section>
              ))}
              {this.state.loaded && !list.length && this.renderEmpty(ui)}
            </div>
            {!mobile && (
              <div style={{ flex: 'none', fontFamily: MONO, fontSize: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <span>N → NEW TASK</span><span>ENTER → ADD</span><span>CLICK → EDIT</span><span>☐ → DONE</span><span>1–4 → VIEWS</span><span>/ → SEARCH</span><span>ESC → CLOSE</span>
              </div>
            )}
          </main>
          {!narrow && this.renderRail(ui)}
        </div>
        {menu && this.renderMenu(ui)}
        {draft && this.renderModal(ui)}
        {this.renderToasts(ui)}
      </div>
    );
  }

  renderHeader({ narrow, mobile, todayStr, c }) {
    const { view, editingName, nameDraft } = this.state;
    const listName = this.state.name || 'My Tasks';
    const iconBtn = { height: 48, width: 48, background: '#fff', border: '3px solid #111', boxShadow: '4px 4px 0 #111', cursor: 'pointer', borderRadius: 14, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 };
    const badge = { today: c.overdue + c.today, upcoming: c.upcoming, all: c.open, done: c.done };
    const viewBtn = ([v, label], i) => (
      <button key={v} onClick={() => this.setView(v)} style={{ height: mobile ? 44 : 42, padding: mobile ? '0 12px' : '0 16px', border: 'none', borderRight: i === VIEWS.length - 1 ? 'none' : '3px solid #111', background: view === v ? '#FFD23F' : '#fff', fontSize: mobile ? 14 : 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', color: '#111', display: 'flex', alignItems: 'center', gap: 8 }}>
        {label}
        {!mobile && <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, minWidth: 22, height: 22, padding: '0 5px', borderRadius: 999, border: '2px solid #111', background: v === 'today' && c.overdue ? '#FF5C5C' : view === v ? '#fff' : '#FFF4E0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{badge[v]}</span>}
      </button>
    );
    return (
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: mobile ? 12 : 16, flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 12 : 16, flexWrap: 'wrap', minWidth: 0 }}>
          <img src={tasksMark} alt="Slab Tasks" title="Slab Tasks" style={{ height: mobile ? 36 : 46, display: 'block' }} />
          {editingName ? (
            <input value={nameDraft} onChange={(e) => this.setState({ nameDraft: e.target.value })} onBlur={this.commitName} autoFocus maxLength={28} placeholder="Name your list"
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') this.setState({ editingName: false }); }}
              style={{ height: 46, width: mobile ? 220 : 280, background: '#fff', border: '3px solid #111', boxShadow: '5px 5px 0 #111', padding: '0 12px', fontFamily: SANS, fontWeight: 800, fontSize: 20, textTransform: 'uppercase', outline: 'none', color: '#111', transform: 'rotate(-2deg)', borderRadius: 14, overflow: 'hidden' }} />
          ) : (
            <button className="h-name" onClick={() => this.setState({ editingName: true, nameDraft: listName })} title="Rename list"
              style={{ background: '#4FD1C5', border: '3px solid #111', boxShadow: '5px 5px 0 #111', padding: '6px 14px', minHeight: 44, fontFamily: SANS, fontWeight: 800, fontSize: mobile ? 18 : 22, letterSpacing: -0.5, transform: 'rotate(-2deg)', cursor: 'pointer', color: '#111', display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase', borderRadius: 14, overflow: 'hidden' }}>
              {listName}<span style={{ fontSize: 15 }}>✎</span>
            </button>
          )}
          <h1 style={{ margin: 0, fontSize: mobile ? 28 : narrow ? 36 : 44, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1, textTransform: 'uppercase' }}>
            {TITLES[view]}
            {view === 'today' && !mobile && <span style={{ marginLeft: 14, fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: 0, verticalAlign: 'middle' }}>{DAYS[parse(todayStr).getDay()]} · {short(parse(todayStr)).toUpperCase()}</span>}
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="h-lift" onClick={() => this.setState(s => ({ searching: !s.searching, query: s.searching ? '' : s.query }), () => this.searchRef.current && this.searchRef.current.focus())} title="Search (/)" aria-label="Search" style={iconBtn}><SearchIcon /></button>
            <button className="h-lift" data-pop-trigger="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); this.setState(s => ({ menu: s.menu ? null : { top: r.bottom + 12, right: Math.max(12, window.innerWidth - r.right) } })); if (desktop) window.slab.getAutoStart().then(v => this.setState({ autoStart: v })); }} title="More" aria-label="More" style={iconBtn}><DotsIcon /></button>
          </div>
          <div style={{ display: 'flex', border: '3px solid #111', boxShadow: '4px 4px 0 #111', background: '#fff', borderRadius: 14, overflow: 'hidden' }}>
            {VIEWS.map(viewBtn)}
          </div>
        </div>
      </header>
    );
  }

  renderQuickAdd({ mobile, todayStr }) {
    const { quick, quickDue, quickDp } = this.state;
    const m = quickDp && quickDp.month;
    const move = (n) => this.setState(s => ({ quickDp: { month: new Date(s.quickDp.month.getFullYear(), s.quickDp.month.getMonth() + n, 1) } }));
    return (
      <div style={{ display: 'flex', gap: 10, flex: 'none', flexWrap: mobile ? 'wrap' : 'nowrap' }}>
        <input ref={this.quickRef} className="f-shadow" value={quick} onChange={(e) => this.setState({ quick: e.target.value })} placeholder="Add a task… (N)" aria-label="New task title" maxLength={200}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) this.openNew(); else this.addQuick(); } if (e.key === 'Escape') e.target.blur(); }}
          style={{ flex: 1, minWidth: 0, height: 52, border: '3px solid #111', background: '#fff', padding: '0 14px', fontFamily: SANS, fontSize: 18, fontWeight: 600, outline: 'none', color: '#111', borderRadius: 14 }} />
        <div ref={this.quickDpRef} style={{ position: 'relative', flex: 'none' }}>
          <button className="h-field" onClick={() => this.setState(s => ({ quickDp: s.quickDp ? null : { month: monthOf(quickDue || todayStr) } }))} aria-label="Due date"
            style={{ height: 52, minWidth: 128, border: '3px solid #111', borderRadius: 14, background: quickDue ? (quickDue < todayStr ? '#FF5C5C' : '#FFF9D6') : '#fff', padding: '0 12px', fontFamily: MONO, fontSize: 13, fontWeight: 700, color: '#111', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>{this.chipDate(quickDue, todayStr)}</span><span>▾</span>
          </button>
          {quickDp && (
            <DatePicker title={MONTHS[m.getMonth()].slice(0, 3) + ' ' + m.getFullYear()} cells={this.gridFor(m)} month={m.getMonth()} order={ORDER} dayLetters={DAYS.map(d => d[0])}
              value={quickDue} min="" todayStr={todayStr} fmt={fmt} onPrev={() => move(-1)} onNext={() => move(1)} onPick={(k) => this.setState({ quickDue: k, quickDp: null })}
              clear={{ label: 'NO DATE', onClick: () => this.setState({ quickDue: '', quickDp: null }) }} align="right" mobile={mobile} />
          )}
        </div>
        <button className="h-save" onClick={this.addQuick} style={{ height: 52, padding: '0 22px', flex: 'none', border: '3px solid #111', background: '#111', color: '#FFF4E0', boxShadow: '4px 4px 0 #FFD23F', fontFamily: 'inherit', fontSize: 16, fontWeight: 800, cursor: 'pointer', textTransform: 'uppercase', borderRadius: 14 }}>Add</button>
      </div>
    );
  }

  renderToolbar({ mobile }, n) {
    const { view, groupBy, meetingId, searching, query, doc } = this.state;
    const meeting = meetingId && (doc.processedMeetings.find(m => m.id === meetingId) || doc.tasks.find(t => t.source && t.source.meetingId === meetingId)?.source);
    const pill = (on) => ({ height: 32, padding: '0 12px', border: 'none', borderRight: '2px solid #111', background: on ? '#111' : '#fff', color: on ? '#FFF4E0' : '#111', fontFamily: MONO, fontSize: 11, fontWeight: 700, cursor: 'pointer' });
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 'none', minHeight: 36 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{n} {n === 1 ? 'TASK' : 'TASKS'}</span>
        {meetingId && (
          <button className="h-clear" onClick={() => this.setState({ meetingId: '' })} title="Show all meetings"
            style={{ height: 32, padding: '0 12px', border: '2px solid #111', borderRadius: 999, background: '#4FD1C5', fontFamily: MONO, fontSize: 11, fontWeight: 700, cursor: 'pointer', color: '#111', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            FROM: {(meeting && meeting.title) || 'Meeting'} ✕
          </button>
        )}
        {searching && (
          <input ref={this.searchRef} value={query} onChange={(e) => this.setState({ query: e.target.value })} placeholder="Search tasks…" aria-label="Search tasks"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); this.setState({ searching: false, query: '' }); } }}
            style={{ height: 36, width: mobile ? '100%' : 260, border: '3px solid #111', borderRadius: 8, background: '#fff', padding: '0 10px', fontFamily: SANS, fontSize: 15, fontWeight: 600, outline: 'none', color: '#111' }} />
        )}
        {view !== 'done' && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 11, fontWeight: 700 }}>GROUP
            <div style={{ display: 'flex', border: '2px solid #111', borderRadius: 999, overflow: 'hidden' }}>
              <button onClick={() => this.setGroup('date')} style={pill(groupBy === 'date')}>DATE</button>
              <button onClick={() => this.setGroup('meeting')} style={{ ...pill(groupBy === 'meeting'), borderRight: 'none' }}>MEETING</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  renderTask(t, { todayStr }) {
    const b = t.done ? 'done' : bucket(t, todayStr), fresh = !!this.state.fresh[t.id];
    const dateBg = b === 'overdue' ? '#FF5C5C' : b === 'today' ? '#FFD23F' : t.color;
    const chip = { height: 22, padding: '0 8px', border: '2px solid #111', borderRadius: 999, fontFamily: MONO, fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', flex: 'none' };
    return (
      <div key={t.id} data-task={t.id} className="h-task" onClick={() => this.openEdit(t)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') this.openEdit(t); if (e.key === ' ') { e.preventDefault(); this.toggle(t); } }}
        style={{ display: 'flex', alignItems: 'stretch', background: '#fff', border: '3px solid #111', borderRadius: 14, boxShadow: fresh ? '4px 4px 0 #4FD1C5' : '4px 4px 0 #111', cursor: 'pointer', minHeight: 64, flex: 'none', overflow: 'hidden', outline: 'none', ...(fresh && { animation: 'pop-in .35s ease-out' }) }}>
        <button className="h-check" role="checkbox" aria-checked={t.done} aria-label={t.done ? 'Mark as not done' : 'Mark as done'} onClick={(e) => { e.stopPropagation(); this.toggle(t); }}
          style={{ width: 60, flex: 'none', border: 'none', borderRight: '3px solid #111', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, border: '3px solid #111', background: t.done ? '#111' : '#fff', color: '#FFD23F', fontSize: 17, fontWeight: 800, lineHeight: '22px', textAlign: 'center' }}>{t.done ? '✓' : ''}</span>
        </button>
        <span style={{ width: 76, flex: 'none', background: t.done ? '#F1E6CF' : dateBg, borderRight: '3px solid #111', padding: '8px 6px', fontFamily: MONO, fontSize: 11, fontWeight: 700, lineHeight: 1.35, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
          {b === 'overdue' && <span style={{ fontSize: 9 }}>LATE</span>}
          <span>{this.chipDate(t.due, todayStr)}</span>
          {t.time && <span>{t.time}</span>}
        </span>
        <span style={{ flex: 1, minWidth: 0, padding: '8px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, opacity: t.done ? 0.55 : 1 }}>
          <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.2, textDecoration: t.done ? 'line-through' : 'none', textDecorationThickness: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
          {t.notes && <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.notes}</span>}
          {(t.source || t.createdBy === 'claude' || fresh) && (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
              {fresh && <span style={{ ...chip, background: '#FFD23F' }}>NEW</span>}
              {t.createdBy === 'claude' && <span style={{ ...chip, background: '#111', color: '#4FD1C5', borderColor: '#111' }}>✦ CLAUDE</span>}
              {t.source && (
                <span className="h-chip" title="Show tasks from this meeting" onClick={(e) => { e.stopPropagation(); this.setState({ meetingId: t.source.meetingId }); }}
                  style={{ ...chip, background: '#FFF4E0', cursor: 'pointer' }}>FROM: {t.source.title || 'Meeting'}{t.source.date ? ' · ' + short(parse(t.source.date)).toUpperCase() : ''}</span>
              )}
            </span>
          )}
        </span>
      </div>
    );
  }

  renderEmpty() {
    const { view, query, meetingId, doc } = this.state;
    const msg = query ? `No tasks match “${query.trim()}”.`
      : meetingId ? 'No tasks from this meeting in this view.'
      : view === 'done' ? 'Nothing finished yet.'
      : view === 'today' ? (doc.tasks.some(t => !t.done) ? 'Nothing due today. Nice.' : 'No tasks yet.')
      : view === 'upcoming' ? 'Nothing scheduled after today.' : 'No open tasks.';
    return (
      <div style={{ border: '3px dashed #111', borderRadius: 14, padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <span style={{ fontSize: 22, fontWeight: 800, textTransform: 'uppercase' }}>{msg}</span>
        {!query && !meetingId && view !== 'done' && (
          <span style={{ fontFamily: MONO, fontSize: 12, maxWidth: 460, lineHeight: 1.5 }}>
            Type above and press Enter, or ask Claude: “make tasks from {view === 'today' ? 'today' : 'this week'}'s meetings”.
          </span>
        )}
      </div>
    );
  }

  renderRail({ c }) {
    const { doc, meetingId } = this.state;
    const tile = (label, n, bg, onClick) => (
      <button className="h-popitem" onClick={onClick} style={{ border: '2px solid #111', borderRadius: 8, background: bg, padding: '8px 10px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: '#111', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{n}</span>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{label}</span>
      </button>
    );
    const meetings = [...doc.processedMeetings].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
    const openFrom = (id) => doc.tasks.filter(t => !t.done && t.source && t.source.meetingId === id).length;
    const card = { background: '#FFF4E0', border: '3px solid #111', borderRadius: 14, boxShadow: '6px 6px 0 #111', overflow: 'hidden', flex: 'none' };
    const head = { padding: '10px 12px', background: '#111', color: '#FFF4E0', fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1 };
    return (
      <aside style={{ width: 300, flex: 'none', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', padding: '2px 10px 12px 2px' }}>
        <div style={card}>
          <div style={head}>OVERVIEW</div>
          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {tile('OVERDUE', c.overdue, c.overdue ? '#FF5C5C' : '#fff', () => this.setView('today'))}
            {tile('DUE TODAY', c.today, '#FFD23F', () => this.setView('today'))}
            {tile('UPCOMING', c.upcoming, '#fff', () => this.setView('upcoming'))}
            {tile('FROM CLAUDE', c.claude, '#4FD1C5', () => { this.setView('all'); this.setGroup('meeting'); })}
          </div>
        </div>
        <div style={card}>
          <div style={head}>FROM MEETINGS</div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!meetings.length && <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5 }}>Meetings Claude has read show up here, with how many tasks were yours.</div>}
            {meetings.map(m => {
              const open = openFrom(m.id), active = meetingId === m.id;
              return (
                <button key={m.id} className="h-popitem" onClick={() => this.setState({ meetingId: active ? '' : m.id, view: open ? this.state.view : 'all' })}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, border: '2px solid #111', borderRadius: 8, background: active ? '#4FD1C5' : '#fff', padding: '6px 8px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: '#111', ...(active && { boxShadow: '3px 3px 0 #111', transform: 'translate(-2px,-2px)' }) }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title || 'Meeting'}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700 }}>{m.count ? m.count + (m.count === 1 ? ' TASK' : ' TASKS') + ' · ' + open + ' OPEN' : 'NOTHING FOR YOU'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ ...card, background: '#fff', boxShadow: '4px 4px 0 #111' }}>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>✦ ASK CLAUDE</span>
            <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>“Make tasks from today’s meetings”</span>
            <span style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.5 }}>Claude reads them in Wispr Flow and adds only the action items that are yours. Already-read meetings are skipped.</span>
          </div>
        </div>
      </aside>
    );
  }

  renderMenu({ mobile, c }) {
    const m = this.state.menu;
    const sw = (label, on, subOn, subOff, onClick) => (
      <button className="h-menuitem" role="switch" aria-checked={on} onClick={onClick} style={{ minHeight: 44, border: '2px solid #111', borderRadius: 8, background: '#fff', padding: '6px 12px', fontFamily: SANS, fontSize: 15, fontWeight: 800, textTransform: 'uppercase', cursor: 'pointer', color: '#111', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{label}<span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, textTransform: 'none' }}>{on ? subOn : subOff}</span></span>
        <span style={{ position: 'relative', flex: 'none', width: 46, height: 28, borderRadius: 999, border: '3px solid #111', background: on ? '#111' : '#fff' }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: on ? '#FFD23F' : '#fff', border: '2px solid #111', transition: 'left .1s' }} />
        </span>
      </button>
    );
    const item = (label, sub, onClick, disabled) => (
      <button className="h-menuitem" onClick={onClick} disabled={disabled} style={{ minHeight: 44, border: '2px solid #111', borderRadius: 8, background: '#fff', padding: '6px 12px', fontFamily: SANS, fontSize: 15, fontWeight: 800, textTransform: 'uppercase', cursor: disabled ? 'not-allowed' : 'pointer', color: '#111', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, opacity: disabled ? 0.5 : 1 }}>
        {label}<span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, textTransform: 'none' }}>{sub}</span>
      </button>
    );
    return (
      <div ref={this.menuRef} style={{ position: 'fixed', zIndex: 45, top: m.top, ...(mobile ? { left: 12, right: 12 } : { right: m.right, width: 280 }), background: '#FFF4E0', border: '3px solid #111', boxShadow: '7px 7px 0 #111', borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>{c.open} OPEN · {c.done} DONE</div>
        {item('New task…', 'With notes, date and colour (Shift+Enter)', this.openNew)}
        {item('Clear done', c.done ? 'Remove ' + c.done + ' finished ' + (c.done === 1 ? 'task' : 'tasks') : 'Nothing to clear', this.clearDone, !c.done)}
        {desktop && item('Copy Claude config', 'MCP server entry for Claude Desktop', this.copyConfig)}
        {desktop && item('Show data file', 'tasks.json, shared with Claude', () => { window.slab.showDataFile(); this.setState({ menu: null }); })}
        {desktop && window.slab.platform === 'win32' && sw('Start with Windows', !!this.state.autoStart, 'On · runs in the tray after sign-in', 'Off · open Slab Tasks yourself', this.toggleAutoStart)}
        {desktop && item('Quit Slab Tasks', 'Closing the window keeps it in the tray; this stops it', () => window.slab.quit())}
      </div>
    );
  }

  renderToasts({ mobile }) {
    const ts = this.state.toasts;
    if (!ts.length) return null;
    return (
      <div style={{ position: 'fixed', zIndex: 70, right: mobile ? 12 : 24, left: mobile ? 12 : 'auto', bottom: mobile ? 12 : 24, display: 'flex', flexDirection: 'column', gap: 10, width: mobile ? 'auto' : 320 }}>
        {ts.map(t => <Toast key={t.id} t={t} onDismiss={() => this.dismiss(t.id)} />)}
      </div>
    );
  }

  renderModal({ mobile, todayStr }) {
    const { draft, dp } = this.state;
    const label = { display: 'flex', flexDirection: 'column', gap: 6, fontFamily: MONO, fontSize: 12, fontWeight: 700, position: 'relative', minWidth: 0 };
    const field = { height: 44, border: '3px solid #111', borderRadius: 8, background: '#fff', padding: '0 10px', fontFamily: MONO, fontSize: 13, fontWeight: 700, color: '#111', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, whiteSpace: 'nowrap', minWidth: 0, width: '100%' };
    const pickBtn = (f, text, disabled) => (
      <button className="h-field" disabled={disabled} onClick={(e) => { e.stopPropagation(); this.setState(s => ({ dp: s.dp && s.dp.field === f ? null : { field: f, month: monthOf(draft.due || todayStr) } })); }} style={{ ...field, ...(disabled && { cursor: 'not-allowed', opacity: 0.5 }) }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span><span>▾</span>
      </button>
    );
    const m = dp && dp.month;
    const move = (n) => this.setState(s => ({ dp: { ...s.dp, month: new Date(m.getFullYear(), m.getMonth() + n, 1) } }));
    const src = draft.source;
    return (
      <div onClick={this.closeForm} style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,17,0.55)', display: 'flex', padding: mobile ? 10 : 20, zIndex: 50, overflowY: 'auto' }}>
        <div onClick={(e) => { e.stopPropagation(); if (dp) this.setState({ dp: null }); }} style={{ margin: 'auto', flex: 'none', width: '100%', maxWidth: 520, background: '#FFF4E0', border: '3px solid #111', boxShadow: '10px 10px 0 #111', borderRadius: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: draft.color, borderBottom: '3px solid #111', borderRadius: '11px 11px 0 0' }}>
            <div style={{ fontWeight: 800, fontSize: 22, textTransform: 'uppercase' }}>{draft.id ? 'Edit task' : 'New task'}</div>
            <button className="h-modalx" onClick={this.closeForm} style={{ width: mobile ? 44 : 36, height: mobile ? 44 : 36, border: '3px solid #111', background: '#fff', fontWeight: 800, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit', borderRadius: 14, overflow: 'hidden' }}>✕</button>
          </div>
          <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={label}>TITLE
              <input className="f-shadow" value={draft.title} onChange={(e) => this.setDraft({ title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') this.save(); }} autoFocus placeholder="What needs doing?" maxLength={200}
                style={{ height: 48, border: '3px solid #111', background: '#fff', padding: '0 12px', fontFamily: SANS, fontSize: 18, fontWeight: 600, outline: 'none', color: '#111', borderRadius: 14, overflow: 'hidden' }} />
            </label>
            <label style={label}>NOTES
              <textarea className="f-shadow" value={draft.notes} onChange={(e) => this.setDraft({ notes: e.target.value })} placeholder="Context, links, who asked…" rows={4} maxLength={4000}
                style={{ border: '3px solid #111', background: '#fff', padding: '10px 12px', fontFamily: SANS, fontSize: 15, fontWeight: 500, lineHeight: 1.4, outline: 'none', color: '#111', borderRadius: 14, resize: 'vertical', minHeight: 90 }} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
              <div style={label}>DUE
                {pickBtn('due', draft.due ? (mobile ? short(parse(draft.due)) : fmtLong(draft.due)) : 'No date')}
                {dp && dp.field === 'due' && (
                  <DatePicker title={MONTHS[m.getMonth()].slice(0, 3) + ' ' + m.getFullYear()} cells={this.gridFor(m)} month={m.getMonth()} order={ORDER} dayLetters={DAYS.map(d => d[0])}
                    value={draft.due} min="" todayStr={todayStr} fmt={fmt} onPrev={() => move(-1)} onNext={() => move(1)} onPick={(k) => this.setState(s => ({ dp: null, draft: { ...s.draft, due: k } }))}
                    clear={{ label: 'NO DATE', onClick: () => this.setState(s => ({ dp: null, draft: { ...s.draft, due: '', time: '' } })) }} align="left" mobile={mobile} />
                )}
              </div>
              <div style={label}>TIME
                {pickBtn('time', draft.due ? (draft.time || 'Any time') : 'Pick a date first', !draft.due)}
                {dp && dp.field === 'time' && <TimePicker slots={TIME_SLOTS} value={draft.time} onPick={(t) => this.setState(s => ({ dp: null, draft: { ...s.draft, time: t } }))} align="right" mobile={mobile} />}
              </div>
            </div>
            <div style={label}>COLOR
              <div style={{ display: 'flex', gap: 6, padding: 6, background: '#fff', border: '3px solid #111', borderRadius: 14, boxShadow: '4px 4px 0 #111' }}>
                {COLORS.map((col, i) => { const sel = draft.color === col; return (
                  <button key={col} className="h-swatch" onClick={() => this.setDraft({ color: col })} title={COLOR_NAMES[i]}
                    style={{ flex: 1, minWidth: 0, height: mobile ? 44 : 40, background: col, border: sel ? '3px solid #111' : '2px solid #111', borderRadius: 9, transform: sel ? 'translateY(-3px)' : 'none', boxShadow: sel ? '0 4px 0 #111' : 'none', cursor: 'pointer', fontSize: 16, fontWeight: 800, color: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .08s', padding: 0 }}>{sel ? '✓' : ''}</button>
                ); })}
              </div>
            </div>
            {(src || draft.createdBy === 'claude') && (
              <div style={{ display: 'flex', alignItems: 'stretch', border: '2px solid #111', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
                <span style={{ width: 64, flex: 'none', background: '#4FD1C5', borderRight: '2px solid #111', fontFamily: MONO, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✦</span>
                <span style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{draft.createdBy === 'claude' ? 'ADDED BY CLAUDE' : 'FROM MEETING'}</span>
                  {src && <span style={{ fontSize: 15, fontWeight: 700 }}>{src.title || 'Meeting'}{src.date ? ' · ' + fmtLong(src.date) : ''}</span>}
                </span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '0 16px 18px' }}>
            <div style={{ display: 'flex', gap: 10 }}>
              {draft.id && <button className="h-delete" onClick={this.remove} style={{ height: 48, padding: '0 16px', border: '3px solid #111', background: '#fff', fontFamily: 'inherit', fontSize: 15, fontWeight: 800, cursor: 'pointer', textTransform: 'uppercase', color: '#111', borderRadius: 14, overflow: 'hidden' }}>Delete</button>}
              {draft.id && (
                <button className="h-yellow" onClick={() => this.setDraft(d => ({ done: !d.done }))} role="switch" aria-checked={draft.done}
                  style={{ height: 48, padding: '0 14px', border: '3px solid #111', background: draft.done ? '#7CE38B' : '#fff', fontFamily: 'inherit', fontSize: 15, fontWeight: 800, cursor: 'pointer', textTransform: 'uppercase', color: '#111', borderRadius: 14, overflow: 'hidden' }}>{draft.done ? '✓ Done' : 'Mark done'}</button>
              )}
            </div>
            <button className="h-save" onClick={this.save} style={{ height: 48, padding: '0 24px', border: '3px solid #111', background: '#111', color: '#FFF4E0', boxShadow: '4px 4px 0 #FFD23F', fontFamily: 'inherit', fontSize: 16, fontWeight: 800, cursor: 'pointer', textTransform: 'uppercase', borderRadius: 14, overflow: 'hidden' }}>Save</button>
          </div>
        </div>
      </div>
    );
  }
}
