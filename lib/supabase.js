import { createClient } from '@supabase/supabase-js';

// Anon client — safe to use in browser and server route handlers
// Uses Row Level Security policies in Supabase
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Service-role client — server-side only, bypasses RLS
// Never expose SUPABASE_SERVICE_KEY to the browser
export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );
}
