# Project OS — Technical Guidelines & Code Reference

A personal AI project management system with intelligent routing, background
processes, and conversational agents per project. Installs as a native-feeling
app on phone via PWA.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ CAPTURE (how things get into the system)                │
│                                                         │
│  Slack: forward any msg ──▸ Bot DM (im:history only)   │
│  Browser: bookmarklet ────▸ /api/inbox                  │
│  Phone: PWA app ──────────▸ Inbox UI                    │
│  Share Sheet: native ─────▸ PWA share target            │
└──────────────────────┬──────────────────────────────────┘
                       ▼
            ┌─────────────────────┐
            │  AI Router          │
            │  "link - apply"     │──▸ Research Apps project
            │  "want to learn"   │──▸ Learning project
            │  "new recipe"      │──▸ Baking project
            └─────────┬──────────┘
                      ▼
         ┌────────────────────────┐
         │  Supabase (free tier)  │
         │  projects, tasks,      │
         │  messages, knowledge   │
         └────────────┬───────────┘
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
┌──────────┐   ┌──────────────┐  ┌──────────────┐
│ PWA App  │   │ Slack Bot    │  │ Cron (daily) │
│ Dashboard│   │ DM-only:     │  │ Deadlines →  │
│ + Chat   │   │ • capture    │  │ Slack DMs +  │
│ + Inbox  │   │ • notify     │  │ Push notifs  │
│ (Vercel) │   │ (Railway)    │  │ (Vercel)     │
└────┬─────┘   └──────────────┘  └──────────────┘
     ▼
┌──────────┐
│Claude API│
│(only $$$)│
└──────────┘
```

## Free Tier Stack — All $0 Except AI Calls

| Component       | Service                | Free Tier Limit              |
|-----------------|------------------------|------------------------------|
| Hosting         | Vercel                 | 100GB bandwidth, serverless  |
| Database        | Supabase               | 500MB, 50k rows, 500k edge  |
| Scraping        | Self-hosted Playwright | Free (runs in serverless)    |
| Slack Bot+Notif | Slack Bolt (Socket)    | Free (DM-only, 3 scopes)     |
| Telegram (opt.) | Telegram Bot API       | Completely free if wanted    |
| Cron            | Vercel Cron            | 1/day on free tier           |
| Alt Cron        | GitHub Actions         | 2000 min/month free          |
| Auth            | Supabase Auth          | 50k MAU free                 |
| AI              | Anthropic API          | **Pay per use**              |

**Slack handles everything:** URL capture (forward messages to bot DM from any 
channel), scrape results (DM with action buttons), and deadline notifications 
(DMs from the cron job). No channel access needed — bot only reads its own DMs.

**Optional Telegram:** If she wants notifications on her phone when not in Slack 
(weekends, travel), Telegram Bot API is completely free with no limits. But it's 
not required — Slack mobile notifications work fine for most people.

---

## 1. Scraping Pipeline — 4 Strategies with Fallback

The scraper tries each strategy in order. If all fail, it asks the user to paste questions.

### Strategy 1: Direct Fetch + HTML Parsing (Fastest, Free)

```javascript
// scraper/strategies/directFetch.js
import * as cheerio from 'cheerio';

export async function directFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();

    // Check if we got actual content vs a JS-rendered shell
    if (html.length < 1000 || html.includes('__NEXT_DATA__') && !html.includes('<form')) {
      throw new Error('Page requires JS rendering');
    }

    return { html, method: 'direct_fetch' };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}
```

### Strategy 2: Playwright Headless (JS-Rendered Pages)

```javascript
// scraper/strategies/playwrightFetch.js
// For Vercel: use @playwright/test or playwright-core with chromium
// For local: full playwright

import { chromium } from 'playwright-core';

