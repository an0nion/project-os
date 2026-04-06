/**
 * Dashboard — home page
 *
 * Shows:
 *   - Inbox capture bar (URL or text)
 *   - Project tiles with task counts + nearest deadline
 *   - Recent activity
 *
 * All data fetching is client-side for simplicity (this is a personal app
 * with ~3 users/day; no need for server components / caching complexity).
 */

'use client';

import { useEffect, useState } from 'react';

const PROJECTS = [
  { key: 'research_apps', label: '🔬 Research Apps', color: '#6b8aed' },
  { key: 'learning',      label: '📚 Learning',      color: '#4db88a' },
  { key: 'baking',        label: '🍞 Baking',         color: '#e8994a' },
  { key: 'ideas',         label: '💡 Ideas',          color: '#c47be0' },
];

export default function Dashboard() {
  const [projectData, setProjectData]   = useState({});
  const [inboxText,   setInboxText]     = useState('');
  const [inboxUrl,    setInboxUrl]      = useState('');
  const [submitting,  setSubmitting]    = useState(false);
  const [lastResult,  setLastResult]    = useState(null);

  // Pre-fill from PWA share target or Slack bot link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('url'))  setInboxUrl(params.get('url'));
    if (params.get('text')) setInboxText(params.get('text'));
    if (params.get('inbox')) {
      const decoded = decodeURIComponent(params.get('inbox'));
      if (decoded.startsWith('http')) setInboxUrl(decoded);
      else setInboxText(decoded);
    }
  }, []);

  // Load project summaries
  useEffect(() => {
    PROJECTS.forEach(async p => {
      const res  = await fetch(`/api/projects/${p.key}`);
      const data = await res.json();
      setProjectData(prev => ({ ...prev, [p.key]: data }));
    });
  }, []);

  async function handleCapture(e) {
    e.preventDefault();
    if (!inboxText && !inboxUrl) return;

    setSubmitting(true);
    setLastResult(null);

    try {
      const res  = await fetch('/api/inbox', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: inboxUrl || undefined, text: inboxText || undefined, source: 'web' }),
      });
      const data = await res.json();
      setLastResult(data);
      setInboxText('');
      setInboxUrl('');

      // Refresh the project that got the new item
      const res2  = await fetch(`/api/projects/${data.project}`);
      const data2 = await res2.json();
      setProjectData(prev => ({ ...prev, [data.project]: data2 }));
    } catch (err) {
      setLastResult({ error: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Project OS</h1>

      {/* ── Inbox capture bar ─────────────────────────────────────────── */}
      <form onSubmit={handleCapture} style={styles.inboxForm}>
        <input
          style={styles.input}
          type="text"
          placeholder="Paste a URL or type something…"
          value={inboxUrl || inboxText}
          onChange={e => {
            const v = e.target.value;
            if (v.startsWith('http')) { setInboxUrl(v); setInboxText(''); }
            else                      { setInboxText(v); setInboxUrl(''); }
          }}
        />
        <button style={styles.captureBtn} type="submit" disabled={submitting}>
          {submitting ? '…' : '→'}
        </button>
      </form>

      {lastResult && (
        <div style={lastResult.error ? styles.errorBanner : styles.successBanner}>
          {lastResult.error
            ? `⚠️ ${lastResult.error}`
            : `✅ Routed to ${lastResult.projectLabel} — ${lastResult.questionsCount ?? 0} questions extracted`
          }
          {lastResult.error === 'scrape_failed' && (
            <a href={`/?project=${lastResult.project}`} style={styles.pasteLink}>
              {' '}Paste questions manually →
            </a>
          )}
        </div>
      )}

      {/* ── Project tiles ──────────────────────────────────────────────── */}
      <div style={styles.grid}>
        {PROJECTS.map(p => {
          const d    = projectData[p.key];
          const apps = d?.applications ?? [];
          const open = apps.filter(a => a.status !== 'submitted').length;
          const next = apps
            .filter(a => a.deadline && a.status !== 'submitted')
            .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];

          const daysLeft = next
            ? Math.ceil((new Date(next.deadline) - new Date()) / 86_400_000)
            : null;

          return (
            <a key={p.key} href={`/project/${p.key}`} style={{ ...styles.tile, borderColor: p.color }}>
              <div style={styles.tileLabel}>{p.label}</div>
              <div style={styles.tileCount}>{open} open</div>
              {daysLeft !== null && (
                <div style={{ ...styles.tileDeadline, color: daysLeft <= 3 ? '#ff6b6b' : '#a0a8b8' }}>
                  {daysLeft <= 0 ? '🔴 Due today' : `📅 ${daysLeft}d — ${next.org}`}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </main>
  );
}

// ── Minimal inline styles (plain HTML/CSS only per project rules) ─────────────
const styles = {
  main: {
    maxWidth:  700,
    margin:    '0 auto',
    padding:   '2rem 1rem',
  },
  heading: {
    fontSize:     '1.6rem',
    fontWeight:   700,
    marginBottom: '1.5rem',
    color:        '#e8eaf0',
  },
  inboxForm: {
    display:      'flex',
    gap:          '0.5rem',
    marginBottom: '1rem',
  },
  input: {
    flex:            1,
    padding:         '0.7rem 1rem',
    borderRadius:    8,
    border:          '1px solid #2a2d38',
    background:      '#12141a',
    color:           '#e8eaf0',
    fontSize:        '0.95rem',
    outline:         'none',
  },
  captureBtn: {
    padding:      '0.7rem 1.2rem',
    borderRadius: 8,
    border:       'none',
    background:   '#6b8aed',
    color:        '#fff',
    fontWeight:   600,
    cursor:       'pointer',
    fontSize:     '1.1rem',
  },
  successBanner: {
    padding:      '0.6rem 1rem',
    borderRadius: 6,
    background:   '#1a2b1a',
    color:        '#4db88a',
    marginBottom: '1.2rem',
    fontSize:     '0.9rem',
  },
  errorBanner: {
    padding:      '0.6rem 1rem',
    borderRadius: 6,
    background:   '#2b1a1a',
    color:        '#ff6b6b',
    marginBottom: '1.2rem',
    fontSize:     '0.9rem',
  },
  pasteLink: {
    color:          '#6b8aed',
    textDecoration: 'underline',
  },
  grid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap:                 '1rem',
    marginTop:           '1.5rem',
  },
  tile: {
    display:       'block',
    padding:       '1rem',
    borderRadius:  10,
    border:        '1.5px solid',
    background:    '#12141a',
    textDecoration:'none',
    color:         'inherit',
    transition:    'background 0.15s',
  },
  tileLabel: {
    fontWeight:   600,
    fontSize:     '0.95rem',
    marginBottom: '0.4rem',
  },
  tileCount: {
    fontSize: '0.85rem',
    color:    '#a0a8b8',
  },
  tileDeadline: {
    fontSize:  '0.8rem',
    marginTop: '0.4rem',
  },
};
