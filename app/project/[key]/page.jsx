/**
 * Generic project page — /project/:key
 *
 * Renders a Kanban board driven by the project's column config.
 * Works for all project types:
 *   - research_apps: columns Saved/Drafting/Review/Submitted, shows questions count
 *   - school:        columns Todo/In Progress/Submitted, shows due dates prominently
 *   - work:          columns Todo/In Progress/Done
 *   - learning_tech: columns Want to Learn/Doing Now/Done
 *   - creative:      columns Ideas/Making/Done (or similar)
 *
 * Chat panel: opens when a card is clicked, AI aware of project + item context.
 */

'use client';

import { useEffect, useState, useRef } from 'react';

const STATUS_COLORS = {
  // Generic fallback palette
  backlog:   '#1e2130',
  todo:      '#1e2130',
  ideas:     '#1e2130',
  planned:   '#1e2130',
  doing:     '#1c2340',
  active:    '#1c2340',
  building:  '#1c2340',
  creating:  '#1c2340',
  making:    '#1c2340',
  reading:   '#1c2340',
  drafting:  '#1c2340',
  review:    '#2a1e35',
  submitted: '#1a2b1a',
  done:      '#1a2b1a',
};

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / 86_400_000);
}

function DeadlineBadge({ date }) {
  const d = daysUntil(date);
  if (d === null) return null;
  const color = d <= 0 ? '#ff6b6b' : d <= 3 ? '#f59e0b' : '#a0a8b8';
  const label = d <= 0 ? 'Due today' : `${d}d left`;
  return <span style={{ color, fontSize: '0.75rem' }}>📅 {label}</span>;
}