export async function playwrightFetch(url) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();

    // Block unnecessary resources to speed up
    await page.route('**/*.{png,jpg,jpeg,gif,svg,mp4,webp,woff,woff2}', r => r.abort());
    await page.route('**/analytics**', r => r.abort());
    await page.route('**/tracking**', r => r.abort());

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for form elements or content to load
    await page.waitForTimeout(2000);

    // Try to expand any "show more" or accordion elements
    const expandButtons = await page.$$('button, [role="button"], .accordion, .expandable');
    for (const btn of expandButtons.slice(0, 10)) {
      try { await btn.click(); await page.waitForTimeout(300); } catch {}
    }

    const html = await page.content();
    return { html, method: 'playwright' };
  } catch (err) {
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
```

### Strategy 3: Google Cache / Wayback Machine

```javascript
// scraper/strategies/cacheFetch.js

export async function cacheFetch(url) {
  // Try Google Cache
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

  // Try Wayback Machine
  try {
    const wbRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
    const wbData = await wbRes.json();
    const snapshot = wbData?.archived_snapshots?.closest;
    if (snapshot?.available) {
      const archiveRes = await fetch(snapshot.url);
      const html = await archiveRes.text();
      if (html.length > 2000) return { html, method: 'wayback_machine' };
    }
  } catch {}

  throw new Error('No cache available');
}
```

### Strategy 4: Claude Reads Raw HTML (Last Resort Before Manual)

```javascript
// scraper/strategies/aiExtract.js
// This costs an API call but is the last automated attempt

export async function aiExtractFromUrl(url, html) {
  // If we have HTML from a partial fetch, send it to Claude
  // If we don't, we can't proceed — fall through to manual

  if (!html || html.length < 500) {
    throw new Error('No HTML content to analyze');
  }

  // Truncate HTML to fit context window (keep first 50k chars)
  const truncated = html.slice(0, 50000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: `Extract application/fellowship questions from this HTML. 
Return ONLY a JSON array of objects with "text" (the question) and "category" fields.
Categories: research_interests, research_statement, motivation, methodology, 
publications, collaboration, future_directions, technical_skills, background, 
diversity_statement, travel_logistics, availability, other.
Also extract: deadline (ISO date string), organization name, position title.
Return format: { "org": "...", "position": "...", "deadline": "...", "questions": [...] }
If you cannot find questions, return { "error": "no_questions_found" }`,
      messages: [{ role: 'user', content: `URL: ${url}\n\nHTML:\n${truncated}` }],
    }),
  });

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '';

  // Parse JSON from response
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  const result = JSON.parse(cleaned);

  if (result.error) throw new Error(result.error);
  return { ...result, method: 'ai_extract' };
}
```

### Master Scraper — Runs All Strategies

```javascript
// scraper/index.js

import { directFetch } from './strategies/directFetch.js';
import { playwrightFetch } from './strategies/playwrightFetch.js';
import { cacheFetch } from './strategies/cacheFetch.js';
import { aiExtractFromUrl } from './strategies/aiExtract.js';
import { extractQuestions } from './questionExtractor.js';

export async function scrapeApplication(url) {
  const errors = [];
  let html = null;

  // Strategy 1: Direct fetch
  try {
    const result = await directFetch(url);
    html = result.html;
    const questions = extractQuestions(html);
    if (questions.questions.length > 0) {
      return { ...questions, method: result.method, url };
    }
    // Got HTML but couldn't extract questions — continue
  } catch (err) {
    errors.push({ strategy: 'direct_fetch', error: err.message });
  }

  // Strategy 2: Playwright
  try {
    const result = await playwrightFetch(url);
    html = result.html;
    const questions = extractQuestions(html);
    if (questions.questions.length > 0) {
      return { ...questions, method: result.method, url };
    }
  } catch (err) {
    errors.push({ strategy: 'playwright', error: err.message });
  }

  // Strategy 3: Cache
  try {
    const result = await cacheFetch(url);
    html = result.html;
    const questions = extractQuestions(html);
    if (questions.questions.length > 0) {
      return { ...questions, method: result.method, url };
    }
  } catch (err) {
    errors.push({ strategy: 'cache', error: err.message });
  }

  // Strategy 4: AI extraction from whatever HTML we have
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

  // All strategies failed
  return {
    error: 'scrape_failed',
    errors,
    url,
    message: `Couldn't scrape ${url}. Tried ${errors.length} strategies. Please paste the questions manually.`,
  };
}
```

### Question Extractor — HTML to Structured Questions

```javascript
// scraper/questionExtractor.js
import * as cheerio from 'cheerio';

// Common application platforms and their selectors
const PLATFORM_SELECTORS = {
  greenhouse: {
    detect: '.application-form, #application_form, [data-controller="application"]',
    questions: '.field label, .application-label, .custom-question label',
    org: '.company-name, .header__company-name',
    title: '.job-title, .app-title',
  },
  lever: {
    detect: '.lever-application, .application-page, [class*="lever"]',
    questions: '.application-question label, .custom-question-label',
    org: '.company-name',
    title: '.posting-headline h2',
  },
  workday: {
    detect: '[data-automation-id], .workday, .wd-Application',
    questions: '[data-automation-id*="question"] label, .WFMS label',
    org: '.css-1q2dra3',
    title: '[data-automation-id="jobPostingHeader"]',
  },
  google_forms: {
    detect: '.freebirdFormviewerViewFormCard, [data-params]',
    questions: '.freebirdFormviewerComponentsQuestionBaseTitle, [data-params] .exportItemTitle',
    org: null,
    title: '.freebirdFormviewerViewHeaderTitle',
  },
  generic: {
    detect: 'form, .application',
    questions: [
      'form label',
      'form .question',
      '.question-text',
      '.field-label',
      '[class*="question"] label',
      '[class*="Question"]',
      'textarea[placeholder]',
      'input[placeholder]',
    ],
    org: null,
    title: 'h1, .page-title',
  },
};

// Words that indicate a question vs a simple form field
const QUESTION_INDICATORS = [
  'describe', 'explain', 'tell us', 'what', 'why', 'how', 'please provide',
  'share', 'discuss', 'detail', 'outline', 'elaborate', 'research',
  'experience', 'interest', 'motivation', 'statement', 'vision',
  'publication', 'project', 'methodology', 'approach', 'contribution',
  'diversity', 'background', 'skills', 'collaboration', 'future',
  'track', 'location', 'availability', 'start date', 'preferred',
];

