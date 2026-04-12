/**
 * QA Test Console — http://localhost:3000/test
 * Covers original 20 checklist items + 9 multi-model tests.
 * Never deploy to production.
 */

'use client';

import { useState } from 'react';
import { classifyTier } from '../../lib/tierClassifier.js';

// ── Original 20 tests ─────────────────────────────────────────────────────────
const ORIGINAL_TESTS = [
  { id: 1,  label: 'Router → research_apps',          endpoint: '/api/inbox',  method: 'POST', body: { text: 'apply to this fellowship', source: 'test' },                                expect: r => r.project === 'research_apps' },
  { id: 2,  label: 'Router → learning_tech',          endpoint: '/api/inbox',  method: 'POST', body: { text: 'want to learn about ML', source: 'test' },                                 expect: r => r.project === 'learning_tech' },
  { id: 3,  label: 'Router → reading',                endpoint: '/api/inbox',  method: 'POST', body: { text: 'what philosophy is this?', source: 'test' },                               expect: r => r.project === 'reading' },
  { id: 4,  label: 'Router → baking',                 endpoint: '/api/inbox',  method: 'POST', body: { text: 'new sourdough recipe', source: 'test' },                                   expect: r => r.project === 'baking' },
  { id: 5,  label: 'Router → exercise',               endpoint: '/api/inbox',  method: 'POST', body: { text: 'try this workout split', source: 'test' },                                 expect: r => r.project === 'exercise' },
  { id: 6,  label: 'Router → art',                    endpoint: '/api/inbox',  method: 'POST', body: { text: 'watercolor technique tutorial', source: 'test' },                          expect: r => r.project === 'art' },
  { id: 7,  label: 'Scraper → returns non-500',       endpoint: '/api/scrape', method: 'POST', body: { url: 'https://boards.greenhouse.io/anthropic' },                                  expect: r => !r.error || r.error === 'scrape_failed' },
  { id: 8,  label: 'Scraper → failure object',        endpoint: '/api/scrape', method: 'POST', body: { url: 'https://httpstat.us/403' },                                                  expect: r => r.error === 'scrape_failed' },
  { id: 9,  label: 'Parser → numbered list',          endpoint: '/api/parse-questions', method: 'POST', body: { text: '1. Question one\n2. Why this fellowship?\n3. Describe your research' }, expect: r => r.questions?.length >= 3 },
  { id: 10, label: 'Parser → bullet list',            endpoint: '/api/parse-questions', method: 'POST', body: { text: '- Describe your research interests\n- Why do you want to apply?' },    expect: r => r.questions?.length >= 2 },
  { id: 11, label: 'Parser → paragraph',              endpoint: '/api/parse-questions', method: 'POST', body: { text: 'What are your research interests? Why do you want to join? What is your methodology?' }, expect: r => r.questions?.length >= 2 },
  { id: 12, label: 'Parser → AI mode',                endpoint: '/api/parse-questions', method: 'POST', body: { text: 'We want to understand your interests and also why you want to join and what methods you use', useAi: true }, expect: r => r.questions?.length >= 1 },
  { id: 13, label: 'Chat → research context',         endpoint: '/api/chat',   method: 'POST', body: { projectKey: 'research_apps', message: 'help me draft a research statement' },      expect: r => (r.message ?? r.reply)?.length > 20 },
  { id: 14, label: 'Chat → baking context',           endpoint: '/api/chat',   method: 'POST', body: { projectKey: 'baking', message: 'sourdough hydration tips' },                       expect: r => (r.message ?? r.reply)?.length > 20 },
  { id: 15, label: 'Inbox → confidence field',        endpoint: '/api/inbox',  method: 'POST', body: { text: 'want to learn about transformers', source: 'test' },                        expect: r => r.project && r.confidence > 0 },
  { id: 16, label: 'Inbox → all routing fields',      endpoint: '/api/inbox',  method: 'POST', body: { text: 'apply to fellowship', source: 'test' },                                    expect: r => 'confidence' in r && 'suggested_action' in r && 'is_new_task' in r },
  { id: 17, label: 'Projects → 6 returned',           endpoint: '/api/projects', method: 'GET', body: null,                                                                               expect: r => r.projects?.length === 6 },
  { id: 18, label: 'Cron → 401 without auth',         endpoint: '/api/cron/deadlines', method: 'GET', body: null, headers: {},                                                            expect: (r, status) => status === 401 },
  { id: 19, label: 'Cron → 200 with auth',            endpoint: '/api/cron/deadlines', method: 'GET', body: null, headers: null, /* set at runtime */                                    expect: r => r.status === 'ok' && 'checked_at' in r },
  { id: 20, label: 'Supabase → inbox_log write',      endpoint: '/api/inbox',  method: 'POST', body: { text: 'supabase write test', source: 'qa' },                                      expect: r => r.project && !r.dbError },
];

