/**
 * Single source of truth for all project definitions.
 * Each project now includes a system_prompt used by the chat API.
 */

export const PROJECTS = [
  {
    key:         'research_apps',
    label:       'Research Applications',
    color:       '#6b8aed',
    emoji:       '🔬',
    keywords:    ['fellowship', 'application', 'apply', 'residency', 'internship', 'job', 'position', 'opening', 'deadline', 'hire'],
    description: 'Fellowship applications, research residencies, job applications, internships',
    system_prompt: 'You are an expert fellowship and research application advisor. Help the user draft thoughtful, specific, and compelling application answers. Be direct — provide concrete draft text, then explain your reasoning concisely.',
  },
  {
    key:         'learning_tech',
    label:       'Learning & Tech',
    color:       '#4db88a',
    emoji:       '📚',
    keywords:    ['want to learn', 'course', 'study', 'understand', 'explain', 'how does', 'what is', 'blog post', 'paper'],
    description: 'Things to learn, papers to read, courses, tutorials, tech concepts to explore',
    system_prompt: 'You are a knowledgeable tech and learning guide. Help the user understand concepts clearly and practically. Connect ideas, give analogies, and point toward deeper resources when relevant.',
  },
  {
    key:         'reading',
    label:       'Reading',
    color:       '#e8994a',
    emoji:       '📖',
    keywords:    ['book', 'read', 'philosophy', 'novel', 'essay', 'article', 'author', 'chapter', 'passage', 'quote'],
    description: 'Books, essays, philosophy, articles to read or discuss',
    system_prompt: 'You are a thoughtful literary and philosophical discussion partner. Help the user explore ideas from texts deeply. Ask probing questions, surface tensions, and connect to broader intellectual traditions.',
  },
  {
    key:         'baking',
    label:       'Baking',
    color:       '#c4925a',
    emoji:       '🍞',
    keywords:    ['recipe', 'bake', 'baking', 'bread', 'cake', 'cookie', 'flour', 'sourdough', 'pastry', 'dough'],
    description: 'Recipes, baking ideas, ingredient ratios, techniques',
    system_prompt: 'You are an expert baker. Give precise, practical baking guidance with exact ratios, temperatures, and techniques. Explain the science behind the steps.',
  },
  {
    key:         'exercise',
    label:       'Exercise',
    color:       '#e06b6b',
    emoji:       '💪',
    keywords:    ['workout', 'exercise', 'gym', 'run', 'training', 'split', 'lift', 'cardio', 'stretch', 'program'],
    description: 'Workout plans, exercise routines, training programs, movement ideas',
    system_prompt: 'You are a knowledgeable fitness coach. Give clear, safe, evidence-based training advice. Tailor recommendations to the user\'s goals and constraints.',
  },
  {
    key:         'art',
    label:       'Art & Making',
    color:       '#c47be0',
    emoji:       '🎨',
    keywords:    ['art', 'draw', 'paint', 'watercolor', 'sketch', 'design', 'craft', 'make', 'create', 'tutorial'],
    description: 'Art projects, drawing and painting techniques, crafts, design ideas',
    system_prompt: 'You are a creative art and making guide. Help the user with techniques, materials, and creative direction. Be encouraging and specific about process.',
  },
];

/** Get a project by key, or undefined if not found. */
export function getProject(key) {
  return PROJECTS.find(p => p.key === key);
}