// Simple field labels to SKIP (not real questions)
const SKIP_FIELDS = [
  'first name', 'last name', 'full name', 'email', 'phone',
  'address', 'city', 'state', 'zip', 'country', 'resume',
  'cv', 'upload', 'file', 'linkedin', 'website', 'url',
  'captcha', 'submit', 'password', 'confirm',
];

const CATEGORY_KEYWORDS = {
  research_interests: ['research interest', 'area of research', 'research focus', 'research direction', 'interested in studying'],
  research_statement: ['research statement', 'research project', 'research experience', 'describe a project', 'research you led'],
  motivation: ['why', 'motivation', 'interested in this', 'what draws you', 'why apply', 'why this fellowship'],
  methodology: ['method', 'methodology', 'technique', 'approach', 'tools you use', 'technical approach'],
  publications: ['publication', 'paper', 'published', 'cite', 'written work'],
  collaboration: ['collaborat', 'team', 'work with others', 'group project', 'interdisciplinary'],
  future_directions: ['future', 'vision', 'next 3', 'next 5', 'long-term', 'where do you see'],
  technical_skills: ['technical skill', 'programming', 'software', 'language', 'framework', 'proficien'],
  background: ['background', 'about yourself', 'introduce yourself', 'tell us about you', 'bio'],
  diversity_statement: ['diversity', 'equity', 'inclusion', 'underrepresented', 'dei'],
  travel_logistics: ['travel', 'relocat', 'location', 'visa', 'work authorization', 'remote'],
  availability: ['available', 'start date', 'when can you', 'earliest start', 'preferred start'],
};

function categorize(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'other';
}

function isRealQuestion(text) {
  const lower = text.toLowerCase().trim();
  if (lower.length < 10) return false;
  if (lower.length > 2000) return false;
  if (SKIP_FIELDS.some(s => lower === s || lower.startsWith(s))) return false;
  if (QUESTION_INDICATORS.some(q => lower.includes(q))) return true;
  if (lower.includes('?')) return true;
  if (lower.length > 40) return true; // Long labels are usually real questions
  return false;
}

export function extractQuestions(html) {
  const $ = cheerio.load(html);
  let platform = 'generic';
  let questions = [];

  // Detect platform
  for (const [name, config] of Object.entries(PLATFORM_SELECTORS)) {
    if (name === 'generic') continue;
    if ($(config.detect).length > 0) {
      platform = name;
      break;
    }
  }

  const config = PLATFORM_SELECTORS[platform];

  // Extract raw question texts
  const selectors = Array.isArray(config.questions) ? config.questions : [config.questions];
  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      let text = $(el).text().trim();
      // Also check for placeholder text on textareas
      if (!text && el.tagName === 'textarea') {
        text = $(el).attr('placeholder') || '';
      }
      if (!text && el.tagName === 'input') {
        text = $(el).attr('placeholder') || '';
      }

      text = text.replace(/\s+/g, ' ').trim();

      if (text && !seen.has(text.toLowerCase()) && isRealQuestion(text)) {
        seen.add(text.toLowerCase());
        questions.push({
          text,
          category: categorize(text),
          answer: '',
          status: 'pending',
          id: Math.random().toString(36).slice(2, 9),
        });
      }
    });
  }

  // Extract org and title
  const org = config.org ? $(config.org).first().text().trim() : '';
  const title = config.title ? $(config.title).first().text().trim() : '';

  // Try to find deadline
  let deadline = '';
  const deadlinePatterns = [
    /deadline[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /due[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /closes?[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];
  const bodyText = $('body').text();
  for (const pattern of deadlinePatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      try {
        deadline = new Date(match[1]).toISOString();
      } catch {
        deadline = match[1];
      }
      break;
    }
  }

  return { org, position: title, deadline, questions, platform };
}
```

---

## 2. User-Pasted Question Parser

When scraping fails, the user pastes questions in chat. They might be structured (numbered list) or unstructured (paragraph with multiple questions). This parser handles both.

```javascript
// parser/questionParser.js

const CATEGORY_KEYWORDS = { /* same as above */ };

function categorize(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'other';
}

/**
 * Parse user-pasted text into individual questions.
 * Handles:
 * - Numbered lists: "1. question\n2. question"
 * - Bullet lists: "- question\n- question" or "• question"
 * - Newline-separated: "question\nquestion"
 * - Paragraph with question marks: "What is X? Why do you Y?"
 * - Mixed formats
 */
export function parseQuestions(rawText) {
  const text = rawText.trim();
  if (!text) return [];

  let lines = [];

  // Strategy 1: Check for numbered/bulleted list
  const listPattern = /^[\s]*(?:\d+[\.\)]\s*|[-•*]\s*|[a-z][\.\)]\s*)/m;
  if (listPattern.test(text)) {
    // Split by list markers
    lines = text
      .split(/\n/)
      .map(l => l.replace(/^[\s]*(?:\d+[\.\)]\s*|[-•*]\s*|[a-z][\.\)]\s*)/, '').trim())
      .filter(l => l.length > 5);
  }

  // Strategy 2: Split by newlines if lines are long enough to be questions
  if (lines.length === 0) {
    const newlineSplit = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 10);
    if (newlineSplit.length >= 2) {
      lines = newlineSplit;
    }
  }

  // Strategy 3: Split by question marks (for paragraph-style input)
  if (lines.length <= 1) {
    const qSplit = text
      .split(/\?/)
      .map(l => l.trim())
      .filter(l => l.length > 10)
      .map(l => l + '?');

    if (qSplit.length >= 2) {
      lines = qSplit;
    }
  }

  // Strategy 4: Split by sentence-ending punctuation + capital letter
  if (lines.length <= 1) {
    const sentenceSplit = text
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .filter(l => l.trim().length > 15);

    if (sentenceSplit.length >= 2) {
      lines = sentenceSplit;
    }
  }

  // If we still have nothing, treat the whole thing as one question
  if (lines.length === 0) {
    lines = [text];
  }

  // Convert to question objects
  return lines.map(line => ({
    id: Math.random().toString(36).slice(2, 9),
    text: line.trim(),
    category: categorize(line),
    answer: '',
    status: 'pending',
  }));
}

