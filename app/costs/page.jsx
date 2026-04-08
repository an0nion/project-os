/**
 * /costs — API spend dashboard
 * Shows total, by model, by project, by day.
 */

'use client';

import { useEffect, useState } from 'react';

const fmt  = n => `$${Number(n).toFixed(4)}`;
const fmtc = n => `$${Number(n).toFixed(6)}`;

function Section({ title, children }) {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ left, sub, right, dim }) {
  return (
    <div style={s.row}>
      <div>
        <div style={s.rowLabel}>{left}</div>
        {sub && <div style={s.rowSub}>{sub}</div>}
      </div>
      <div style={{ ...s.rowRight, color: dim ? '#555' : '#e8eaf0' }}>{right}</div>
    </div>
  );
}

export default function CostsPage() {
  const [period, setPeriod]   = useState('month');
  const [data,   setData]     = useState(null);
  const [loading,setLoading]  = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/costs?period=${period}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); });
  }, [period]);

  const byModel   = data ? Object.entries(data.byTier ?? {}) : [];
  const byProject = data ? Object.entries(data.byProject ?? {}).sort((a,b) => b[1]-a[1]) : [];

  // Group recent rows by day
  const byDay = data?.recent
    ? Object.entries(
        data.recent.reduce((acc, r) => {
          const day = r.at?.slice(0, 10) ?? 'unknown';
          if (!acc[day]) acc[day] = { calls: 0, cost: 0 };
          acc[day].calls++;
          acc[day].cost += r.cost ?? 0;
          return acc;
        }, {})
      ).sort((a, b) => b[0].localeCompare(a[0]))
    : [];

  // Group recent rows by model
  const modelRows = data?.recent
    ? Object.entries(
        data.recent.reduce((acc, r) => {
          const k = r.model ?? r.provider ?? 'unknown';
          if (!acc[k]) acc[k] = { model: k, provider: r.provider, calls: 0, cost: 0, cached: 0 };
          acc[k].calls++;
          acc[k].cost   += r.cost ?? 0;
          if (r.cached) acc[k].cached++;
          return acc;
        }, {})
      ).sort((a, b) => b[1].cost - a[1].cost).map(([,v]) => v)
    : [];

  return (
    <main style={s.main}>
      <a href="/" style={s.back}>← Dashboard</a>

      {/* ── Total ─────────────────────────────────────────────────── */}
      <div style={s.hero}>
        <div style={s.heroLabel}>Total spend</div>
        <div style={s.heroAmount}>{data ? fmt(data.total) : '—'}</div>
        <div style={s.tabs}>
          {['today','week','month'].map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{ ...s.tab, ...(period === p ? s.tabActive : {}) }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={s.dim}>loading…</div>}

      {!loading && data && (
        <>
          {/* ── By model ────────────────────────────────────────────── */}
          <Section title="By model">
            {modelRows.length === 0
              ? <div style={s.empty}>no data</div>
              : modelRows.map(m => (
                <Row
                  key={m.model}
                  left={m.model}
                  sub={`${m.calls} calls${m.cached ? ` · ${m.cached} cached` : ''}`}
                  right={fmtc(m.cost)}
                  dim={m.cost === 0}
                />
              ))
            }
          </Section>

          {/* ── By project ──────────────────────────────────────────── */}
          <Section title="By project">
            {byProject.length === 0
              ? <div style={s.empty}>no data</div>
              : byProject.map(([proj, cost]) => (
                <Row
                  key={proj}
                  left={proj === 'unknown' ? '(no project)' : proj.replace(/_/g, ' ')}
                  right={fmtc(cost)}
                  dim={cost === 0}
                />
              ))
            }
          </Section>

          {/* ── By day ──────────────────────────────────────────────── */}
          <Section title="By day">
            {byDay.length === 0
              ? <div style={s.empty}>no data</div>
              : byDay.map(([day, { calls, cost }]) => (
                <Row
                  key={day}
                  left={day}
                  sub={`${calls} call${calls !== 1 ? 's' : ''}`}
                  right={fmtc(cost)}
                  dim={cost === 0}
                />
              ))
            }
          </Section>

          {/* ── Provider split ───────────────────────────────────────── */}
          {Object.keys(data.byProvider ?? {}).length > 0 && (
            <Section title="By provider">
              {Object.entries(data.byProvider).sort((a,b) => b[1]-a[1]).map(([prov, cost]) => (
                <Row key={prov} left={prov} right={fmtc(cost)} dim={cost === 0} />
              ))}
            </Section>
          )}
        </>
      )}
    </main>
  );
}

const s = {
  main:        { maxWidth: 520, margin: '0 auto', padding: '1.5rem 1rem 4rem' },
  back:        { color: '#6b8aed', textDecoration: 'none', fontSize: '0.88rem' },

  hero:        { textAlign: 'center', padding: '2rem 0 1.5rem' },
  heroLabel:   { fontSize: '0.78rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.3rem' },
  heroAmount:  { fontSize: '2.4rem', fontWeight: 700, color: '#e8eaf0', fontVariantNumeric: 'tabular-nums' },

  tabs:        { display: 'flex', justifyContent: 'center', gap: '0.4rem', marginTop: '1rem' },
  tab:         { padding: '0.3rem 0.8rem', borderRadius: 6, border: '1px solid #2a2d38', background: 'transparent', color: '#555', fontSize: '0.8rem', cursor: 'pointer' },
  tabActive:   { borderColor: '#6b8aed', color: '#6b8aed', background: '#0e1220' },

  section:     { marginTop: '1.8rem' },
  sectionTitle:{ fontSize: '0.72rem', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem' },

  row:         { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.55rem 0', borderBottom: '1px solid #12141a' },
  rowLabel:    { fontSize: '0.88rem', color: '#c8cad8' },
  rowSub:      { fontSize: '0.72rem', color: '#555', marginTop: '0.1rem' },
  rowRight:    { fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' },

  empty:       { fontSize: '0.82rem', color: '#333', padding: '0.5rem 0' },
  dim:         { color: '#444', fontSize: '0.85rem', marginTop: '2rem', textAlign: 'center' },
};
