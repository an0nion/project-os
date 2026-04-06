/**
 * Telegram — optional secondary notification channel.
 * Completely free. Use when phone notifications outside Slack are wanted.
 *
 * Setup (one-time):
 *   1. Message @BotFather → /newbot → copy token
 *   2. Message your bot to open a chat
 *   3. Get chat ID: curl https://api.telegram.org/bot<TOKEN>/getUpdates
 *   4. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local
 *
 * If env vars are missing, all calls silently no-op.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a plain or button message via Telegram.
 *
 * @param {string} message - Markdown-formatted message
 * @param {Array<{text: string, url?: string, data?: string}>} [buttons]
 */
export async function sendTelegramNotif(message, buttons = []) {
  if (!BOT_TOKEN || !CHAT_ID) return; // Not configured — skip silently

  const body = {
    chat_id:    CHAT_ID,
    text:       message,
    parse_mode: 'Markdown',
  };

  if (buttons.length) {
    body.reply_markup = {
      inline_keyboard: [
        buttons.map(b => ({
          text: b.text,
          ...(b.url ? { url: b.url } : { callback_data: b.data }),
        })),
      ],
    };
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[Telegram] Send failed:', err.message);
  }
}

/**
 * Send deadline nudge message.
 *
 * @param {Array<{org, deadline, status, questions}>} apps
 */
export async function sendDeadlineNudge(apps) {
  const urgent = apps.filter(a => {
    const daysLeft = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    return daysLeft >= 0 && daysLeft <= 7 && a.status !== 'submitted';
  });

  if (urgent.length === 0) return;

  let text = '📋 *Upcoming deadlines:*\n\n';
  for (const a of urgent) {
    const d     = Math.ceil((new Date(a.deadline) - new Date()) / 86_400_000);
    const emoji = d <= 1 ? '🔴' : d <= 3 ? '🟡' : '⚪';
    const unanswered = (a.questions ?? []).filter(q => !q.answer?.trim()).length;
    text += `${emoji} *${a.org}* — ${d}d left${unanswered ? ` (${unanswered} unanswered)` : ''}\n`;
  }

  await sendTelegramNotif(text, [
    { text: '✍️ Open app', url: process.env.APP_URL },
  ]);
}
