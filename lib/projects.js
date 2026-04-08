/**
 * Single source of truth for all project definitions.
 *
 * Each project has:
 *   key           — unique identifier, used in DB (never rename once in use)
 *   label         — display name
 *   group         — visual grouping on dashboard: 'life' | 'tech' | 'creative'
 *   color         — tile accent colour (hex)
 *   emoji         — tile icon
 *   keywords      — fast keyword-match routing (no AI cost)
 *   description   — used in AI router prompt
 *   system_prompt — injected as system context for chat in this project
 */

export const PROJECTS = [

  // ── Life & Study ────────────────────────────────────────────────────────────

  {
    key:         'school',
    label:       'School',
    group:       'life',
    color:       '#a78bfa',
    emoji:       '🎓',
    columns:     [
      { key: 'todo',      label: 'To Do'       },
      { key: 'doing',     label: 'In Progress' },
      { key: 'submitted', label: 'Submitted'   },
    ],
    keywords:    ['assignment', 'homework', 'due', 'exam', 'essay', 'class', 'lecture',
                  'semester', 'subject', 'coursework', 'study for', 'uni', 'university',
                  'college', 'school deadline', 'lab report', 'thesis', 'tute', 'tutorial class'],
    description: 'School assignments, deadlines, subjects, exams, coursework documents',
    system_prompt: `You are an academic assistant helping with school and university work.

When the user pastes a document (syllabus, unit outline, assignment brief):
  1. Extract and list every assessment: name, due date, weighting.
  2. Identify the subject/course name.
  3. Summarise what the assessment requires.
  4. Flag anything with a deadline within 2 weeks.

For general study help: explain concepts clearly, suggest study approaches, help draft essays or lab reports. Be structured and precise.`,
  },

  {
    key:         'work',
    label:       'Work',
    group:       'life',
    color:       '#f59e0b',
    emoji:       '💼',
    columns:     [
      { key: 'todo',  label: 'To Do'       },
      { key: 'doing', label: 'In Progress' },
      { key: 'done',  label: 'Done'        },
    ],
    keywords:    ['for work', 'work task', 'work project', 'need for work', 'my job',
                  'sprint', 'pull request', 'pr review', 'deployment', 'production issue',
                  '[for work]', 'deadline at work', 'team project', 'standup', 'ticket'],
    description: 'Work tasks, professional deadlines, things needed for your job',
    system_prompt: 'You are a professional work assistant. Help with work tasks, technical problems, and professional deliverables. Be concise, practical, and action-oriented. Focus on what needs to get done and in what order.',
  },

  {
    key:         'research_apps',
    label:       'Research Applications',
    group:       'life',
    color:       '#6b8aed',
    emoji:       '🔬',
    columns:     [
      { key: 'backlog',   label: 'Saved'     },
      { key: 'drafting',  label: 'Drafting'  },
      { key: 'review',    label: 'Review'    },
      { key: 'submitted', label: 'Submitted' },
    ],
    keywords:    ['fellowship', 'application', 'apply', 'residency', 'internship',
                  'job application', 'position', 'opening', 'hire'],
    description: 'Fellowship applications, research residencies, job applications, internships',
    system_prompt: 'You are an expert fellowship and research application advisor. Help draft thoughtful, specific, and compelling application answers. Be direct — provide concrete draft text, then explain your reasoning concisely.',
  },

  {
    key:         'exercise',
    label:       'Exercise',
    group:       'life',
    color:       '#e06b6b',
    emoji:       '💪',
    columns:     [
      { key: 'planned', label: 'Planned'    },
      { key: 'active',  label: 'This Week'  },
      { key: 'done',    label: 'Done'       },
    ],
    keywords:    ['workout', 'exercise', 'gym', 'run', 'training', 'split', 'lift',
                  'cardio', 'stretch', 'program'],
    description: 'Workout plans, exercise routines, training programs, movement ideas',
    system_prompt: 'You are a knowledgeable fitness coach. Give clear, safe, evidence-based training advice. Tailor recommendations to the user\'s goals and constraints.',
  },

  // ── Tech & Learning ─────────────────────────────────────────────────────────

  {
    key:         'learning_tech',
    label:       'Learning & Tech',
    group:       'tech',
    color:       '#4db88a',
    emoji:       '📚',
    columns:     [
      { key: 'backlog', label: 'Want to Learn' },
      { key: 'active',  label: 'Doing Now'     },
      { key: 'done',    label: 'Done', collapsed: true },
    ],
    keywords:    ['want to learn', 'course', 'study', 'understand', 'explain', 'how does',
                  'what is', 'blog post', 'paper', 'github', 'github.com', 'repo', 'repository',
                  'ml', 'machine learning', 'deep learning', 'neural', 'transformer', 'dataset',
                  'arxiv', 'algorithm', 'pytorch', 'tensorflow', 'llm', 'tutorial',
                  'research paper', 'diffusion', 'fine-tune', 'embedding', 'hugging face',
                  'colab', 'notebook', '[personal learning]'],
    description: 'Personal learning: papers, GitHub repos, ML models, courses, tech concepts to explore',
    system_prompt: 'You are a knowledgeable tech and learning guide. Help the user understand concepts clearly and practically. Connect ideas, give analogies, and point toward deeper resources when relevant.',
  },

  {
    key:         'circuitry',
    label:       'Electronics & Circuits',
    group:       'tech',
    color:       '#22d3ee',
    emoji:       '⚡',
    columns:     [
      { key: 'ideas',    label: 'Ideas'    },
      { key: 'building', label: 'Building' },
      { key: 'done',     label: 'Done', collapsed: true },
    ],
    keywords:    ['arduino', 'circuit', 'resistor', 'capacitor', 'pcb', 'solder',
                  'microcontroller', 'raspberry pi', 'gpio', 'voltage', 'schematic',
                  'breadboard', 'transistor', 'esp32', 'sensor', 'electronics', 'oscilloscope',
                  'multimeter', 'led', 'servo', 'motor driver', 'i2c', 'spi', 'uart'],
    description: 'Personal electronics projects, circuits, Arduino, PCB design, microcontrollers',
    system_prompt: 'You are an electronics and circuits expert. Help with circuit design, component selection, Arduino/microcontroller programming, and debugging. Be specific with component values, wiring diagrams, and code. Explain the underlying electrical principles when helpful.',
  },

  // ── Creative ────────────────────────────────────────────────────────────────

  {
    key:         'baking',
    label:       'Baking',
    group:       'creative',
    color:       '#c4925a',
    emoji:       '🍞',
    columns:     [
      { key: 'ideas',  label: 'Ideas'  },
      { key: 'making', label: 'Making' },
      { key: 'done',   label: 'Made', collapsed: true },
    ],
    keywords:    ['recipe', 'bake', 'baking', 'bread', 'cake', 'cookie', 'flour',
                  'sourdough', 'pastry', 'dough', 'oven', 'proof', 'knead'],
    description: 'Recipes, baking ideas, ingredient ratios, fermentation, techniques',
    system_prompt: 'You are an expert baker. Give precise, practical baking guidance with exact ratios, temperatures, and techniques. Explain the science behind the steps.',
  },

  {
    key:         'beadwork',
    label:       'Bead Work',
    group:       'creative',
    color:       '#f472b6',
    emoji:       '📿',
    columns:     [
      { key: 'ideas',  label: 'Ideas'  },
      { key: 'making', label: 'Making' },
      { key: 'done',   label: 'Done', collapsed: true },
    ],
    keywords:    ['bead', 'beads', 'beading', 'jewelry', 'bracelet', 'necklace', 'loom',
                  'thread', 'wire wrap', 'pendant', 'seed bead', 'crystal', 'gemstone',
                  'peyote', 'brick stitch', 'stringing', 'clasps'],
    description: 'Bead work, jewelry making, loom patterns, wire wrapping, macramé',
    system_prompt: 'You are a bead work and jewelry making guide. Help with patterns, stitch techniques, material selection, thread/wire choices, and project ideas. Be specific about bead sizes (e.g. 11/0, 8/0), thread weights, and step counts.',
  },

  {
    key:         'art',
    label:       'Visual Art',
    group:       'creative',
    color:       '#c47be0',
    emoji:       '🎨',
    columns:     [
      { key: 'ideas',    label: 'Ideas'    },
      { key: 'creating', label: 'Creating' },
      { key: 'done',     label: 'Done', collapsed: true },
    ],
    keywords:    ['pastel', 'pastels', 'sketch', 'sketching', 'draw', 'drawing', 'paint',
                  'watercolor', 'pencil', 'charcoal', 'shading', 'portrait', 'still life',
                  'landscape', 'composition', 'colour mixing', 'canvas', 'life drawing',
                  'value study', 'gesture'],
    description: 'Pastels, sketching, drawing, painting, visual art practice',
    system_prompt: 'You are a visual art guide. Help with pastel techniques, sketching exercises, composition, and colour mixing. Be specific about materials, mark-making, and process. Reference artists and techniques when relevant.',
  },

  {
    key:         'reading',
    label:       'Reading',
    group:       'creative',
    color:       '#e8994a',
    emoji:       '📖',
    columns:     [
      { key: 'backlog', label: 'Want to Read' },
      { key: 'active',  label: 'Reading'      },
      { key: 'done',    label: 'Read', collapsed: true },
    ],
    keywords:    ['book', 'read', 'philosophy', 'novel', 'essay', 'article', 'author',
                  'chapter', 'passage', 'quote'],
    description: 'Books, essays, philosophy, articles to read or discuss',
    system_prompt: 'You are a thoughtful literary and philosophical discussion partner. Help explore ideas deeply. Ask probing questions, surface tensions, and connect to broader intellectual traditions.',
  },

];

/** Get a project by key, or undefined if not found. */
export function getProject(key) {
  return PROJECTS.find(p => p.key === key);
}

/** Get all projects in a group. */
export function getProjectsByGroup(group) {
  return PROJECTS.filter(p => p.group === group);
}

export const GROUPS = [
  { key: 'life',     label: 'Life & Study' },
  { key: 'tech',     label: 'Tech & Learning' },
  { key: 'creative', label: 'Creative' },
];