/**
 * AI-powered question parser for ambiguous input.
 * Use when the simple parser produces poor results.
 * Costs one API call.
 */
export async function aiParseQuestions(rawText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `Extract individual application questions from this text. 
The user pasted this from a fellowship/research application form.
Return ONLY a JSON array: [{"text": "the question", "category": "..."}]
Categories: research_interests, research_statement, motivation, methodology, 
publications, collaboration, future_directions, technical_skills, background, 
diversity_statement, travel_logistics, availability, other.
Do NOT include simple form fields like name/email/phone.
Only include substantive questions that need written answers.`,
      messages: [{ role: 'user', content: rawText }],
    }),
  });

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '[]';
  const cleaned = text.replace(/```json\n?|```/g, '').trim();

  try {
    const questions = JSON.parse(cleaned);
    return questions.map(q => ({
      ...q,
      id: Math.random().toString(36).slice(2, 9),
      answer: '',
      status: 'pending',
    }));
  } catch {
    return [];
  }
}
```

---

## 3. Slack Bot — DM-Only (No Channel Access Needed)

The bot only reads its own DMs — zero channel membership required. 
She forwards/shares any message from any channel to the bot's DM, or 
just types a URL directly. The bot scrapes it and routes it to the right project.

The bot also sends deadline notifications as DMs.

**Required scopes (minimal):**
- `im:history` — read DMs sent to the bot
- `im:write` — send DMs back to the user
- `chat:write` — post messages

That's it. No channels:history, no reactions:read, no channel access at all.

```javascript
// slack/bot.js
// DM-only bot — Socket Mode (free, no public URL needed)

import bolt from '@slack/bolt';
const { App } = bolt;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ─── Helper: extract URLs from any message ───
function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;

  // From text
  if (message.text) urls.push(...(message.text.match(urlRegex) || []));

  // From Slack blocks (shared/forwarded messages contain these)
  if (message.blocks) {
    const findLinks = (elements) => {
      for (const el of elements || []) {
        if (el.type === 'link') urls.push(el.url);
        if (el.elements) findLinks(el.elements);
      }
    };
    message.blocks.forEach(b => findLinks(b.elements));
  }

  // From attachments (unfurled links in forwarded messages)
  if (message.attachments) {
    message.attachments.forEach(att => {
      if (att.original_url) urls.push(att.original_url);
      if (att.from_url) urls.push(att.from_url);
      if (att.title_link) urls.push(att.title_link);
    });
  }

  // From forwarded message content
  if (message.files) {
    // Shared messages sometimes come as "files" of type "message"
  }

  return [...new Set(urls)].filter(u =>
    !u.includes('slack.com') && !u.includes('slack-edge.com')
  );
}

