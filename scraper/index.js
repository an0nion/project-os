/**
 * Master Scraper — tries 4 strategies in order, gracefully degrades.
 *
 * Strategy 1: directFetch      — plain HTTP + cheerio (free, fast, ~70% hit rate)
 * Strategy 2: playwrightFetch  — headless browser (opt-in, ENABLE_PLAYWRIGHT=true)
 * Strategy 3: cacheFetch       — Google Cache / Wayback Machine (free)
 * Strategy 4: aiExtractFromUrl — Claude reads the HTML (paid fallback, ~$0.01)
 *
 * If all fail → returns { error, errors, message } so the UI can ask for manual paste.
 */

import { directFetch }       from './strategies/directFetch.js';
import { playwrightFetch }   from './strategies/playwrightFetch.js';
import { cacheFetch }        from './strategies/cacheFetch.js';
import { aiExtractFromUrl }  from './strategies/aiExtract.js';
import { extractQuestions }  from './questionExtractor.js';

export async function scrapeApplication(url) {
  const errors = [];
  let html = null;

  // ── Strategy 1: Direct fetch ────────────────────────────────────────────────
  try {
    const result = await directFetch(url);
    html = result.html;
    const parsed = extractQuestions(html);
    if (parsed.questions.length > 0) {
      return { ...parsed, method: result.method, url };
    }
    // Got HTML but no questions — carry on with this HTML to strategy 4
  } catch (err) {
    errors.push({ strategy: 'direct_fetch', error: err.message });
  }

  // ── Strategy 2: Playwright (opt-in) ─────────────────────────────────────────
  try {
    const result = await playwrightFetch(url);
    html = result.html;
    const parsed = extractQuestions(html);
    if (parsed.questions.length > 0) {
      return { ...parsed, method: result.method, url };
    }
  } catch (err) {
    errors.push({ strategy: 'playwright', error: err.message });
  }

  // ── Strategy 3: Cached version ──────────────────────────────────────────────
  try {
    const result = await cacheFetch(url);
    html = result.html;
    const parsed = extractQuestions(html);
    if (parsed.questions.length > 0) {
      return { ...parsed, method: result.method, url };
    }
  } catch (err) {
    errors.push({ strategy: 'cache', error: err.message });
  }

  // ── Strategy 4: Claude reads whatever HTML we managed to get ─────────────────
  if (html) {
    try {
      const result = await aiExtractFromUrl(url, html);
      if (result.questions?.length > 0) {
        return { ...result, url };
      }
    } catch (err) {
      errors.push({ strategy: 'ai_extract', error: err.message });
    }
  }

  // ── All strategies exhausted ─────────────────────────────────────────────────
  return {
    error: 'scrape_failed',
    errors,
    url,
    message: `Couldn't scrape ${url} after ${errors.length} strategies. Please paste the questions manually.`,
  };
}
