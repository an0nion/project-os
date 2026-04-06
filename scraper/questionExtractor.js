/**
 * HTML → Structured Questions
 * Detects known ATS platforms and falls back to generic selectors.
 */

import * as cheerio from 'cheerio';
import { categorize, QUESTION_INDICATORS, SKIP_FIELDS } from '../lib/categories.js';

// ── Platform detection + per-platform selectors ───────────────────────────────
const PLATFORM_SELECTORS = {
  greenhouse: {
    detect:    '.application-form, #application_form, [data-controller="application"]',
    questions: '.field label, .application-label, .custom-question label',
    org:       '.company-name, .header__company-name',
    title:     '.job-title, .app-title',
  },
  lever: {
    detect:    '.lever-application, .application-page, [class*="lever"]',
    questions: '.application-question label, .custom-question-label',
    org:       '.company-name',
    title:     '.posting-headline h2',
  },
  workday: {
    detect:    '[data-automation-id], .workday, .wd-Application',
    questions: '[data-automation-id*="question"] label, .WFMS label',
    org:       '.css-1q2dra3',
    title:     '[data-automation-id="jobPostingHeader"]',
  },
  google_forms: {
    detect:    '.freebirdFormviewerViewFormCard, [data-params]',
    questions: '.freebirdFormviewerComponentsQuestionBaseTitle, [data-params] .exportItemTitle',
    org:       null,
    title:     '.freebirdFormviewerViewHeaderTitle',
  },
  generic: {
    detect:    'form, .application',
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
    org:   null,
    title: 'h1, .page-title',
  },
};

function isRealQuestion(text) {
  const lower = text.toLowerCase().trim();
  if (lower.length < 10)   return false;
  if (lower.length > 2000) return false;
  if (SKIP_FIELDS.some(s => lower === s || lower.startsWith(s))) return false;
  if (QUESTION_INDICATORS.some(q => lower.includes(q))) return true;
  if (lower.includes('?')) return true;
  if (lower.length > 40)   return true; // Long labels are usually real questions
  return false;
}

export function extractQuestions(html) {
  const $ = cheerio.load(html);
  let platform = 'generic';

  // Detect ATS platform
  for (const [name, config] of Object.entries(PLATFORM_SELECTORS)) {
    if (name === 'generic') continue;
    if ($(config.detect).length > 0) { platform = name; break; }
  }

  const config = PLATFORM_SELECTORS[platform];
  const selectors = Array.isArray(config.questions) ? config.questions : [config.questions];
  const questions = [];
  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      let text = $(el).text().trim();
      if (!text && el.name === 'textarea') text = $(el).attr('placeholder') || '';
      if (!text && el.name === 'input')    text = $(el).attr('placeholder') || '';
      text = text.replace(/\s+/g, ' ').trim();

      if (text && !seen.has(text.toLowerCase()) && isRealQuestion(text)) {
        seen.add(text.toLowerCase());
        questions.push({
          id:       Math.random().toString(36).slice(2, 9),
          text,
          category: categorize(text),
          answer:   '',
          status:   'pending',
        });
      }
    });
  }

  // Meta fields
  const org      = config.org   ? $(config.org).first().text().trim()   : '';
  const position = config.title ? $(config.title).first().text().trim() : '';

  // Deadline extraction (best-effort regex)
  let deadline = '';
  const patterns = [
    /deadline[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /due[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /closes?[:\s]*([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];
  const bodyText = $('body').text();
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      try   { deadline = new Date(match[1]).toISOString(); }
      catch { deadline = match[1]; }
      break;
    }
  }

  return { org, position, deadline, questions, platform };
}