// ═══════════════════════════════════════════════
// Listen for DMs — this is the only message handler
// ═══════════════════════════════════════════════
app.message(async ({ message, say }) => {
  // Only respond to DMs (not channel messages)
  if (message.channel_type !== 'im') return;

  const urls = extractUrls(message);
  const userText = message.text || '';

  // Case 1: Message contains URLs — scrape and route
  if (urls.length > 0) {
    for (const url of urls) {
      await say(`⏳ Processing: ${url}`);

      try {
        const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            text: userText,
            source: 'slack',
          }),
        });
        const data = await res.json();

        if (data.error) {
          await say(
            `⚠️ Couldn't scrape that page.\n\n` +
            `Open the app to paste questions manually:\n` +
            `${process.env.APP_URL}?inbox=${encodeURIComponent(url)}`
          );
        } else {
          await say({
            text: `✅ Routed to *${data.project || 'inbox'}*`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `✅ *${data.summary || 'Added'}*\n` +
                        `→ Routed to *${data.projectLabel || data.project}*\n` +
                        (data.questionsCount ? `❓ ${data.questionsCount} questions found\n` : '') +
                        (data.deadline ? `📅 Deadline: ${data.deadline}\n` : ''),
                },
              },
              {
                type: 'actions',
                elements: [{
                  type: 'button',
                  text: { type: 'plain_text', text: '✍️ Open in app' },
                  url: `${process.env.APP_URL}?project=${data.project}`,
                  action_id: 'open_app',
                  style: 'primary',
                }],
              },
            ],
          });
        }
      } catch (err) {
        await say(`❌ Error: ${err.message}`);
      }
    }
    return;
  }

  // Case 2: Text-only message — route via AI
  if (userText.trim()) {
    try {
      const res = await fetch(`${process.env.APP_URL}/api/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userText, source: 'slack' }),
      });
      const data = await res.json();

      await say(
        `📋 Routed to *${data.projectLabel || data.project}*: ${data.summary || ''}\n` +
        `${process.env.APP_URL}?project=${data.project}`
      );
    } catch {
      await say(`Added to inbox. Open the app to review.`);
    }
    return;
  }

  // Case 3: Nothing useful
  await say(
    `Send me a link or a message and I'll route it to the right project.\n` +
    `Example: forward a Slack post here, or type "want to learn about X"`
  );
});

// ═══════════════════════════════════════════════
// Deadline notifications (called by cron)
// ═══════════════════════════════════════════════
export async function sendSlackDeadlineNudge(userId, apps) {
  const dm = await app.client.conversations.open({ users: userId });

  const urgent = apps.filter(a => {
    const d = Math.ceil((new Date(a.deadline) - new Date()) / 86400000);
    return d >= 0 && d <= 7 && a.status !== 'submitted';
  });

  if (urgent.length === 0) return;

  let text = '📋 *Upcoming deadlines:*\n\n';
  for (const a of urgent) {
    const d = Math.ceil((new Date(a.deadline) - new Date()) / 86400000);
    const emoji = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
    text += `${emoji} *${a.org}* — ${d}d left\n`;
  }

  await app.client.chat.postMessage({
    channel: dm.channel.id,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '✍️ Open app' },
          url: process.env.APP_URL,
          action_id: 'open_from_nudge',
          style: 'primary',
        }],
      },
    ],
  });
}

await app.start();
console.log('Slack DM bot running');
```

### Slack Setup (Minimal — 3 scopes, 0 channels)

```bash
# 1. Create Slack App at https://api.slack.com/apps
# 2. Enable Socket Mode
# 3. Bot Token Scopes (only 3 needed):
#    - im:history    (read DMs to the bot)
#    - im:write      (open DM conversations)
#    - chat:write    (send messages)
# 4. Subscribe to Events:
#    - message.im    (fires when someone DMs the bot)
# 5. Install to workspace
# 6. No channel invites needed — it only reads its own DMs

SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### How she uses it

She sees a fellowship post in #ai-safety-jobs → long-presses the message → 
"Share" → picks the bot DM → bot receives it, extracts the URL, scrapes it, 
routes it, and confirms back. All from within Slack, no channel membership.


---


## 4. Notifications — Slack DMs (Primary) + Telegram (Optional)

Since Slack is already the hub, notifications go there as DMs. The deadline 
cron job calls `sendSlackDeadlineNudge()` from the Slack bot code in Section 3.

No extra setup needed — the bot already has `im:write` scope.

### Notification triggers (handled by cron + event hooks):

| Trigger | When | Message |
|---------|------|---------|
| Deadline 7d | Cron, daily 8am | "📋 MATS deadline in 7 days — 3 questions unanswered" |
| Deadline 3d | Cron, daily 8am | "🟡 MATS deadline in 3 days — 2 questions left" |
| Deadline 1d | Cron, daily 8am | "🔴 MATS deadline TOMORROW — 1 question left!" |
| New app scraped | On scrape | "✅ Added DeepMind Research Scientist — 5 questions found" |
| Scrape failed | On scrape | "⚠️ Couldn't scrape [url] — paste questions manually" |
| Overlap detected | On question add | "🔗 3 fellowships ask about Research Interests — draft once?" |
| Profile gap | On draft attempt | "⚠️ Can't draft Methodology — no skills in your profile" |

### Optional: Telegram as secondary channel

If you also want Telegram notifications (e.g., when not in Slack on weekends),
keep this as a secondary. Setup is completely free.

```javascript
// notifications/telegram.js
// Optional secondary channel — only if user wants notifications outside Slack

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramNotif(message, buttons = []) {
  if (!BOT_TOKEN || !CHAT_ID) return; // Skip if not configured

  const body = {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
  };

  if (buttons.length) {
    body.reply_markup = {
      inline_keyboard: [buttons.map(b => ({
        text: b.text,
        ...(b.url ? { url: b.url } : { callback_data: b.data }),
      }))],
    };
  }

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

### Telegram setup (if wanted — completely free)

```bash
# 1. Message @BotFather on Telegram → /newbot → get token
# 2. Message your bot to start a chat
# 3. Get chat ID: curl https://api.telegram.org/bot<TOKEN>/getUpdates

