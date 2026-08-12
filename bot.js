// Telegram <-> Claude relay bot
//
// Setup:
//   1. npm install
//   2. Set environment variables:
//        TELEGRAM_BOT_TOKEN   - from @BotFather
//        ANTHROPIC_API_KEY    - from console.anthropic.com
//   3. In BotFather, disable group privacy (/setprivacy -> Disable) so the
//      bot can see all messages in the group, not just commands.
//   4. node bot.js
//
// Behavior:
//   - Keeps a rolling log of recent messages per chat (in memory).
//   - Replies with Claude when: the bot is @mentioned, someone replies to
//     one of the bot's messages, or the /ask command is used.
//   - /summary summarizes recent chat activity.
//   - /info sends the exact mentorship/pricing/mentor description (see the
//     editable SERVICE_INFO block below — update it whenever prices, mentor
//     bios, or yearly stats change).
//   - /help explains commands (in English and Russian).
//   - Replies default to Russian, switching to English if the person it's
//     replying to wrote in English.

import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  console.error(
    "Missing required env vars. Set TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY."
  );
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// --- context-specific system prompts ---
// This group is for people (based in Italy) who have done or are pursuing
// the Work and Travel USA program (typically the J-1 visa), sharing
// experience with applications, sponsors, jobs, housing, and the visa
// process itself. The prompts below keep Claude's answers relevant and
// appropriately cautious on visa/immigration topics.

// EDIT ME: keep this block up to date (prices, mentor bios, yearly stats,
// etc.) — the bot quotes it directly for /info and leans on it for any
// question about "how this works", pricing, or the mentors, so accuracy
// here matters more than anywhere else in the file.
const SERVICE_INFO = `We help students go through the Work and Travel USA program, which lets you legally work and travel around the US during summer break.

Important: we are not a consulting company. You can go through the whole process on your own. Our role is to provide mentorship and share practical experience — explaining what to do and when, how to prepare documents correctly, how to find a good job, and how to avoid common mistakes.

We also run a private Telegram group made up of students from Italy who took part in Work and Travel this year. Only people who actually got their visa and are currently in the US are admitted to the group. By talking with people who have already been through the whole process in practice, you get up-to-date information, real advice, and better preparation for your own participation.

If you work with us, you get two mentors:
- Behruz — has done Work and Travel USA twice.
- Saloh — did the program last summer and is in the US again this summer on Work and Travel.

We support you at every stage, sharing the real experience of people who have walked this path themselves.

Pricing:
- Our mentorship fee: €300
- Sponsor program fee: roughly €1,700
- Total cost for Work and Travel: roughly €2,000

If everything is done on time and prepared properly, getting the visa is realistically achievable — especially applying from Europe. That said, no one can ever guarantee a visa is issued, since the final decision is made by the consul during the interview, and that's always a subjective process. What we can do is help with preparation, give you the information you need, help with documents, and prepare you for the interview to maximize your chances of success.

This year, 35 participants from our group in Italy successfully got their Work & Travel visa. That's not a guarantee for anyone else, but it shows that with the right preparation and following requirements, approval odds are genuinely high.`;

const GROUP_CONTEXT = `This is a private Telegram group for people in Italy who are doing, or want to do, the Work and Travel USA program (commonly via a J-1 exchange visitor visa). Members share firsthand experience: sponsor programs, job placements, housing, visa interviews, DS-2019 forms, SEVIS fees, and general logistics of working and traveling in the US on this program. The group is run by a mentor (the person operating this bot) who offers a paid mentorship service alongside it. Here are the exact, up-to-date facts about that service — use them whenever someone asks how this works, what it costs, who the mentors are, or how to join:

"""
${SERVICE_INFO}
"""`;

const LANGUAGE_INSTRUCTION = `This group communicates in Russian and English. Reply in Russian by default, unless the person you're responding to wrote in English, in which case reply in English. Never reply in any other language, even if a message is written in one.`;