// ── 9 multi-model tests ───────────────────────────────────────────────────────
const MODEL_TESTS = [
  { id: 'm1', label: 'Tier 0 — no AI call',               endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'mark task as done' },                        expect: r => r.tier === 0 && r.model === null },
  { id: 'm2', label: 'Tier 1 — Gemini Flash-Lite',        endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'route this to the right project: new recipe' }, expect: r => r.tier === 1 },
  { id: 'm3', label: 'Tier 2 — Sonnet (research_apps)',   endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'draft my research interests answer' },        expect: r => r.tier === 2 && r.model?.includes('sonnet') },
  { id: 'm4', label: 'Tier 3 — Opus (explicit escalate)', endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'help me think through my research direction' }, expect: r => r.tier === 3 && r.model?.includes('opus') },
  { id: 'm5', label: 'Tier 3 — Opus (go deeper)',         endpoint: '/api/chat', method: 'POST', body: { projectKey: 'reading', message: 'go deeper on that last point' },                   expect: r => r.tier === 3 },
  { id: 'm6', label: 'Tier 1 — de-escalate (logistics)',  endpoint: '/api/chat', method: 'POST', body: { projectKey: 'research_apps', message: 'ok add that to my calendar' },               expect: r => r.tier <= 1 },
  { id: 'm7', label: 'Tier 2 — Gemini Pro (learning)',    endpoint: '/api/chat', method: 'POST', body: { projectKey: 'learning_tech', message: 'explain transformer attention mechanisms' },   expect: r => r.tier === 2 && r.model?.includes('gemini') },
  { id: 'm8', label: 'Cost log — entry created',          endpoint: '/api/costs', method: 'GET', body: null,                                                                                  expect: r => 'total' in r && 'byTier' in r },
  { id: 'm9', label: 'Usage returned in chat response',   endpoint: '/api/chat', method: 'POST', body: { projectKey: 'baking', message: 'quick bread recipe' },                              expect: r => r.usage !== undefined && r.cost !== undefined },
];

