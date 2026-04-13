/**
 * Intent classifier prompt and constants — shared between bot.js and tests.
 *
 * Keeping these here avoids test drift: the test file imports from this module
 * instead of duplicating the prompt, so any edits here are instantly reflected
 * in tests without a separate sync step.
 */

export const PROJECT_KEYS = [
  'personal', 'school', 'work', 'research_apps', 'learning_tech',
  'baking', 'beadwork', 'art', 'reading', 'exercise', 'circuitry',
];

export const VALID_INTENTS = [
  'save', 'correct', 'edit', 'converse', 'search_request', 'reminder', 'recall', 'web_search', 'preferences',
];

export const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a personal project management Slack bot.

The user may send ONE task or MULTIPLE tasks in a single message (e.g. "remind me to X, also add Y").
Always return an array of tasks — even if there is only one.

Return ONLY valid JSON (no markdown):
{
  "tasks": [
    {
      "intent": "save" | "reminder" | "recall" | "correct" | "edit" | "search_request" | "web_search" | "preferences" | "converse",
      "title": string,
      "timeline": string or null,
      "context": "work" | "personal" | null,
      "project_hint": string or null,
      "priority_tier": 1 | 2 | 3 | 4 | null,
      "needs_clarification": boolean,
      "corrected_project": string or null,
      "recall_topic": string or null,
      "search_query": string or null,
      "edit_field": "due_date" | "title" | "status" | "notes" | "project_key" | null,
      "edit_value": string or null
    }
  ]
}

INTENT:
- "reminder": user wants to be reminded / notified / has an appointment or deadline
- "recall": asking what was previously saved — "what did I save about X?", "what do I have on Y?"
- "web_search": user wants to look something up in real time — event dates, locations, deadlines of external things, "when is X", "what time does Y start", "where is Z being held", "find the date of". Use this for anything requiring live information NOT stored by the bot.
- "preferences": user wants to view or change bot settings — "preferences", "set preferences", "change settings", "update my settings", "configure"
- "converse": greetings, one-word reactions, meta-questions about the bot
- "correct": user says last save was routed wrong
- "edit": user wants to modify an existing saved item — "change the deadline on X to Y", "update X to say Y", "rename X to Y", "mark X as done", "move X to project Y"
- "search_request": wants to apply to a program/fellowship but gave no URL
- "save": everything else — save a URL, paper, task, note, resource

title: clean, actionable task name. Strip filler: "remind me to", "set a reminder", "set a notification", "also", dates, time phrases. Capitalise first word. Max 8 words.
  Examples:
    "set a reminder for this Saturday to buy cleansing oil" → "Buy cleansing oil"
    "set an assignment notification for the 13th for linear algebra Assignment 2" → "Linear Algebra Assignment 2"
    "I want to save this arxiv paper on diffusion" → "Diffusion paper (arxiv)"

timeline: the specific date/time string for this task only, as the user said it. null if none.
  Examples: "this Saturday", "13th of this month", "by June 30", "5:30pm Thursday"

search_query: only if intent=web_search — an optimised search query (proper nouns, event name, location). Strip meta-phrasing like "what's the date of" or "when is". Keep the subject.
  Examples: "when is the Square Peg Claude Code event Melbourne" → "Square Peg Claude Code event Melbourne luma"

project_hint: one of ${PROJECT_KEYS.join(', ')} or null:
  personal=appointments/errands/life admin, school=coursework/exams/uni,
  work=job tasks/sprint/tickets, research_apps=fellowships/grants/PhD,
  learning_tech=papers/ML/repos, baking=recipes/bread, beadwork=jewelry/craft,
  art=drawing/pastels, reading=books/essays, exercise=gym/sport, circuitry=Arduino/PCB

priority_tier:
  1=hard deadline (specific date, exam, submission)
  2=medium deadline (school/work task, weeks away)
  3=medium goal (personal learning, no firm date)
  4=hobby/interest (baking/art/reading/exercise)
  null=unclear

needs_clarification: true only if intent=save AND context null AND tech content (work vs personal unclear)
corrected_project: only if intent=correct AND user named a project
recall_topic: only if intent=recall — the topic to search for, stripped of meta-phrasing
edit_field: only if intent=edit — which field to change: due_date, title, status, notes, or project_key
edit_value: only if intent=edit — the new value as a plain string`;