# Add to .env.local (optional):
TELEGRAM_BOT_TOKEN=123456:ABC-your-token
TELEGRAM_CHAT_ID=your-chat-id
```

---

## 5. Database Schema (Supabase — Free Tier)

```sql
-- Supabase PostgreSQL schema

-- Users (if multi-user, otherwise skip)
create table profiles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  data jsonb not null default '{}'::jsonb
);

-- Applications
create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  name text not null,
  org text not null,
  url text,
  deadline timestamptz,
  status text default 'backlog' check (status in ('backlog','drafting','review','submitted')),
  scrape_method text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Questions
create table questions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  text text not null,
  category text default 'other',
  answer text default '',
  status text default 'pending' check (status in ('pending','drafted','reviewed','final')),
  base_answer_id uuid references base_answers(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Base answers (shared across applications by category)
create table base_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  category text not null,
  content text not null,
  version int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, category)
);

-- Chat history (for conversational context)
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  application_id uuid references applications(id),
  question_id uuid references questions(id),
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz default now()
);

-- Indexes
create index idx_apps_user_deadline on applications(user_id, deadline);
create index idx_questions_app on questions(application_id);
create index idx_questions_category on questions(category);
create index idx_chat_user on chat_messages(user_id, created_at);

-- Auto-update updated_at
create or replace function update_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_applications_timestamp before update on applications
  for each row execute function update_timestamp();
create trigger update_questions_timestamp before update on questions
  for each row execute function update_timestamp();
```

---

## 6. API Routes (Vercel Serverless — Free Tier)

```
/api
├── scrape.js          POST { url } → scrape + extract questions
├── parse-questions.js POST { text, appId } → parse pasted questions
├── chat.js            POST { messages, appId, questionId } → Claude
├── apps/
│   ├── index.js       GET (list) / POST (create)
│   └── [id].js        GET / PATCH / DELETE
├── questions/
│   └── [id].js        PATCH { answer, status }
├── base-answers/
│   ├── index.js       GET / POST
│   └── [category].js  GET / PUT
├── cron/
│   └── deadlines.js   GET (called by Vercel cron)
└── telegram.js        POST (webhook handler)
```

### Example: Scrape Endpoint

```javascript
// api/scrape.js (Vercel serverless function)
import { scrapeApplication } from '../scraper/index.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { url, userId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const result = await scrapeApplication(url);

  if (result.error) {
    return res.status(200).json(result); // Return error to client, don't 500
  }

  // Save to database
  const { data: app, error: appErr } = await supabase
    .from('applications')
    .insert({
      user_id: userId,
      name: result.position || 'Untitled Application',
      org: result.org || 'Unknown',
      url,
      deadline: result.deadline || null,
      status: 'backlog',
      scrape_method: result.method,
    })
    .select()
    .single();

  if (appErr) return res.status(500).json({ error: appErr.message });

  // Save questions
  if (result.questions?.length) {
    const questions = result.questions.map(q => ({
      application_id: app.id,
      text: q.text,
      category: q.category,
      answer: '',
      status: 'pending',
    }));

    await supabase.from('questions').insert(questions);
  }

  return res.status(200).json({ ...result, appId: app.id });
}
```

### Example: Parse Pasted Questions

```javascript
// api/parse-questions.js
import { parseQuestions, aiParseQuestions } from '../parser/questionParser.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { text, appId, useAi = false } = req.body;

  // Try simple parser first
  let questions = parseQuestions(text);

  // If simple parser gives poor results, use AI
  if (questions.length <= 1 && text.length > 50) {
    questions = await aiParseQuestions(text);
  }

  // If explicit AI request
  if (useAi) {
    questions = await aiParseQuestions(text);
  }

  // Save to DB if appId provided
  if (appId && questions.length > 0) {
    const rows = questions.map(q => ({
      application_id: appId,
      text: q.text,
      category: q.category,
      answer: '',
      status: 'pending',
    }));

    const { data } = await supabase.from('questions').insert(rows).select();
    return res.status(200).json({ questions: data });
  }

  return res.status(200).json({ questions });
}
```

### Cron: Deadline Checker

```javascript
// api/cron/deadlines.js
// Vercel cron config in vercel.json:
// { "crons": [{ "path": "/api/cron/deadlines", "schedule": "0 8 * * *" }] }
// Free tier: 1 cron job per day
// Alternative: GitHub Actions for more frequency (free 2000 min/month)