export default function TestPage() {
  const [results,       setResults]       = useState({});
  const [running,       setRunning]       = useState(null);
  const [cronSecret,    setCronSecret]    = useState('dev-secret');
  const [activeTab,     setActiveTab]     = useState('original'); // 'original' | 'model' | 'tier'
  const [tierInput,     setTierInput]     = useState('');
  const [tierStep,      setTierStep]      = useState(0);
  const [tierEscalated, setTierEscalated] = useState(false);
  const [tierResult,    setTierResult]    = useState(null);

  function runTierClassify() {
    if (!tierInput.trim()) return;
    const result = classifyTier(tierInput, {
      projectKey:  'learning_tech',
      messageCount: tierStep,
      isEscalated:  tierEscalated,
    });
    setTierResult(result);
  }

  const allTests = [...ORIGINAL_TESTS, ...MODEL_TESTS];
  const visibleTests = activeTab === 'original' ? ORIGINAL_TESTS : MODEL_TESTS;

  async function runTest(test) {
    setRunning(test.id);
    const start = Date.now();

    let headers = { 'Content-Type': 'application/json', ...(test.headers ?? {}) };
    if (test.id === 19) headers.Authorization = `Bearer ${cronSecret}`;

    try {
      const opts = { method: test.method, headers };
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

  async function runAll(tests) {
    for (const t of tests) await runTest(t);
  }

  const passed = Object.values(results).filter(r => r.pass).length;
  const total  = Object.keys(results).length;

  return (
    <main style={s.main}>
      <a href="/" style={s.back}>← Dashboard</a>
      <h1 style={s.h1}>QA Test Console</h1>

      {/* Tabs */}
      <div style={s.tabs}>
        {[['original', '20 Original Tests'], ['model', '9 Multi-Model Tests'], ['tier', 'Tier Inspector']].map(([tab, label]) => (
          <button key={tab} style={{ ...s.tab, ...(activeTab === tab ? s.tabActive : {}) }} onClick={() => setActiveTab(tab)}>
            {label}
          </button>
        ))}
      </div>

      {/* Tier Inspector tab */}
      {activeTab === 'tier' && (
        <div style={s.tierPanel}>
          <p style={s.tierHint}>Pure client-side — no API call. Tests the tier classifier logic directly.</p>
          <textarea
            style={s.tierTextarea}
            placeholder="Type a message to classify… e.g. 'help me think through my alignment research'"
            value={tierInput}
            onChange={e => setTierInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTierClassify(); } }}
            rows={3}
          />
          <div style={s.tierControls}>
            <label style={s.label}>
              Step (depth):&nbsp;
              <input type="number" min={0} max={20} style={{ ...s.input, width: 60 }} value={tierStep} onChange={e => setTierStep(+e.target.value)} />
            </label>
            <label style={{ ...s.label, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={tierEscalated} onChange={e => setTierEscalated(e.target.checked)} />
              Sticky Opus (isEscalated)
            </label>
            <button style={s.runAll} onClick={runTierClassify}>Classify</button>
          </div>

          {tierResult && (
            <div style={s.tierResult}>
              <span style={{ ...s.tierBadge, background: tierBadgeBg(tierResult.tier), color: tierBadgeFg(tierResult.tier) }}>
                Tier {tierResult.tier}
              </span>
              <div style={s.inspectorRow}><span style={s.dim}>Primary model</span><strong style={{ fontFamily: 'monospace' }}>{tierResult.primaryModel ?? '(none)'}</strong></div>
              <div style={s.inspectorRow}><span style={s.dim}>Fallback model</span><span style={{ fontFamily: 'monospace', color: '#a0a8b8' }}>{tierResult.fallbackModel ?? '(none)'}</span></div>
              <div style={s.inspectorRow}><span style={s.dim}>Max tokens</span><span>{tierResult.maxTokens}</span></div>
              <div style={s.inspectorRow}><span style={s.dim}>Reason</span><span style={{ color: '#c8cad8', fontSize: '0.82rem' }}>{tierResult.reason}</span></div>
            </div>
          )}

          {/* Quick examples */}
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ ...s.dim, fontSize: '0.78rem', marginBottom: '0.5rem' }}>Quick examples:</div>
            {[
              ['remind me to buy milk', 0, false],
              ['route this to the right project', 0, false],
              ['explain transformer attention mechanisms', 0, false],
              ['help me think through my research direction', 0, false],
              ['go deeper on that last point', 0, false],
              ['but why does this matter for alignment?', 3, false],
              ['tell me more', 9, false],
              ['ok add that to calendar', 0, true],
              ['steelman the opposing view', 0, false],
              ['what is wrong with this framing?', 0, false],
            ].map(([msg, step, esc]) => {
              const r = classifyTier(msg, { projectKey: 'learning_tech', messageCount: step, isEscalated: esc });
              return (
                <div key={msg} style={s.exampleRow} onClick={() => { setTierInput(msg); setTierStep(step); setTierEscalated(esc); setTierResult(r); }}>
                  <span style={{ ...s.tierBadgeSm, background: tierBadgeBg(r.tier), color: tierBadgeFg(r.tier) }}>T{r.tier}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', flex: 1 }}>{msg}</span>
                  <span style={{ ...s.dim, fontSize: '0.72rem' }}>{r.primaryModel ?? 'none'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Controls + table for test tabs */}
      {activeTab !== 'tier' && (<>
      <div style={s.toolbar}>
        <button style={s.runAll} onClick={() => runAll(visibleTests)}>▶ Run {visibleTests.length} Tests</button>
        <button style={s.runAll} onClick={() => runAll(allTests)}>▶▶ Run All 29</button>
        {total > 0 && <span style={{ ...s.score, color: passed === total ? '#4db88a' : passed > total / 2 ? '#e8994a' : '#ff6b6b' }}>{passed}/{total} passed</span>}
        <button style={s.clear} onClick={() => setResults({})}>Clear</button>
        <label style={s.label}>CRON_SECRET:</label>
        <input style={s.input} value={cronSecret} onChange={e => setCronSecret(e.target.value)} />
      </div>

      {/* Test table */}
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
          {visibleTests.map(test => {
            const r = results[test.id];
            return (
              <tr key={test.id} style={{ background: r ? (r.pass ? '#0d1f0d' : '#1f0d0d') : 'transparent' }}>
                <td style={s.td}>{test.id}</td>
                <td style={s.td}>{test.label}</td>
                <td style={{ ...s.td, color: '#a0a8b8', fontFamily: 'monospace', fontSize: '0.78rem' }}>{test.method} {test.endpoint}</td>
                <td style={s.td}>
                  {r ? (
                    <details>
                      <summary style={{ color: r.pass ? '#4db88a' : '#ff6b6b', cursor: 'pointer' }}>
                        {r.pass ? '✅ pass' : '❌ fail'} {r.status ? `(${r.status})` : ''}
                      </summary>
                      <pre style={s.pre}>{JSON.stringify(r.data, null, 2).slice(0, 800)}</pre>
                    </details>
                  ) : '—'}
                </td>
                <td style={{ ...s.td, color: '#a0a8b8' }}>{r?.ms ?? '—'}</td>
                <td style={s.td}>
                  <button style={s.runBtn} onClick={() => runTest(test)} disabled={running === test.id}>
                    {running === test.id ? '…' : '▶'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Model Inspector — shows for multi-model tab */}
      {activeTab === 'model' && (
        <div style={s.inspector}>
          <h2 style={s.inspectorTitle}>Model Inspector</h2>
          <div style={s.inspectorGrid}>
            {MODEL_TESTS.map(test => {
              const r = results[test.id];
              if (!r?.data) return null;
              const d = r.data;
              if (!d.tier && d.tier !== 0) return null;
              return (
                <div key={test.id} style={{ ...s.inspectorCard, borderColor: r.pass ? '#4db88a' : '#ff6b6b' }}>
                  <div style={s.inspectorLabel}>{test.label}</div>
                  <div style={s.inspectorRow}><span style={s.dim}>Tier</span> <strong style={tierColor(d.tier)}>T{d.tier}</strong></div>
                  <div style={s.inspectorRow}><span style={s.dim}>Model</span> <span style={s.mono}>{d.model ?? '(none)'}</span></div>
                  <div style={s.inspectorRow}><span style={s.dim}>Provider</span> <span>{d.provider ?? '—'}</span></div>
                  <div style={s.inspectorRow}><span style={s.dim}>Reason</span> <span style={{ fontSize: '0.75rem', color: '#c8cad8' }}>{d.reason ?? '—'}</span></div>
                  {d.usage && <div style={s.inspectorRow}><span style={s.dim}>Tokens</span> <span>{d.usage.input_tokens}↑ {d.usage.output_tokens}↓</span></div>}
                  {d.cost   && <div style={s.inspectorRow}><span style={s.dim}>Cost</span> <span style={{ color: '#e8994a' }}>${d.cost.totalCost?.toFixed(6)}</span></div>}
                  {d.cached && <div style={{ ...s.inspectorRow, color: '#4db88a' }}>⚡ cached</div>}
                </div>
              );
            }).filter(Boolean)}
          </div>
        </div>
      )}
      </>)}
    </main>
  );
}

function tierColor(tier) {
  return { 0: '#a0a8b8', 1: '#4db88a', 2: '#6b8aed', 3: '#c47be0' }[tier] ?? '#e8eaf0';
}

function tierBadgeBg(tier) {
  return { 0: '#1f2128', 1: '#0d2b1a', 2: '#0d1533', 3: '#2b1a00' }[tier] ?? '#1a1d28';
}
function tierBadgeFg(tier) {
  return { 0: '#a0a8b8', 1: '#4db88a', 2: '#6b8aed', 3: '#e8994a' }[tier] ?? '#e8eaf0';
}

const s = {
  main:          { maxWidth: 1100, margin: '0 auto', padding: '1.5rem 1rem', fontFamily: 'system-ui, sans-serif', color: '#e8eaf0' },
  back:          { color: '#6b8aed', textDecoration: 'none', fontSize: '0.9rem' },
  h1:            { fontSize: '1.4rem', fontWeight: 700, margin: '0.8rem 0 1rem' },
  tabs:          { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
  tab:           { padding: '0.4rem 1rem', borderRadius: 7, border: '1px solid #2a2d38', background: '#12141a', color: '#a0a8b8', cursor: 'pointer', fontSize: '0.85rem' },
  tabActive:     { background: '#1a2040', borderColor: '#6b8aed', color: '#e8eaf0' },
  toolbar:       { display: 'flex', gap: '0.7rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' },
  runAll:        { padding: '0.4rem 1rem', borderRadius: 7, border: 'none', background: '#6b8aed', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' },
  clear:         { padding: '0.4rem 0.8rem', borderRadius: 7, border: '1px solid #2a2d38', background: 'transparent', color: '#a0a8b8', cursor: 'pointer', fontSize: '0.85rem' },
  score:         { fontWeight: 700, fontSize: '1rem' },
  label:         { fontSize: '0.82rem', color: '#a0a8b8' },
  input:         { padding: '0.3rem 0.6rem', borderRadius: 6, border: '1px solid #2a2d38', background: '#12141a', color: '#e8eaf0', fontSize: '0.82rem', fontFamily: 'monospace', width: 180 },
  table:         { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th:            { textAlign: 'left', padding: '0.5rem 0.6rem', borderBottom: '1px solid #2a2d38', color: '#a0a8b8', fontWeight: 600, textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.05em' },
  td:            { padding: '0.5rem 0.6rem', borderBottom: '1px solid #1a1d28', verticalAlign: 'top' },
  pre:           { background: '#0a0b0f', padding: '0.5rem', borderRadius: 5, fontSize: '0.72rem', overflowX: 'auto', maxHeight: 200, color: '#c8cad8', margin: '0.4rem 0 0' },
  runBtn:        { padding: '0.2rem 0.6rem', borderRadius: 5, border: '1px solid #2a2d38', background: '#1a1d28', color: '#6b8aed', cursor: 'pointer', fontSize: '0.8rem' },
  inspector:     { marginTop: '2rem' },
  inspectorTitle:{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.8rem', color: '#a0a8b8' },
  inspectorGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '0.8rem' },
  inspectorCard: { background: '#12141a', borderRadius: 8, padding: '0.8rem', border: '1.5px solid' },
  inspectorLabel:{ fontSize: '0.78rem', fontWeight: 600, color: '#c8cad8', marginBottom: '0.5rem' },
  inspectorRow:  { display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', margin: '0.2rem 0' },
  dim:           { color: '#a0a8b8' },
  mono:          { fontFamily: 'monospace', fontSize: '0.75rem' },
  // Tier Inspector
  tierPanel:     { maxWidth: 700 },
  tierHint:      { color: '#a0a8b8', fontSize: '0.82rem', margin: '0 0 0.8rem' },
  tierTextarea:  { width: '100%', padding: '0.6rem', borderRadius: 7, border: '1px solid #2a2d38', background: '#12141a', color: '#e8eaf0', fontSize: '0.85rem', fontFamily: 'system-ui', resize: 'vertical', boxSizing: 'border-box' },
  tierControls:  { display: 'flex', gap: '1rem', alignItems: 'center', margin: '0.7rem 0' },
  tierResult:    { background: '#12141a', borderRadius: 8, padding: '1rem', border: '1px solid #2a2d38', marginTop: '0.8rem' },
  tierBadge:     { display: 'inline-block', padding: '3px 12px', borderRadius: 6, fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.8rem' },
  tierBadgeSm:   { display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 700, fontSize: '0.72rem', marginRight: 8 },
  exampleRow:    { display: 'flex', alignItems: 'center', padding: '0.35rem 0.5rem', borderRadius: 5, cursor: 'pointer', gap: 8, marginBottom: 3, background: '#0d0f15' },
};
