'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const router       = useRouter();
  const searchParams = useSearchParams();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });

    if (res.ok) {
      const next = searchParams.get('next') || '/';
      router.push(next);
    } else {
      setError('Wrong password');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{
      background: '#111', border: '1px solid #222', borderRadius: 12,
      padding: '2.5rem', display: 'flex', flexDirection: 'column',
      gap: '1rem', width: 320,
    }}>
      <h1 style={{ color: '#fff', margin: 0, fontSize: '1.2rem', fontWeight: 600 }}>
        Project OS
      </h1>
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        autoFocus
        style={{
          background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
          padding: '0.75rem 1rem', color: '#fff', fontSize: '1rem', outline: 'none',
        }}
      />
      {error && <p style={{ color: '#f87171', margin: 0, fontSize: '0.875rem' }}>{error}</p>}
      <button
        type="submit"
        disabled={loading}
        style={{
          background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.75rem', fontSize: '1rem', cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.7 : 1,
        }}
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#0a0a0a',
    }}>
      <Suspense fallback={<div style={{ color: '#fff' }}>Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
