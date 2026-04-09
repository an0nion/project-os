/**
 * Web search via Tavily API — real-time search for the Slack bot.
 *
 * Tavily is purpose-built for AI agent use: returns an AI-synthesised answer
 * alongside raw results, so most queries need no second AI call.
 *
 * Free tier: 1,000 queries/month — more than enough for personal use.
 * Signup:    https://app.tavily.com
 *
 * Required env var:
 *   TAVILY_API_KEY — set on the VM .env and in Vercel if needed
 */

/**
 * Search the web. Returns:
 *   { answer: string|null, results: [{title, url, content, score}] }
 * or null if the API key is missing or the call fails.
 *
 * answer  — Tavily's AI-synthesised 1-3 sentence answer (best for direct questions)
 * results — raw result objects for further AI synthesis if answer is absent
 */
export async function webSearch(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[search] TAVILY_API_KEY not set — skipping web search');
    return null;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:             apiKey,
        query,
        search_depth:        'basic',   // 'basic' = 1 credit, 'advanced' = 2 credits
        max_results:         maxResults,
        include_answer:      true,      // AI-synthesised answer from top results
        include_raw_content: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[search] Tavily API error:', res.status, err.slice(0, 200));
      return null;
    }

    const data = await res.json();
    return {
      answer:  data.answer  ?? null,
      results: data.results ?? [],
    };
  } catch (err) {
    console.error('[search] webSearch failed:', err.message);
    return null;
  }
}