function ItemCard({ item, isActive, accentColor, onSelect, onStatusChange, columns }) {
  const days     = daysUntil(item.due_date);
  const isUrgent = days !== null && days <= 3;

  return (
    <div
      onClick={() => onSelect(item)}
      style={{
        background:   isActive ? '#1e2540' : '#12141a',
        border:       `1.5px solid ${isActive ? accentColor : (isUrgent ? '#f59e0b33' : '#1e2130')}`,
        borderRadius: 8,
        padding:      '0.7rem 0.8rem',
        marginBottom: '0.5rem',
        cursor:       'pointer',
      }}
    >
      {item.subtitle && (
        <div style={{ fontSize: '0.7rem', color: accentColor, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
          {item.subtitle}
        </div>
      )}
      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#e8eaf0', marginBottom: '0.3rem', lineHeight: 1.3 }}>
        {item.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <DeadlineBadge date={item.due_date} />
        {item.extra?.questions?.length > 0 && (
          <span style={{ fontSize: '0.72rem', color: '#a0a8b8' }}>
            ❓ {item.extra.questions.filter(q => !q.answer).length}/{item.extra.questions.length} unanswered
          </span>
        )}
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener noreferrer"
             onClick={e => e.stopPropagation()}
             style={{ fontSize: '0.72rem', color: '#6b8aed' }}>
            ↗ link
          </a>
        )}
      </div>
      <select
        value={item.status}
        onClick={e => e.stopPropagation()}
        onChange={e => onStatusChange(item.id, e.target.value)}
        style={{
          marginTop:    '0.45rem',
          padding:      '0.15rem 0.35rem',
          borderRadius: 5,
          border:       '1px solid #2a2d38',
          background:   '#1a1d28',
          color:        '#a0a8b8',
          fontSize:     '0.72rem',
          cursor:       'pointer',
          width:        '100%',
        }}
      >
        {columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
    </div>
  );
}

export default function ProjectPage({ params }) {
  const { key } = params;

  const [columns,    setColumns]    = useState([]);
  const [grouped,    setGrouped]    = useState({});
  const [projectDef, setProjectDef] = useState(null);
  const [activeItem, setActiveItem] = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [draft,      setDraft]      = useState('');
  const [chatLoading,setChatLoading]= useState(false);
  const [newTitle,   setNewTitle]   = useState('');
  const [addingCol,  setAddingCol]  = useState(null);
  const [expandedCols, setExpandedCols] = useState({});  // collapsed cols the user has expanded
  const chatEndRef = useRef(null);

  // Load project definition + items
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(({ projects }) => {
        const p = (projects ?? []).find(pr => pr.key === key);
        setProjectDef(p ?? null);
      });
    loadItems();
  }, [key]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadItems() {
    const res  = await fetch(`/api/projects/${key}/items`);
    const data = await res.json();
    setColumns(data.columns ?? []);
    setGrouped(data.grouped ?? {});
  }

  async function moveItem(itemId, newStatus) {
    // Optimistic update
    setGrouped(prev => {
      const next = { ...prev };
      for (const col of Object.keys(next)) {
        next[col] = next[col].filter(i => i.id !== itemId);
      }
      const movedItem = Object.values(prev).flat().find(i => i.id === itemId);
      if (movedItem && next[newStatus]) {
        next[newStatus] = [{ ...movedItem, status: newStatus }, ...next[newStatus]];
      }
      return next;
    });

    await fetch(`/api/items/${itemId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });
  }

  async function addQuickItem(colKey) {
    if (!newTitle.trim()) return;
    const res  = await fetch('/api/inbox', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: newTitle.trim(), source: 'web', project: key }),
    });
    const data = await res.json();
    setNewTitle('');
    setAddingCol(null);
    if (data.itemId || data.appId) await loadItems();
  }

  function openChat(item) {
    setActiveItem(item);
    setMessages([{
      role:    'assistant',
      content: `What would you like to do with "${item.title}"?`,
    }]);
    setDraft('');
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!draft.trim() || chatLoading) return;

    const newMessages = [...messages, { role: 'user', content: draft }];
    setMessages(newMessages);
    setDraft('');
    setChatLoading(true);

    try {
      const res  = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          messages:   newMessages,
          projectKey: key,
          // For research_apps with questions, pass questionId context if relevant
          ...(activeItem?.extra?.questions?.length > 0
            ? { appId: activeItem.id }
            : {}),
        }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  const accentColor = projectDef?.color ?? '#6b8aed';

  return (
    <main style={styles.main}>
      <a href="/" style={{ ...styles.back, color: accentColor }}>← Dashboard</a>
      <h1 style={styles.heading}>
        {projectDef?.emoji} {projectDef?.label ?? key.replace(/_/g, ' ')}
      </h1>

      {/* ── Kanban board ──────────────────────────────────────────────── */}
      <div style={styles.kanban}>
        {columns.map(col => {
          const cards      = grouped[col.key] ?? [];
          const isCollapsed = col.collapsed && !expandedCols[col.key];

          // Collapsed done column — slim count bar
          if (isCollapsed) {
            return (
              <button
                key={col.key}
                onClick={() => setExpandedCols(prev => ({ ...prev, [col.key]: true }))}
                style={styles.collapsedCol}
                title={`Show ${cards.length} ${col.label}`}
              >
                <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: '0.75rem', color: '#555', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {col.label}
                </span>
                {cards.length > 0 && (
                  <span style={{ fontSize: '0.72rem', color: '#444', marginTop: '0.4rem' }}>
                    {cards.length}
                  </span>
                )}
              </button>
            );
          }

          return (
            <div key={col.key} style={{ ...styles.column, background: STATUS_COLORS[col.key] ?? '#1e2130' }}>
              <div style={styles.colHeader}>
                <span style={{ color: '#a0a8b8' }}>{col.label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ color: '#555', fontSize: '0.78rem' }}>{cards.length}</span>
                  {col.collapsed && (
                    <button
                      onClick={() => setExpandedCols(prev => ({ ...prev, [col.key]: false }))}
                      style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}
                      title="Collapse"
                    >
                      ←
                    </button>
                  )}
                </div>
              </div>

              {cards.map(item => (
                <ItemCard
                  key={item.id}
                  item={item}
                  isActive={activeItem?.id === item.id}
                  accentColor={accentColor}
                  columns={columns}
                  onSelect={openChat}
                  onStatusChange={moveItem}
                />
              ))}

              {/* Quick-add card */}
              {addingCol === col.key ? (
                <div style={styles.quickAdd}>
                  <input
                    autoFocus
                    style={styles.quickInput}
                    placeholder="Title…"
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addQuickItem(col.key);
                      if (e.key === 'Escape') { setAddingCol(null); setNewTitle(''); }
                    }}
                  />
                  <button onClick={() => addQuickItem(col.key)} style={{ ...styles.addBtn, background: accentColor }}>Add</button>
                  <button onClick={() => { setAddingCol(null); setNewTitle(''); }} style={styles.cancelBtn}>✕</button>
                </div>
              ) : (
                <button onClick={() => setAddingCol(col.key)} style={styles.addCardBtn}>
                  + Add
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Chat panel ───────────────────────────────────────────────── */}
      {activeItem && (
        <div style={styles.chatPanel}>
          <div style={styles.chatHeader}>
            <span style={{ color: accentColor, fontWeight: 600, fontSize: '0.85rem' }}>
              {activeItem.title}
            </span>
            <button onClick={() => setActiveItem(null)} style={styles.closeBtn}>✕</button>
          </div>

          {/* Questions list for research_apps */}
          {activeItem.extra?.questions?.length > 0 && (
            <div style={styles.questionsList}>
              {activeItem.extra.questions.map(q => (
                <div key={q.id} style={{ ...styles.qChip, borderColor: q.answer ? '#4db88a55' : '#2a2d38', color: q.answer ? '#4db88a' : '#a0a8b8' }}>
                  {q.answer ? '✓ ' : '○ '}{q.text.slice(0, 60)}{q.text.length > 60 ? '…' : ''}
                </div>
              ))}
            </div>
          )}

          <div style={styles.chatMessages}>
            {messages.map((m, i) => (
              <div key={i} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.aiBubble) }}>
                {m.content}
              </div>
            ))}
            {chatLoading && <div style={styles.aiBubble}>…</div>}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={sendMessage} style={styles.chatForm}>
            <textarea
              style={styles.chatInput}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }}
              placeholder="Ask Claude about this… (Enter to send)"
              rows={2}
            />
            <button type="submit" style={{ ...styles.sendBtn, background: accentColor }} disabled={chatLoading}>
              Send
            </button>
          </form>
        </div>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  main:    { maxWidth: 1200, margin: '0 auto', padding: '1.5rem 1rem', paddingBottom: '22rem' },
  back:    { textDecoration: 'none', fontSize: '0.88rem' },
  heading: { fontSize: '1.35rem', fontWeight: 700, margin: '0.7rem 0 1.2rem', color: '#e8eaf0' },

  kanban: { display: 'flex', gap: '0.75rem', overflowX: 'auto', paddingBottom: '1rem', alignItems: 'flex-start' },
  column: {
    minWidth: 210, flex: '0 0 210px', borderRadius: 10,
    padding: '0.75rem', display: 'flex', flexDirection: 'column',
  },
  collapsedCol: {
    flex: '0 0 28px', minWidth: 28, borderRadius: 10,
    background: '#0f1118', border: '1px dashed #1e2130',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'flex-start', padding: '0.6rem 0', cursor: 'pointer',
    alignSelf: 'stretch',
  },
  colHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '0.65rem', fontWeight: 600, fontSize: '0.78rem',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  },

  quickAdd:   { display: 'flex', gap: '0.3rem', marginTop: '0.4rem' },
  quickInput: {
    flex: 1, padding: '0.3rem 0.5rem', borderRadius: 6,
    border: '1px solid #2a2d38', background: '#12141a', color: '#e8eaf0',
    fontSize: '0.82rem', outline: 'none',
  },
  addBtn:    { padding: '0.3rem 0.5rem', borderRadius: 6, border: 'none', color: '#fff', fontSize: '0.78rem', cursor: 'pointer' },
  cancelBtn: { padding: '0.3rem 0.4rem', borderRadius: 6, border: '1px solid #2a2d38', background: 'transparent', color: '#666', fontSize: '0.78rem', cursor: 'pointer' },
  addCardBtn: {
    marginTop: '0.4rem', padding: '0.35rem', width: '100%', borderRadius: 6,
    border: '1px dashed #2a2d38', background: 'transparent', color: '#555',
    fontSize: '0.78rem', cursor: 'pointer', textAlign: 'center',
  },

  chatPanel: {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    background: '#0d0f14', borderTop: '1px solid #1e2130',
    maxHeight: '48vh', display: 'flex', flexDirection: 'column', zIndex: 100,
  },
  chatHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0.5rem 1rem', borderBottom: '1px solid #1e2130',
  },
  closeBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '1rem' },

  questionsList: {
    display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
    padding: '0.4rem 1rem', borderBottom: '1px solid #1e2130',
  },
  qChip: {
    padding: '0.2rem 0.5rem', borderRadius: 5, border: '1px solid',
    fontSize: '0.72rem', cursor: 'default',
  },

  chatMessages: { overflowY: 'auto', padding: '0.7rem 1rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  bubble:       { padding: '0.55rem 0.85rem', borderRadius: 10, maxWidth: '85%', fontSize: '0.88rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  userBubble:   { background: '#6b8aed', color: '#fff', alignSelf: 'flex-end' },
  aiBubble:     { background: '#1e2130', color: '#e8eaf0', alignSelf: 'flex-start' },

  chatForm:  { padding: '0.5rem 1rem 0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' },
  chatInput: {
    flex: 1, background: '#1a1d28', border: '1px solid #2a2d38', borderRadius: 8,
    color: '#e8eaf0', padding: '0.5rem 0.75rem', fontSize: '0.88rem',
    resize: 'none', outline: 'none', fontFamily: 'inherit',
  },
  sendBtn: { padding: '0.5rem 1rem', borderRadius: 7, border: 'none', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.88rem', whiteSpace: 'nowrap' },
};