import { createClient } from '@supabase/supabase-js';
import { sendDeadlineNudge } from '../../notifications/telegram.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  // Verify it's a real cron call (Vercel adds this header)
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  // Get all non-submitted apps with upcoming deadlines
  const { data: apps } = await supabase
    .from('applications')
    .select('*, questions(*)')
    .neq('status', 'submitted')
    .gte('deadline', new Date().toISOString())
    .order('deadline', { ascending: true });

  if (apps?.length) {
    await sendDeadlineNudge(apps);
  }

  return res.status(200).json({ notified: apps?.length || 0 });
}
```

---

## 7. Project Structure

```
project-os/
├── package.json
├── vercel.json                 # Cron config, rewrites
├── .env.local                  # All secrets
│
├── public/
│   ├── manifest.json           # PWA manifest (share target!)
│   ├── sw.js                   # Service worker (push + offline)
│   ├── icon-192.png
│   └── icon-512.png
│
├── app/                        # Next.js app (Vercel free)
│   ├── page.jsx                # Dashboard home + Inbox router
│   ├── project/[key]/page.jsx  # Project detail (chat + tasks)
│   └── layout.jsx              # PWA head tags, SW registration
│
├── api/                        # Serverless functions
│   ├── inbox.js                # Universal inbox — AI routes to project
│   ├── scrape.js               # Scraper pipeline (4 strategies)
│   ├── parse-questions.js      # Pasted text → structured questions
│   ├── chat.js                 # Claude chat per project
│   ├── share-target.js         # PWA share sheet handler
│   ├── push/subscribe.js       # Store push subscription
│   ├── projects/
│   │   └── [key].js            # GET / PATCH
│   ├── tasks/
│   │   └── [id].js             # Toggle, update
│   ├── cron/
│   │   └── deadlines.js        # Daily → Slack DM + web push
│   └── telegram.js             # Optional webhook
│
├── scraper/
│   ├── index.js                # Master scraper (4 strategies)
│   ├── questionExtractor.js    # HTML → structured questions
│   └── strategies/
│       ├── directFetch.js
│       ├── cacheFetch.js
│       └── aiExtract.js
│
├── parser/
│   └── questionParser.js       # Freeform text → questions
│
├── notifications/
│   ├── push.js                 # Web Push (VAPID, free)
│   └── telegram.js             # Optional secondary
│
├── slack/
│   └── bot.js                  # DM-only bot (3 scopes)
│
├── lib/
│   ├── supabase.js
│   ├── claude.js
│   ├── router.js               # AI message router
│   └── pwa.js                  # SW registration + push
│
└── scripts/
    └── generate-vapid.js       # One-time VAPID key generation
```

---

## 8. Environment Variables

```bash
# .env.local

# Anthropic (only paid component)
ANTHROPIC_API_KEY=sk-ant-...

# Supabase (free tier)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...  # For server-side ops

# Slack (free — socket mode, DM-only, 3 scopes)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Telegram (optional — free secondary notifications)
# TELEGRAM_BOT_TOKEN=123456:ABC...
# TELEGRAM_CHAT_ID=...

# App
APP_URL=https://your-app.vercel.app
CRON_SECRET=some-random-secret

# Web Push — VAPID keys (free, generate with: npx web-push generate-vapid-keys)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=...

# Optional: for Playwright on Vercel
# Use @sparticuz/chromium for serverless Playwright
```

---

## 9. Deployment (All Free)

```bash
# 1. Set up Supabase
#    - Create project at supabase.com
#    - Run the SQL schema above in the SQL editor
#    - Copy URL + keys

# 2. Deploy to Vercel
npm i -g vercel
vercel --prod

# 3. Set environment variables in Vercel dashboard

# 4. Start Slack bot (needs a persistent process — use Railway free tier or a home server)
#    Railway free tier: 500 hours/month (enough for a bot)
#    The bot handles both URL capture (emoji/shortcut/command) AND DM notifications.
node slack/bot.js

# 5. (Optional) Set up Telegram as secondary notification channel
#    Only if you want notifications outside Slack:
# curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${APP_URL}/api/telegram"

# 6. Verify cron is running
#    Check Vercel dashboard → Cron Jobs
```

---

## 10. Playwright on Serverless (Vercel)

Playwright doesn't run natively on Vercel's serverless. Two options:

### Option A: Use @sparticuz/chromium (free, runs on Vercel)

```javascript
// Works within Vercel's 50MB function limit
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export async function playwrightFetchServerless(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
  const html = await page.content();
  await browser.close();

  return { html, method: 'puppeteer_serverless' };
}
```

### Option B: Skip Playwright, rely on fetch + AI (simpler)

Most fellowship application pages are server-rendered (Greenhouse, Lever, Google Forms). Direct fetch handles 70%+ of cases. For the rest, fall through to manual paste. This avoids the Playwright complexity entirely.

**Recommendation:** Start with Option B. Add Playwright only if you find many sites need it.

---

## 11. Cost Estimate

| Component       | Monthly Cost |
|-----------------|-------------|
| Vercel hosting  | $0          |
| Supabase DB     | $0          |
| Slack bot+notifs| $0          |
| Telegram (opt.) | $0          |
| Railway (Slack) | $0 (500h)   |
| **Claude API**  | **~$2-10**  |

API cost breakdown (Sonnet):
- Scraping (AI extract): ~$0.01 per page (used only as fallback)
- Question parsing: ~$0.005 per parse
- Answer drafting: ~$0.02 per answer
- Ideation chat: ~$0.01 per message
- Estimated 50 applications/month × 5 questions × 3 messages = ~$5/month

**Total: ~$5/month**, all AI API costs.

---

## 12. PWA — Install as Phone App (Free)

A Progressive Web App makes the web app installable on iOS and Android as a 
real app — own icon, full-screen, push notifications, offline support.

### manifest.json

```json
{
  "name": "Project OS",
  "short_name": "ProjectOS",
  "description": "Personal AI project management",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#08090c",
  "theme_color": "#6b8aed",
  "orientation": "portrait-primary",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": {
    "action": "/api/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url"
    }
  }
}
```

**The `share_target` is key** — it registers the app as a share destination on the 
phone. She can share a link from Safari, Slack, Chrome, any app → it goes 
straight to the Project OS inbox for AI routing. This is the mobile capture method.

### Service Worker (push notifications + offline)

```javascript
// public/sw.js

