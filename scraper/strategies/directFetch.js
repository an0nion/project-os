/**
 * Strategy 1: Direct Fetch + HTML Parsing
 * Fastest, free, handles ~70% of fellowship pages (Greenhouse, Lever, etc.)
 */

export async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':           'text/html,application/xhtml+xml',
        'Accept-Language':  'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();

    // Reject JS-shell pages that haven't rendered content
    if (html.length < 1000) throw new Error('Response too short — likely JS shell');
    if (html.includes('__NEXT_DATA__') && !html.includes('<form')) {
      throw new Error('Page requires JS rendering');
    }

    return { html, method: 'direct_fetch' };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}
