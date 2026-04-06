/**
 * Shared question categories used by both the scraper (questionExtractor)
 * and the parser (questionParser). Single source of truth.
 */

export const CATEGORY_KEYWORDS = {
  research_interests:  ['research interest', 'area of research', 'research focus', 'research direction', 'interested in studying'],
  research_statement:  ['research statement', 'research project', 'research experience', 'describe a project', 'research you led'],
  motivation:          ['why', 'motivation', 'interested in this', 'what draws you', 'why apply', 'why this fellowship'],
  methodology:         ['method', 'methodology', 'technique', 'approach', 'tools you use', 'technical approach'],
  publications:        ['publication', 'paper', 'published', 'cite', 'written work'],
  collaboration:       ['collaborat', 'team', 'work with others', 'group project', 'interdisciplinary'],
  future_directions:   ['future', 'vision', 'next 3', 'next 5', 'long-term', 'where do you see'],
  technical_skills:    ['technical skill', 'programming', 'software', 'language', 'framework', 'proficien'],
  background:          ['background', 'about yourself', 'introduce yourself', 'tell us about you', 'bio'],
  diversity_statement: ['diversity', 'equity', 'inclusion', 'underrepresented', 'dei'],
  travel_logistics:    ['travel', 'relocat', 'location', 'visa', 'work authorization', 'remote'],
  availability:        ['available', 'start date', 'when can you', 'earliest start', 'preferred start'],
};

export function categorize(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'other';
}

// Indicators that a label is a substantive question (not just a form field)
export const QUESTION_INDICATORS = [
  'describe', 'explain', 'tell us', 'what', 'why', 'how', 'please provide',
  'share', 'discuss', 'detail', 'outline', 'elaborate', 'research',
  'experience', 'interest', 'motivation', 'statement', 'vision',
  'publication', 'project', 'methodology', 'approach', 'contribution',
  'diversity', 'background', 'skills', 'collaboration', 'future',
  'track', 'location', 'availability', 'start date', 'preferred',
];

// Simple form fields to skip
export const SKIP_FIELDS = [
  'first name', 'last name', 'full name', 'email', 'phone',
  'address', 'city', 'state', 'zip', 'country', 'resume',
  'cv', 'upload', 'file', 'linkedin', 'website', 'url',
  'captcha', 'submit', 'password', 'confirm',
];