const CACHE_NAME = 'project-os-v1';
const OFFLINE_URLS = ['/', '/dashboard'];

// Cache app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

// Network-first, fall back to cache
self.addEventListener('fetch', (event) => {
  // Only cache GET requests for app pages
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return; // Don't cache API calls

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone and cache successful responses
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};

  event.waitUntil(
    self.registration.showNotification(data.title || 'Project OS', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      tag: data.tag || 'default',
      data: { url: data.url || '/' },
      actions: data.actions || [],
    })
  );
});

// Handle notification click — open the app to the right page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      // Focus existing window if open
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return clients.openWindow(url);
    })
  );
});
```

### Register Service Worker + Request Push Permission

```javascript
// lib/pwa.js — call this on app load

export async function initPWA() {
  if (!('serviceWorker' in navigator)) return;

  const reg = await navigator.serviceWorker.register('/sw.js');
  console.log('SW registered');

  return reg;
}

export async function requestPushPermission() {
  if (!('Notification' in window)) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const reg = await navigator.serviceWorker.ready;

  // Subscribe to push — uses free Web Push protocol (VAPID)
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
  });

  // Send subscription to your server
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });

  return subscription;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
```

### Send Push from Server (Cron / Slack Bot)

```javascript
// lib/push.js — server-side, used by cron and Slack bot
import webpush from 'web-push';

// Generate VAPID keys once: npx web-push generate-vapid-keys
webpush.setVapidDetails(
  'mailto:you@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

export async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) {
      // Subscription expired — remove from DB
      console.log('Push subscription expired');
    }
  }
}

// Example: deadline notification
export async function pushDeadlineAlert(subscription, app) {
  const days = Math.ceil((new Date(app.deadline) - new Date()) / 86400000);
  await sendPush(subscription, {
    title: `${app.org} — ${days}d left`,
    body: `${app.questions.filter(q => !q.answer?.trim()).length} questions unanswered`,
    tag: `deadline-${app.id}`,
    url: `/?project=research_apps&app=${app.id}`,
    actions: [
      { action: 'open', title: '✍️ Answer now' },
      { action: 'snooze', title: '⏰ Remind later' },
    ],
  });
}
```

### Share Target Handler (receives shares from phone)

```javascript
// api/share-target.js
// When the user shares a link from any app to Project OS

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.redirect('/');

  const { title, text, url } = req.body;
  const content = [title, text, url].filter(Boolean).join(' ');

  // Route via AI (same router as inbox)
  // For now, redirect to inbox with pre-filled content
  const encoded = encodeURIComponent(content);
  return res.redirect(`/?inbox=${encoded}`);
}
```

### Next.js Head Tags

```jsx
// app/layout.jsx — add to <head>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#08090c" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="apple-touch-icon" href="/icon-192.png" />
```

### How She Installs It

**iPhone (Safari):**
1. Open the app URL
2. Tap Share button (↑) → "Add to Home Screen"
3. Done — appears as an app icon

**Android (Chrome):**
1. Open the app URL  
2. Chrome shows "Install app" banner automatically
3. Or: menu (⋮) → "Install app"

**Desktop (Chrome/Edge):**
1. Install icon appears in address bar
2. Click → installs as desktop app

### PWA Costs

| Component        | Cost |
|-----------------|------|
| manifest.json    | $0   |
| Service worker   | $0   |
| Web Push (VAPID) | $0   |
| Share target     | $0   |
| **Total**        | **$0** |

Web Push uses the VAPID protocol — completely free, no third-party service 
needed. The `web-push` npm package handles everything.

---

## 13. Iteration Path (Updated)

**V1** (built): Profile store + basic chat drafting
**V2** (built): Command center with kanban + calendar + question clustering
**V3** (built): WhatsApp-style conversational interface with ideation mode
**V4** (built): Project OS — multi-project dashboard with AI router + inbox
**V5** (this doc): Full stack — scraping, Slack DM bot, Supabase, PWA

**V6** (future):
- Capacitor wrapper for App Store / Play Store listing
- Background sync — offline edits sync when back online
- Project templates marketplace (share project configs)
- Cross-project knowledge — AI connects insights across projects
- Voice input — talk to the inbox, AI transcribes and routes