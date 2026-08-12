# Telegram <-> Claude group bot

A small bot that lets Claude participate in a Telegram group: answers when
mentioned or replied to, and can summarize recent chat with `/summary`.

## 1. Create the Telegram bot
1. Open Telegram, message **@BotFather**.
2. `/newbot` -> follow prompts -> copy the token it gives you.
3. `/setprivacy` -> select your bot -> **Disable**. This lets it read all
   group messages (needed for summaries and for detecting mentions), not
   just commands.
4. Add the bot to your group as a member.

## 2. Get an Anthropic API key
Create one at https://console.anthropic.com (Settings -> API Keys).

## 3. Run it

### Locally
```bash
cd tg-claude-bot
npm install
export TELEGRAM_BOT_TOKEN=your_token_here
export ANTHROPIC_API_KEY=your_key_here
npm start
```

### Deploy on Railway (recommended for 24/7 uptime)
1. Push this folder to a GitHub repo.
2. Go to railway.app -> New Project -> Deploy from GitHub repo.
3. In the project's Variables tab, add `TELEGRAM_BOT_TOKEN` and
   `ANTHROPIC_API_KEY`.
4. Railway will detect the Node app and run `npm start` automatically.

### Deploy on a VPS
```bash
git clone <your repo>
cd tg-claude-bot
npm install
npm install -g pm2
TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... pm2 start bot.js --name tg-claude-bot
pm2 save
pm2 startup   # follow the printed instructions so it survives reboots
```

## Usage in the group
- `@yourbotname <question>` — ask something, gets a reply with recent chat as context
- Reply directly to one of the bot's messages — continues the thread
- `/ask <question>` — same as mentioning it
- `/info` — sends your exact mentorship description: what you offer, pricing, mentors, and the disclaimer that a visa is never guaranteed. This is fixed text, not AI-generated, so the numbers are always exact.
- `/summary` — recap of the last ~80 messages
- `/help` — quick usage reminder (in English and Russian)

## Language
The bot replies in Russian by default, and switches to English if the person it's replying to wrote in English. It won't reply in any other language.

## Updating your pricing / mentor info
Open `bot.js` and edit the `SERVICE_INFO` constant near the top. It's sent verbatim for `/info`, and also given to Claude as ground truth whenever someone asks how the mentorship works, what it costs, or who the mentors are — so keep it current (prices, mentor bios, this year's success count, etc.) and Claude won't make up or round numbers on its own.

## Notes / limits
- Chat history is kept in memory only (per chat, capped at 200 messages) and
  resets if the process restarts. For persistent history across restarts,
  you'd want to swap the in-memory Map for a small database (e.g. SQLite or
  Redis) — ask if you'd like that added.
- Each Claude API call costs money based on usage — check current pricing at
  https://www.anthropic.com/pricing.
- You are responsible for how the bot behaves in your group and for keeping
  your API key private (never commit it to a public repo).
