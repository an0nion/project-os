/**
 * Strategy 3: Google Cache / Wayback Machine
 * Free fallback for pages that block direct fetch.
 */

export async function cacheFetch(url) {
  // Try Google Cache first (faster, more recent)
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const res = await fetch(cacheUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (res.ok) {
      const html = await res.text();
      if (html.length > 2000) return { html, method: 'google_cache' };
    }
  } catch {}

  // Try Wayback Machine (older but reliable)
  try {
    const wbRes = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    );
    const wbData = await wbRes.json();
    const snapshot = wbData?.archived_snapshots?.closest;
    if (snapshot?.available) {
      const archiveRes = await fetch(snapshot.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      const html = await archiveRes.text();
      if (html.length > 2000) return { html, method: 'wayback_machine' };
    }
  } catch {}

  throw new Error('No cache available for this URL');
}
