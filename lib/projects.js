/**
 * Single source of truth for all project definitions.
 * Add, remove, or rename projects here — router + API will pick up changes.
 */

export const PROJECTS = [
  {
    key:         'research_apps',
    label:       'Research Applications',
    color:       '#6b8aed',
    emoji:       '🔬',
    keywords:    ['fellowship', 'application', 'apply', 'residency', 'internship', 'job', 'position', 'opening', 'deadline', 'hire'],
    description: 'Fellowship applications, research residencies, job applications, internships',
  },
  {
    key:         'learning_tech',
    label:       'Learning & Tech',
    color:       '#4db88a',
    emoji:       '📚',
    keywords:    ['want to learn', 'course', 'study', 'understand', 'explain', 'how does', 'what is', 'blog post', 'paper'],
    description: 'Things to learn, papers to read, courses, tutorials, tech concepts to explore',
  },
  {
    key:         'reading',
    label:       'Reading',
    color:       '#e8994a',
    emoji:       '📖',
    keywords:    ['book', 'read', 'philosophy', 'novel', 'essay', 'article', 'author', 'chapter', 'passage', 'quote'],
    description: 'Books, essays, philosophy, articles to read or discuss',
  },
  {
    key:         'baking',
    label:       'Baking',
    color:       '#c4925a',
    emoji:       '🍞',
    keywords:    ['recipe', 'bake', 'baking', 'bread', 'cake', 'cookie', 'flour', 'sourdough', 'pastry', 'dough'],
    description: 'Recipes, baking ideas, ingredient ratios, techniques',
  },
  {
    key:         'exercise',
    label:       'Exercise',
    color:       '#e06b6b',
    emoji:       '💪',
    keywords:    ['workout', 'exercise', 'gym', 'run', 'training', 'split', 'lift', 'cardio', 'stretch', 'program'],
    description: 'Workout plans, exercise routines, training programs, movement ideas',
  },
  {
    key:         'art',
    label:       'Art & Making',
    color:       '#c47be0',
    emoji:       '🎨',
    keywords:    ['art', 'draw', 'paint', 'watercolor', 'sketch', 'design', 'craft', 'make', 'create', 'tutorial'],
    description: 'Art projects, drawing and painting techniques, crafts, design ideas',
  },
];

/** Get a project by key, or undefined if not found. */
export function getProject(key) {
  return PROJECTS.find(p => p.key === key);
}
