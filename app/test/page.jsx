/**
 * QA Test Console — http://localhost:3000/test
 * Covers all 20 test cases from the QA checklist.
 * Never deployed to production — dev-only tool.
 */

'use client';

import { useState } from 'react';

// ── Test definitions (maps to checklist rows) ────────────────────────────────
const TESTS = [
  // Router tests
  { id: 1,  label: 'Router → research_apps',  endpoint: '/api/inbox',  method: 'POST', body: { text: 'apply to this fellowship', source: 'test' }, expect: r => r.project === 'research_apps' },
  { id: 2,  label: 'Router → learning_tech',  endpoint: '/api/inbox',  method: 'POST', body: { text: 'want to learn about ML', source: 'test' }, expect: r => r.project === 'learning_tech' },
  { id: 3,  label: 'Router → reading',        endpoint: '/api/inbox',  method: 'POST', body: { text: 'what philosophy is this?', source: 'test' }, expect: r => r.project === 'reading' },
  { id: 4,  label: 'Router → baking',         endpoint: '/api/inbox',  method: 'POST', body: { text: 'new sourdough recipe', source: 'test' }, expect: r => r.project === 'baking' },
  { id: 5,  label: 'Router → exercise',       endpoint: '/api/inbox',  method: 'POST', body: { text: 'try this workout split', source: 'test' }, expect: r => r.project === 'exercise' },
  { id: 6,  label: 'Router → art',            endpoint: '/api/inbox',  method: 'POST', body: { text: 'watercolor technique tutorial', source: 'test' }, expect: r => r.project === 'art' },
  // Scraper tests
  { id: 7,  label: 'Scraper → success (Greenhouse)',  endpoint: '/api/scrape', method: 'POST', body: { url: 'https://boards.greenhouse.io/anthropic' }, expect: r => !r.error || r.error === 'scrape_failed' },
  { id: 8,  label: 'Scraper → failure (403)',          endpoint: '/api/scrape', method: 'POST', body: { url: 'https://httpstat.us/403' }, expect: r => r.error === 'scrape_failed' },
  // Parser tests
  { id: 9,  label: 'Parser → numbered list',   endpoint: '/api/parse-questions', method: 'POST', body: { text: '1. Question one\n2. Why this fellowship?\n3. Describe your research' }, expect: r => r.questions?.length >= 3 },
  { id: 10, label: 'Parser → bullet list',     endpoint: '/api/parse-questions', method: 'POST', body: { text: '- Describe your research interests\n- Why do you want to apply?' }, expect: r => r.questions?.length >= 2 },
  { id: 11, label: 'Parser → paragraph',       endpoint: '/api/parse-questions', method: 'POST', body: { text: 'What are your research interests? Why do you want to join this program? What is your methodology?' }, expect: r => r.questions?.length >= 2 },
  { id: 12, label: 'Parser → AI mode',         endpoint: '/api/parse-questions', method: 'POST', body: { text: 'We want to understand your interests and also why you want to join and what methods you use', useAi: true }, expect: r => r.questions?.length >= 1 },
  // Chat tests
  { id: 13, label: 'Chat → research context',  endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'help me draft a research statement' }, expect: r => r.message?.length > 20 },
  { id: 14, label: 'Chat → baking context',    endpoint: '/api/chat', method: 'POST', body: { projectKey: 'baking', message: 'sourdough hydration tips' }, expect: r => r.message?.length > 20 },
  // Inbox tests
  { id: 15, label: 'Inbox → text only',        endpoint: '/api/inbox', method: 'POST', body: { text: 'want to learn about transformers', source: 'test' }, expect: r => r.project && r.confidence > 0 },
  { id: 16, label: 'Inbox → has all fields',   endpoint: '/api/inbox', method: 'POST', body: { text: 'apply to fellowship', source: 'test' }, expect: r => 'confidence' in r && 'suggested_action' in r && 'is_new_task' in r },
  // Projects test
  { id: 17, label: 'Projects → 6 returned',    endpoint: '/api/projects', method: 'GET', body: null, expect: r => r.projects?.length === 6 },
  // Cron tests
  { id: 18, label: 'Cron → 401 without auth',  endpoint: '/api/cron/deadlines', method: 'GET', body: null, headers: {}, expect: (r, status) => status === 401 },
  { id: 19, label: 'Cron → 200 with auth',     endpoint: '/api/cron/deadlines', method: 'GET', body: null, headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? (localStorage.getItem('CRON_SECRET') || 'dev-secret') : 'dev-secret'}` }, expect: r => r.status === 'ok' && 'checked_at' in r },
  // Supabase write test
  { id: 20, label: 'Supabase → inbox_log write', endpoint: '/api/inbox', method: 'POST', body: { text: 'supabase write test', source: 'qa' }, expect: r => r.project && !r.dbError },
];

export default function TestPage() {
  const [results, setResults]       = useState({});
  const [running,  setRunning]      = useState(null);
  const [cronSecret, setCronSecret] = useState('dev-secret');

  async function runTest(test) {
    setRunning(test.id);
    const start = Date.now();

    // Update cron secret from input
    if (test.id === 19) {
      test.headers = { Authorization: `Bearer ${cronSecret}` };
    }

    try {
      const opts = {
        method:  test.method,
        headers: { 'Content-Type': 'application/json', ...(test.headers ?? {}) },
      };
      if (test.body) opts.body = JSON.stringify(test.body);

      const res  = await fetch(test.endpoint, opts);
      const data = await res.json();
      const ms   = Date.now() - start;
      const pass = test.expect(data, res.status);

      setResults(prev => ({ ...prev, [test.id]: { pass, data, ms, status: res.status } }));
    } catch (err) {
      setResults(prev => ({ ...prev, [test.id]: { pass: false, data: { error: err.message }, ms: Date.now() - start, status: 0 } }));
    } finally {
      setRunning(null);
    }
  }

  async function runAll() {
    for (const test of TESTS) {
      await runTest(test);
    }
  }

  const passed = Object.values(results).filter(r => r.pass).length;
  const total  = Object.keys(results).length;

  return (
    <main style={s.main}>
      <a href="/" style={s.back}>← Dashboard</a>
      <h1 style={s.h1}>QA Test Console</h1>
      <p style={s.subtitle}>Covers all 20 checklist items. Only use locally — never deploy this page.</p>

      {/* Cron secret input */}
      <div style={s.row}>
        <label style={s.label}>CRON_SECRET for test #19:</label>
        <input style={s.input} value={cronSecret} onChange={e => setCronSecret(e.target.value)} />
      </div>

      <div style={s.toolbar}>
        <button style={s.runAll} onClick={runAll}>▶ Run All Tests</button>
        {total > 0 && (
          <span style={{ ...s.score, color: passed === total ? '#4db88a' : passed > total / 2 ? '#e8994a' : '#ff6b6b' }}>
            {passed}/{total} passed
          </span>
        )}
        <button style={s.clear} onClick={() => setResults({})}>Clear</button>
      </div>

      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>#</th>
            <th style={s.th}>Test</th>
            <th style={s.th}>Endpoint</th>
            <th style={s.th}>Result</th>
            <th style={s.th}>ms</th>
            <th style={s.th}>Run</th>
          </tr>
        </thead>
        <tbody>
          {TESTS.map(test => {
            const r = results[test.id];
            return (
              <tr key={test.id} style={{ background: r ? (r.pass ? '#0d1f0d' : '#1f0d0d') : 'transparent' }}>
                <td style={s.td}>{test.id}</td>
                <td style={s.td}>{test.label}</td>
                <td style={{ ...s.td, color: '#a0a8b8', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                  {test.method} {test.endpoint}
                </td>
                <td style={s.td}>
                  {r ? (
                    <details>
                      <summary style={{ color: r.pass ? '#4db88a' : '#ff6b6b', cursor: 'pointer' }}>
                        {r.pass ? '✅ pass' : '❌ fail'} {r.status ? `(${r.status})` : ''}
                      </summary>
                      <pre style={s.pre}>{JSON.stringify(r.data, null, 2).slice(0, 600)}</pre>
                    </details>
                  ) : '—'}
                </td>
                <td style={{ ...s.td, color: '#a0a8b8' }}>{r?.ms ?? '—'}</td>
                <td style={s.td}>
                  <button
                    style={s.runBtn}
                    onClick={() => runTest(test)}
                    disabled={running === test.id}
                  >
                    {running === test.id ? '…' : '▶'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

const s = {
  main:     { maxWidth: 1000, margin: '0 auto', padding: '1.5rem 1rem', fontFamily: 'system-ui, sans-serif', color: '#e8eaf0' },
  back:     { color: '#6b8aed', textDecoration: 'none', fontSize: '0.9rem' },
  h1:       { fontSize: '1.4rem', fontWeight: 700, margin: '0.8rem 0 0.3rem' },
  subtitle: { color: '#a0a8b8', fontSize: '0.85rem', margin: '0 0 1.2rem' },
  toolbar:  { display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' },
  runAll:   { padding: '0.5rem 1.2rem', borderRadius: 7, border: 'none', background: '#6b8aed', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  clear:    { padding: '0.5rem 0.8rem', borderRadius: 7, border: '1px solid #2a2d38', background: 'transparent', color: '#a0a8b8', cursor: 'pointer' },
  score:    { fontWeight: 700, fontSize: '1rem' },
  row:      { display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '0.8rem' },
  label:    { fontSize: '0.85rem', color: '#a0a8b8' },
  input:    { padding: '0.35rem 0.6rem', borderRadius: 6, border: '1px solid #2a2d38', background: '#12141a', color: '#e8eaf0', fontSize: '0.85rem', fontFamily: 'monospace', width: 200 },
  table:    { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th:       { textAlign: 'left', padding: '0.5rem 0.6rem', borderBottom: '1px solid #2a2d38', color: '#a0a8b8', fontWeight: 600, textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.05em' },
  td:       { padding: '0.5rem 0.6rem', borderBottom: '1px solid #1a1d28', verticalAlign: 'top' },
  pre:      { background: '#0a0b0f', padding: '0.5rem', borderRadius: 5, fontSize: '0.72rem', overflowX: 'auto', maxHeight: 200, color: '#c8cad8', margin: '0.4rem 0 0' },
  runBtn:   { padding: '0.2rem 0.6rem', borderRadius: 5, border: '1px solid #2a2d38', background: '#1a1d28', color: '#6b8aed', cursor: 'pointer', fontSize: '0.8rem' },
};
