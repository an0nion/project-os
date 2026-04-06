/**
 * Project detail page — /project/:key
 *
 * Shows all applications in the project with:
 *   - Kanban status (backlog → drafting → review → submitted)
 *   - Per-application question list
 *   - Inline chat drafting for each question
 */

'use client';

import { useEffect, useState, useRef } from 'react';

const STATUS_ORDER  = ['backlog', 'drafting', 'review', 'submitted'];
const STATUS_LABELS = { backlog: 'Backlog', drafting: 'Drafting', review: 'Review', submitted: 'Submitted ✓' };
const STATUS_COLORS = { backlog: '#2a2d38', drafting: '#1a2640', review: '#25203a', submitted: '#1a2b1a' };

export default function ProjectPage({ params }) {
  const { key }            = params;
  const [apps, setApps]    = useState([]);
  const [active, setActive]= useState(null); // { appId, questionId }
  const [messages, setMessages]  = useState([]);
  const [draft,    setDraft]     = useState('');
  const [loading,  setLoading]   = useState(false);
  const chatEndRef             = useRef(null);

  useEffect(() => {
    fetch(`/api/projects/${key}`)
      .then(r => r.json())
      .then(d => setApps(d.applications ?? []));
  }, [key]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function openQuestion(appId, questionId, questionText) {
    setActive({ appId, questionId });
    setMessages([
      { role: 'assistant', content: `Let's work on this question:\n\n_"${questionText}"_\n\nWould you like me to draft an answer, or do you want to start with your own draft?` },
    ]);
    setDraft('');
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!draft.trim() || loading) return;

    const newMessages = [...messages, { role: 'user', content: draft }];
    setMessages(newMessages);
    setDraft('');
    setLoading(true);

    try {
      const res  = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          messages:    newMessages,
          appId:       active.appId,
          questionId:  active.questionId,
        }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  }

  async function saveAnswer(questionId, answer) {
    await fetch(`/api/tasks/${questionId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ answer, status: 'drafted' }),
    });
    await refreshApps();
  }

  async function refreshApps() {
    const res  = await fetch(`/api/projects/${key}`);
    const data = await res.json();
    setApps(data.applications ?? []);
  }

  async function updateAppStatus(appId, newStatus) {
    await fetch(`/api/applications/${appId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });
    await refreshApps();
  }

  const grouped = STATUS_ORDER.reduce((acc, s) => {
    acc[s] = apps.filter(a => a.status === s);
    return acc;
  }, {});

  return (
    <main style={styles.main}>
      <a href="/" style={styles.back}>← Dashboard</a>
      <h1 style={styles.heading}>{key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</h1>

      {/* ── Kanban columns ──────────────────────────────────────────────── */}
      <div style={styles.kanban}>
        {STATUS_ORDER.map(status => (
          <div key={status} style={{ ...styles.column, background: STATUS_COLORS[status] }}>
            <div style={styles.columnHeader}>{STATUS_LABELS[status]} ({grouped[status]?.length ?? 0})</div>

            {grouped[status]?.map(app => (
              <div key={app.id} style={styles.card}>
                <div style={styles.cardOrg}>{app.org}</div>
                <div style={styles.cardName}>{app.name}</div>
                {app.deadline && (
                  <div style={styles.cardDeadline}>
                    📅 {new Date(app.deadline).toLocaleDateString()}
                  </div>
                )}
                {/* Status picker — moves card between columns */}
                <select
                  style={styles.statusSelect}
                  value={app.status}
                  onChange={e => updateAppStatus(app.id, e.target.value)}
                >
                  {STATUS_ORDER.map(s => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>

                {/* Questions list */}
                {app.questions?.length > 0 && (
                  <div style={styles.questions}>
                    {app.questions.map(q => (
                      <button
                        key={q.id}
                        style={{
                          ...styles.questionBtn,
                          ...(active?.questionId === q.id ? styles.questionBtnActive : {}),
                          ...(q.status === 'final' || q.answer ? styles.questionBtnDone : {}),
                        }}
                        onClick={() => openQuestion(app.id, q.id, q.text)}
                      >
                        <span style={styles.qStatus}>
                          {q.answer ? '✓' : '○'}
                        </span>
                        {q.text.slice(0, 60)}{q.text.length > 60 ? '…' : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ── Chat panel ───────────────────────────────────────────────────── */}
      {active && (
        <div style={styles.chatPanel}>
          <div style={styles.chatMessages}>
            {messages.map((m, i) => (
              <div key={i} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.aiBubble) }}>
                {m.content}
              </div>
            ))}
            {loading && <div style={styles.aiBubble}>…</div>}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={sendMessage} style={styles.chatForm}>
            <textarea
              style={styles.chatInput}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }}
              placeholder="Message Claude… (Enter to send, Shift+Enter for newline)"
              rows={3}
            />
            <div style={styles.chatActions}>
              <button type="submit" style={styles.sendBtn} disabled={loading}>Send</button>
              {messages.length > 1 && (
                <button
                  type="button"
                  style={styles.saveBtn}
                  onClick={() => {
                    // Extract last assistant message as the answer
                    const lastAI = [...messages].reverse().find(m => m.role === 'assistant');
                    if (lastAI) saveAnswer(active.questionId, lastAI.content);
                  }}
                >
                  Save answer ✓
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

const styles = {
  main:    { maxWidth: 1100, margin: '0 auto', padding: '1.5rem 1rem' },
  back:    { color: '#6b8aed', textDecoration: 'none', fontSize: '0.9rem' },
  heading: { fontSize: '1.4rem', fontWeight: 700, margin: '0.8rem 0 1.2rem', color: '#e8eaf0' },

  kanban: { display: 'flex', gap: '1rem', overflowX: 'auto', paddingBottom: '1rem' },
  column: { minWidth: 220, borderRadius: 10, padding: '0.8rem', flex: '0 0 220px' },
  columnHeader: { fontWeight: 600, fontSize: '0.85rem', color: '#a0a8b8', marginBottom: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' },

  card:    { background: '#12141a', borderRadius: 8, padding: '0.8rem', marginBottom: '0.7rem' },
  cardOrg: { fontSize: '0.75rem', color: '#6b8aed', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  cardName:{ fontSize: '0.9rem', fontWeight: 600, margin: '0.2rem 0', color: '#e8eaf0' },
  cardDeadline: { fontSize: '0.78rem', color: '#a0a8b8' },
  statusSelect: {
    marginTop:   '0.5rem',
    padding:     '0.2rem 0.4rem',
    borderRadius: 5,
    border:      '1px solid #2a2d38',
    background:  '#1a1d28',
    color:       '#a0a8b8',
    fontSize:    '0.75rem',
    cursor:      'pointer',
    width:       '100%',
  },

  questions: { marginTop: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  questionBtn: {
    background:  '#1a1d28', border: '1px solid #2a2d38', borderRadius: 6,
    padding:     '0.4rem 0.6rem', textAlign: 'left', color: '#c8cad8',
    fontSize:    '0.78rem', cursor: 'pointer', display: 'flex', gap: '0.4rem', alignItems: 'flex-start',
  },
  questionBtnActive: { borderColor: '#6b8aed', background: '#1a2040' },
  questionBtnDone:   { borderColor: '#4db88a', color: '#4db88a' },
  qStatus: { flexShrink: 0, fontSize: '0.7rem', marginTop: 2 },

  chatPanel: {
    position:  'fixed', bottom: 0, left: 0, right: 0,
    background:'#12141a', borderTop: '1px solid #2a2d38',
    maxHeight: '45vh', display: 'flex', flexDirection: 'column',
    zIndex:    100,
  },
  chatMessages: { overflowY: 'auto', padding: '1rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  bubble:    { padding: '0.6rem 0.9rem', borderRadius: 10, maxWidth: '85%', fontSize: '0.9rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  userBubble:{ background: '#6b8aed', color: '#fff', alignSelf: 'flex-end' },
  aiBubble:  { background: '#1e2130', color: '#e8eaf0', alignSelf: 'flex-start' },

  chatForm:    { padding: '0.5rem 1rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  chatInput:   { background: '#1a1d28', border: '1px solid #2a2d38', borderRadius: 8, color: '#e8eaf0', padding: '0.6rem 0.8rem', fontSize: '0.9rem', resize: 'none', outline: 'none', fontFamily: 'inherit' },
  chatActions: { display: 'flex', gap: '0.5rem' },
  sendBtn:     { padding: '0.5rem 1.2rem', borderRadius: 7, border: 'none', background: '#6b8aed', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' },
  saveBtn:     { padding: '0.5rem 1rem', borderRadius: 7, border: '1px solid #4db88a', background: 'transparent', color: '#4db88a', cursor: 'pointer', fontSize: '0.9rem' },
};
