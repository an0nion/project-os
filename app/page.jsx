/**
 * Dashboard — home page
 *
 * Shows:
 *   - Inbox capture bar (URL or text)
 *   - Projects grouped by: Life & Study | Tech & Learning | Creative
 *   - research_apps: open count + nearest deadline
 *   - All other projects: inbox item count
 */

'use client';

import { useEffect, useState } from 'react';

export default function Dashboard() {
  const [groups,      setGroups]      = useState([]);   // [{ key, label, projects[] }]
  const [projectData, setProjectData] = useState({});
  const [inboxValue,  setInboxValue]  = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [lastResult,  setLastResult]  = useState(null);

  // Pre-fill from PWA share target or Slack bot link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('url'))    setInboxValue(params.get('url'));
    if (params.get('text'))   setInboxValue(params.get('text'));
    if (params.get('inbox'))  setInboxValue(decodeURIComponent(params.get('inbox')));
  }, []);

  // Load project list, group it, then fetch per-project summaries
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(({ projects, groups: groupDefs }) => {
        // Build grouped structure
        const grouped = (groupDefs ?? []).map(g => ({
          ...g,
          projects: (projects ?? []).filter(p => p.group === g.key),
        }));
        setGroups(grouped);

        // Fetch summary data for every project
        (projects ?? []).forEach(async p => {
          const res  = await fetch(`/api/projects/${p.key}`);
          const data = await res.json();
          setProjectData(prev => ({ ...prev, [p.key]: data }));
        });
      });
  }, []);

  async function handleCapture(e) {
    e.preventDefault();
    if (!inboxValue.trim()) return;

    setSubmitting(true);
    setLastResult(null);

    const isUrl = inboxValue.startsWith('http');
    try {
      const res  = await fetch('/api/inbox', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          url:    isUrl ? inboxValue : undefined,
          text:   isUrl ? undefined  : inboxValue,
          source: 'web',
        }),
      });
      const data = await res.json();
      setLastResult(data);
      setInboxValue('');

      // Refresh the project that received the item
      if (data.project) {
        const res2  = await fetch(`/api/projects/${data.project}`);
        const data2 = await res2.json();
        setProjectData(prev => ({ ...prev, [data.project]: data2 }));
      }
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
          placeholder="Paste a URL, link, or type something to capture…"
          value={inboxValue}
          onChange={e => setInboxValue(e.target.value)}
          autoFocus
        />
        <button style={styles.captureBtn} type="submit" disabled={submitting}>
          {submitting ? '…' : '→'}
        </button>
      </form>

      {lastResult && (
        <div style={lastResult.error ? styles.errorBanner : styles.successBanner}>
          {lastResult.error
            ? `⚠️ ${lastResult.error}`
            : `✅ → ${lastResult.projectLabel}${lastResult.summary ? ` — ${lastResult.summary}` : ''}`
          }
        </div>
      )}

      {/* ── Grouped project tiles ─────────────────────────────────────── */}
      {groups.map(group => (
        <section key={group.key} style={styles.section}>
          <h2 style={styles.groupHeading}>{group.label}</h2>
          <div style={styles.grid}>
            {group.projects.map(p => (
              <ProjectTile
                key={p.key}
                project={p}
                data={projectData[p.key]}
              />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function ProjectTile({ project: p, data }) {
  if (p.key === 'research_apps') {
    const apps     = data?.applications ?? [];
    const open     = apps.filter(a => a.status !== 'submitted').length;
    const next     = apps
      .filter(a => a.deadline && a.status !== 'submitted')
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];
    const daysLeft = next
      ? Math.ceil((new Date(next.deadline) - new Date()) / 86_400_000)
      : null;

    return (
      <a href={`/project/${p.key}`} style={{ ...styles.tile, borderColor: p.color }}>
        <div style={styles.tileEmoji}>{p.emoji}</div>
        <div style={styles.tileLabel}>{p.label}</div>
        <div style={styles.tileCount}>{open} open</div>
        {daysLeft !== null && (
          <div style={{ ...styles.tileDeadline, color: daysLeft <= 3 ? '#ff6b6b' : '#a0a8b8' }}>
            {daysLeft <= 0 ? '🔴 Due today' : `📅 ${daysLeft}d — ${next.org}`}
          </div>
        )}
      </a>
    );
  }

  const count = data == null ? '…' : (data.inboxCount ?? 0);
  return (
    <a href={`/project/${p.key}`} style={{ ...styles.tile, borderColor: p.color }}>
      <div style={styles.tileEmoji}>{p.emoji}</div>
      <div style={styles.tileLabel}>{p.label}</div>
      <div style={styles.tileCount}>
        {count === '…' ? '…' : `${count} item${count !== 1 ? 's' : ''}`}
      </div>
    </a>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  main: {
    maxWidth:  720,
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
    flex:         1,
    padding:      '0.7rem 1rem',
    borderRadius: 8,
    border:       '1px solid #2a2d38',
    background:   '#12141a',
    color:        '#e8eaf0',
    fontSize:     '0.95rem',
    outline:      'none',
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
  section: {
    marginTop: '1.8rem',
  },
  groupHeading: {
    fontSize:     '0.75rem',
    fontWeight:   600,
    color:        '#6b7280',
    textTransform:'uppercase',
    letterSpacing:'0.08em',
    marginBottom: '0.75rem',
  },
  grid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap:                 '0.75rem',
  },
  tile: {
    display:        'block',
    padding:        '0.9rem',
    borderRadius:   10,
    border:         '1.5px solid',
    background:     '#12141a',
    textDecoration: 'none',
    color:          'inherit',
  },
  tileEmoji: {
    fontSize:     '1.3rem',
    marginBottom: '0.35rem',
  },
  tileLabel: {
    fontWeight:   600,
    fontSize:     '0.88rem',
    marginBottom: '0.25rem',
    color:        '#e8eaf0',
  },
  tileCount: {
    fontSize: '0.8rem',
    color:    '#a0a8b8',
  },
  tileDeadline: {
    fontSize:  '0.75rem',
    marginTop: '0.25rem',
  },
};