const ASK_SYSTEM_PROMPT = `You are a helpful assistant in a private Telegram group. ${GROUP_CONTEXT}

Guidelines:
- Keep replies concise and conversational, suited for a chat app (a few sentences to a short paragraph; use a list only if it truly helps).
- When asked about the mentorship service, pricing, the mentors, or how to join the group, answer using the exact facts given above — don't round numbers, invent details, or add anything not stated there.
- You can also share general, publicly known information about the J-1 Work and Travel program, visa interview prep, sponsor organizations, typical timelines, and similar logistics.
- You are not a lawyer or an official source. For anything specific to someone's individual visa case, sponsor requirements, or legal eligibility, say so plainly and suggest they confirm with their sponsor organization, the U.S. Embassy/Consulate, or a qualified immigration attorney.
- Never state or imply a guaranteed outcome (e.g. "you will get approved") for an individual's visa or application — echo the group's own framing that no one can guarantee a visa, since the consul's decision is subjective.
- If information may be outdated or you're unsure, say so rather than guessing.
- ${LANGUAGE_INSTRUCTION}`;

const SUMMARY_SYSTEM_PROMPT = `You summarize activity in a private Telegram group. ${GROUP_CONTEXT}

Summarize concisely and neutrally in 3-6 bullet points. Focus on: questions members asked, tips or experiences shared (e.g. about sponsors, interviews, jobs, housing), and any decisions or plans made. Don't editorialize, and don't state any visa/legal outcome as certain. ${LANGUAGE_INSTRUCTION}`;

// --- in-memory per-chat history (resets if the process restarts) ---
const HISTORY_LIMIT = 200; // messages kept per chat
const chatHistories = new Map(); // chatId -> [{name, text, ts}]

function pushHistory(chatId, entry) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  const hist = chatHistories.get(chatId);
  hist.push(entry);
  if (hist.length > HISTORY_LIMIT) hist.shift();
}

function formatHistory(chatId, count = 50) {
  const hist = chatHistories.get(chatId) || [];
  return hist
    .slice(-count)
    .map((m) => `${m.name}: ${m.text}`)
    .join("\n");
}

async function askClaude(systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

let botUsername = null;
bot.getMe().then((me) => {
  botUsername = me.username;
  console.log(`Bot started as @${botUsername}`);
});

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const senderName =
    msg.from.username || msg.from.first_name || "someone";

  // Log every message for context/summary purposes
  pushHistory(chatId, { name: senderName, text: msg.text, ts: msg.date });

  const text = msg.text.trim();

  // /help
  if (text === "/help") {
    await bot.sendMessage(
      chatId,
      "I'm here to help with Work and Travel USA questions! Mention me (@" +
        botUsername +
        ") or reply to one of my messages to ask something. Use /info for details on how the mentorship works and pricing, /summary for a recap of recent chat, or /ask <question> to ask me directly. Note: I'm not a lawyer or an official source — always confirm visa-specific details with your sponsor or the U.S. Embassy.\n\n" +
        "Я помогаю с вопросами по Work and Travel USA! Упомяните меня (@" +
        botUsername +
        ") или ответьте на моё сообщение, чтобы задать вопрос. Команда /info — как устроена менторская программа и цены, /summary — краткий пересказ последних сообщений, /ask <вопрос> — задать вопрос напрямую. Я не юрист и не официальный источник — уточняйте детали визы у вашего спонсора или посольства США."
    );
    return;
  }

  // /info - sends the exact, fixed service description (not AI-generated,
  // so pricing/names/stats are always exact)
  if (text === "/info") {
    await bot.sendMessage(chatId, SERVICE_INFO);
    return;
  }

  // /summary
  if (text === "/summary" || text.startsWith("/summary ")) {
    const recent = formatHistory(chatId, 80);
    if (!recent) {
      await bot.sendMessage(chatId, "Not enough recent messages to summarize yet.");
      return;
    }
    try {
      const summary = await askClaude(
        SUMMARY_SYSTEM_PROMPT,
        `Summarize the key points/discussion from this group chat log:\n\n${recent}`
      );
      await bot.sendMessage(chatId, summary);
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "Sorry, I couldn't generate a summary just now.");
    }
    return;
  }

  // /ask <question>
  const isAskCommand = text.startsWith("/ask ");
  const isMentioned = botUsername && text.includes("@" + botUsername);
  const isReplyToBot =
    msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot;

  if (isAskCommand || isMentioned || isReplyToBot) {
    const question = isAskCommand
      ? text.slice(5).trim()
      : text.replace("@" + botUsername, "").trim();

    if (!question) return;

    const recentContext = formatHistory(chatId, 20);

    try {
      const reply = await askClaude(
        ASK_SYSTEM_PROMPT,
        `Recent conversation for context:\n${recentContext}\n\nRespond to this message from ${senderName}: ${question}`
      );
      await bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "Sorry, I ran into an error answering that.");
    }
  }
});

bot.on("polling_error", (err) => console.error("Polling error:", err));
