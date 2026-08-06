# Complete Telegram Bot Guide — Revit Bridge

Language: [Bahasa Indonesia](./TELEGRAM-BOT-GUIDE.id.md) · **English**

This covers the whole Telegram surface: from creating the bot in BotFather to
the byte limits that make `sendMessage` fail with a 400. Numbers and method
names follow the Telegram Bot API; anything worth re-checking is marked
**[verify]** in the last section.

---

## Contents

1. [System shape](#1-system-shape)
2. [Creating the bot in BotFather](#2-creating-the-bot-in-botfather)
3. [The token and its security](#3-the-token-and-its-security)
4. [Webhook](#4-webhook)
5. [Bilingual command menu](#5-bilingual-command-menu)
6. [Full command reference](#6-full-command-reference)
7. [User preferences: /lang and /theme](#7-user-preferences-lang-and-theme)
8. [Hard Telegram limits](#8-hard-telegram-limits)
9. [Message formatting (MarkdownV2)](#9-message-formatting-markdownv2)
10. [Sending files](#10-sending-files)
11. [Buttons, callbacks, two-step confirmation](#11-buttons-callbacks-two-step-confirmation)
12. [Web panel (Mini App)](#12-web-panel-mini-app)
13. [Errors, retries, rate limits](#13-errors-retries-rate-limits)
14. [Roles and permissions](#14-roles-and-permissions)
15. [Deploy checklist](#15-deploy-checklist)
16. [Troubleshooting](#16-troubleshooting)
17. [What to verify yourself](#17-what-to-verify-yourself)

---

## 1. System shape

```
Telegram user
   │  /pdf LP-01
   ▼
Telegram ──webhook──► Vercel (/api/telegram/webhook)
                          │ validate user, role, limits
                          ▼
                      Supabase (commands table, status: pending)
                          ▲
                          │ POST /api/machine/claim  ← add-in polls every 4s
                          │ (doubles as heartbeat)
                      Revit add-in
                          │ ExternalEvent.Raise() → main thread
                          ▼
                      Revit API (export / collector)
                          │
                          ▼
                      POST /api/machine/report ──► edit the "⏳" message, send file
```

Three facts drive this shape:

1. **The Revit PC has no public IP.** The server cannot call the add-in; the
   add-in must reach out. Everything is a *pull*.
2. **The Revit API only lives inside the `Revit.exe` process.** Revit has to be
   open. If it is closed, commands queue until they expire (10 minutes).
3. **The Revit API may only be called from the main thread.** Poll in the
   background, execute through `ExternalEvent`.

Practical consequence: **zero clicks in Revit.** The worker starts from
`OnStartup`.

---

## 2. Creating the bot in BotFather

Talk to [@BotFather](https://t.me/BotFather).

### Required steps

| Command | Input | Notes |
|---|---|---|
| `/newbot` | display name, then username | The username **must** end in `bot` or `_bot`, and be globally unique |
| — | save the token it prints | Format `123456789:AAF…`; the part before `:` is the bot ID |
| `/setprivacy` | **Enabled** | Privacy mode on means that in groups the bot only receives messages starting with `/` or replies to itself. Leave it on |
| `/setjoingroups` | **Disable** | This bot is used in private chats. Closing the group door shrinks the attack surface |

### Cosmetic steps (recommended)

| Command | Limit | Where it shows |
|---|---|---|
| `/setdescription` | ~512 chars | The empty-chat screen, before the first message |
| `/setabouttext` | ~120 chars | The bot's profile page and search results |
| `/setuserpic` | square image | Avatar |
| `/setcommands` | see §5 | The `/` menu in the composer |

> **Do not use BotFather's `/setcommands` for this bot.** It can only set one
> list, with no language and no scope. Bilingual menus and hidden admin commands
> need the `setMyCommands` API method — see §5. `scripts/set-commands.ts` already
> does it.

### Descriptions in use

English:

> ⚡ Revit electrical model bot. Live while Revit is open (working hours).
> Internal tool, not a 24/7 service.

Indonesian:

> ⚡ Bot data model elektrikal Revit. Aktif saat Revit terbuka (jam kerja).
> Bot internal, bukan layanan 24/7.

Calling it "an internal experiment" from day one is not modesty theatre. It sets
looser expectations automatically, and it leaves room to switch the thing off
without it feeling like an outage.

---

## 3. The token and its security

The token is a full credential. Anyone holding it can read every incoming
message and post as the bot.

| Rule | Why |
|---|---|
| Keep it in an environment variable (`TELEGRAM_BOT_TOKEN`), never in the repo | Repos go public; git history does not forget cleanly |
| Never ship it inside the add-in DLL | The DLL sits on a PC anyone can copy. The add-in uses a separate *machine token* |
| Machine token on the PC: store in `%APPDATA%` encrypted with DPAPI (`ProtectedData.Protect`) | Bound to the Windows account; copied elsewhere it is garbage |
| If it leaks: `/revoke` in BotFather | The old token dies instantly — re-register the webhook afterwards |

Environment variables this project uses:

```bash
TELEGRAM_BOT_TOKEN=123456789:AAF…      # from BotFather
TELEGRAM_WEBHOOK_SECRET=…              # 1–256 chars, [A-Za-z0-9_-]
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…            # server-only, never ship to a client
MACHINE_TOKEN=…                        # used by the add-in for claim/report
PANEL_URL=https://…/web/index.html     # Mini App
ADMIN_CHAT_IDS=111111111,222222222     # for set-commands.ts
```

---

## 4. Webhook

### Registering

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://your-project.vercel.app/api/telegram/webhook",
    "secret_token": "'"$TELEGRAM_WEBHOOK_SECRET"'",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true,
    "max_connections": 20
  }'
```

| Parameter | Why this value |
|---|---|
| `url` | **HTTPS required.** Accepted ports: 443, 80, 88, 8443. Vercel is 443 |
| `secret_token` | Telegram sends it back in the `X-Telegram-Bot-Api-Secret-Token` header. Without it, anyone who learns the URL can post fake updates |
| `allowed_updates` | Restrict to what you handle. Fewer update types means fewer Vercel invocations |
| `drop_pending_updates` | On redeploy, discard the backlog so stale commands do not fire |
| `max_connections` | 1–100, default 40. For five users, 20 is plenty |

### Inspecting

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Look at:

- `pending_update_count` — if it climbs, your handler is slow or erroring
- `last_error_date` / `last_error_message` — usually a non-2xx response or a timeout
- `ip_address`, `url` — confirm it points at the deployment you think it does

### Handler rules

1. **Return 200 fast.** Telegram treats non-2xx as failure and redelivers the
   same update. Heavy work (querying Revit) must never be awaited inside the
   handler — insert into `commands`, reply "⏳", `return 200`.
2. **Verify the secret header before anything else.**
   ```ts
   if (!verifyWebhookSecret(req.headers.get('x-telegram-bot-api-secret-token')))
     return new Response('forbidden', { status: 403 });
   ```
3. **Be idempotent on `update_id`.** Retries carry the same `update_id`. Store
   the last one (or add a unique index) so a single timeout does not run `/pdf`
   twice.
4. **`setWebhook` and `getUpdates` are mutually exclusive.** If you ever tried
   long polling while debugging, call `deleteWebhook` first — and vice versa.

### The update shape in use

```jsonc
// message
{
  "update_id": 123,
  "message": {
    "message_id": 45,
    "from": { "id": 111, "language_code": "en", "first_name": "Bagus" },
    "chat": { "id": 111, "type": "private" },
    "date": 1780000000,
    "text": "/pdf LP-01",
    "entities": [{ "type": "bot_command", "offset": 0, "length": 4 }]
  }
}
```

`from.language_code` is what **auto** language mode reads (§7). It can be `id`,
`en`, `en-GB` and so on — take the part before the hyphen.

---

## 5. Bilingual command menu

What gets translated is the command **description**, not its name. Names stay
English in every language because that is what Telegram's menu matches across
clients — and renaming commands per language would break every tappable command
in old chat history.

```ts
// Default menu — the fallback for every language without a specific list
setMyCommands({ commands })

// Indonesian menu: clients whose app language is "id" use this one
setMyCommands({ commands: commandsID, language_code: 'id' })

// English menu
setMyCommands({ commands: commandsEN, language_code: 'en' })
```

Binding rules:

| Item | Limit |
|---|---|
| Commands per list | max 100 |
| Command name | 1–32 chars, only `a-z`, `0-9`, `_` |
| Description | 3–256 chars |
| `language_code` | two-letter ISO 639-1 (`id`, `en`), or omitted for the default |

`scripts/check-i18n.ts` enforces the name and description limits in CI, so a
menu that violates them never reaches production.

### Hiding admin commands

Admin commands are left out of the default list and installed per chat:

```ts
setMyCommands({
  commands: commandsAdmin,
  scope: { type: 'chat', chat_id: 111111111 },
  language_code: 'en',
})
```

Available scopes, broadest to narrowest: `default` → `all_private_chats` →
`all_group_chats` → `all_chat_administrators` → `chat` → `chat_administrators`
→ `chat_member`. The narrowest match wins.

> **Important:** hiding from the menu is **not** access control. A viewer can
> still type `/ifc` by hand. Role enforcement happens in the webhook (§14) and
> must stay there no matter how tidy the menu looks.

### Per-language bot descriptions

`setMyDescription`, `setMyShortDescription` and `setMyName` also accept
`language_code`. The same script sets all three:

```bash
TELEGRAM_BOT_TOKEN=… ADMIN_CHAT_IDS=111,222 npx tsx scripts/set-commands.ts
```

Re-run it whenever `api/_lib/commands.ts` or an i18n catalog changes.

---

## 6. Full command reference

**Role**: `viewer` is available to every active user; `admin` to admins only.
**Alias**: an alternative you can type instead of the canonical name.

### A. Info & status — read-only, instant

| Command | ID alias | Role | Args | Reply |
|---|---|---|---|---|
| `/status` | — | viewer | — | PC online/offline, open model, Revit + add-in version, queue summary |
| `/levels` | `/lantai`, `/level` | viewer | — | Levels with elevations. Use it to learn exact names before `/count` |
| `/sheets` | `/lembar` | viewer | `[filter]` | Sheets + latest revision. Optional filter matches number/name |
| `/series` | `/seri`, `/grup` | viewer | `[discipline]` | Sheet groups (`ACT SHEET SERIES`) + counts + ready-to-copy `/pdf --series` lines. `--detail` adds each sheet number & name |
| `/warnings` | `/peringatan` | viewer | — | Active warning count + top 10 |
| `/queue` | `/antrean` | viewer | — | Current queue including your position |
| `/help` | `/bantuan` | viewer | — | Commands for your role, in your active language |

### B. Model data — read-only, highest daily value

| Command | ID alias | Role | Example | Reply |
|---|---|---|---|---|
| `/count` | `/hitung` | viewer | `/count L1`<br>`/count L1 lighting --detail` | Eight MEP categories per floor. `--detail` breaks it down by family type |
| `/tray` | — | viewer | `/tray L1` | Cable tray length grouped by `Comments` (LV LADDER etc.) |
| `/panel` | — | viewer | `/panel LP-01` | Panel schedule contents: circuits, load, breaker |
| `/find` | `/cari` | viewer | `/find MARK-123` | Element location: level, coordinates, category |
| `/load` | `/beban` | viewer | `/load L1` | Total connected load per floor |

Categories counted by `/count`:

```
Lighting       → OST_LightingFixtures
Receptacles    → OST_ElectricalFixtures
Cable tray     → OST_CableTray            (+ total length in metres)
Communication  → OST_CommunicationDevices
Fire alarm     → OST_FireAlarmDevices
Telephone      → OST_TelephoneDevices
Data / LAN     → OST_DataDevices
Security       → OST_SecurityDevices
```

### C. File export

| Command | Role | Example | Notes |
|---|---|---|---|
| `/pdf` | viewer (max 10 sheets) | `/pdf LP-01 LP-02` | True 1:1 scale — required settings in §10 |
| `/png` | viewer | `/png` · `/png --3d` · `/png "E-LIGHTING FIXTURES"` | Fast, good for a progress check. No argument = list the 3D views; `--3d` restricts the search to View3D only |
| `/schedule` | viewer | `/schedule PANEL-SCH` | CSV via `ViewSchedule.Export()` |
| `/dwg` | admin | `/dwg E-101` | Uses the export setup saved in the model |
| `/nwc` | admin | `/nwc` | For Navisworks |
| `/ifc` | admin | `/ifc` | Slow: 5–15 minutes. The bot warns up front |

#### How sheet names are matched

`/pdf` and `/dwg` split their arguments on WHITESPACE — one word, one sheet.
Don't append a sentence:

```
/pdf ME-F-LP-1101                            ← right
/pdf ME-F-LP-1101 ME-F-SO-1101               ← right, two sheets
/pdf "GROUND & FIRST FLOOR"                  ← names with spaces: quote them
/pdf ME-F-LP-1101 export this sheet at 1:1   ← every word is read as a sheet
```

Matching order:

1. **Exact** sheet number — always wins.
2. **Exact** sheet name.
3. **Partial** match, minimum 3 characters, and only when it is the **only**
   one. Matching several sheets is answered "ambiguous", never guessed —
   silently picking one of them means confidently sending the wrong drawing.
4. If any word already named a sheet exactly, words that merely *resemble* one
   are **not used at all**: once a word proves to be a real sheet number, the
   rest is a sentence, not a search.

Free search still works as long as it isn't mixed with sheet numbers:
`/pdf lighting` looks for sheet names containing that word.

Every word that did NOT become a sheet is always listed in the reply —
`Dilewati` (skipped), `Diabaikan` (ignored) or `Ambigu` (ambiguous). If you get
more sheets than you asked for, those lines explain why.

### D. Modification — admin only, two-step confirmation required

| Command | Effect |
|---|---|
| `/setparam` | Bulk-set a parameter, e.g. `Comments` for tray colouring |
| `/tag` | Auto-tag the active view |
| `/dynamo` | Run a saved Dynamo graph |

Mandatory pattern: `dryRun` first → the bot replies "will modify 47 elements
[Yes] [Cancel]" → execution only after the button. Details in §11.

### E. Administration

| Command | Role | Effect |
|---|---|---|
| `/pause` | admin | Worker stops claiming jobs. Polling continues so `/status` stays honest |
| `/resume` | admin | Resume claiming |
| `/cancel <id>` | admin | Cancel a still-`pending` command |
| `/users` | admin | Registered users + role + state |

### F. Preferences

| Command | ID alias | Role | Effect |
|---|---|---|---|
| `/lang` | `/bahasa` | viewer | Reply language: `id`, `en`, or `auto` |
| `/theme` | `/tema` | viewer | Web panel theme: `light`, `dark`, or `auto` |
| `/panelapp` | `/panelweb` | viewer | Sends a button that opens the web panel |

### Deliberately not built

| Not built | Why |
|---|---|
| **Sync with Central** | If a conflict or relinquish prompt appears, it cannot be judged from a phone screen — and the damage spreads to the whole team. A read-only `/sync-status` is enough |
| **Deleting anything** | There is no good reason to delete from Telegram. One typo must not mean lost work |
| **Unconfirmed model changes** | See §11 |

---

## 7. User preferences: /lang and /theme

### Language

Three values, stored in `bot_users.lang`:

| Value | Meaning |
|---|---|
| `id` | Always Indonesian |
| `en` | Always English |
| `auto` (default) | Follow `message.from.language_code` on every incoming message |

Resolution order (first match wins):

```
1. bot_users.lang, when it is 'id' or 'en'
2. from.language_code on the Telegram update   ('en-GB' → 'en')
3. DEFAULT_LOCALE = 'id'
```

Usage:

```
/lang              → show the picker buttons
/lang en           → pin to English
/lang auto         → follow the Telegram app language
```

Two details that are easy to miss:

- **The confirmation is written in the NEW language.** "Language switched to
  English" arriving in Indonesian reads as a failure.
- **Language is frozen when the command is created** (`commands.lang`). If a user
  switches language mid-export, the result still matches the "⏳" message being
  edited.

Implementation: `api/_lib/i18n/`. `id.ts` is the reference shape; `en.ts` must
match key for key and placeholder for placeholder — enforced by
`satisfies Catalog` at compile time and `scripts/check-i18n.ts` in CI. A missing
key does not throw at runtime; it silently falls back to Indonesian and English
users see a mixed reply. That is exactly why the checker has to run in CI.

### Theme

Three values, stored in `bot_users.theme`, applied to the web panel:

| Value | Meaning |
|---|---|
| `light` (baseline) | White glass — the default look |
| `dark` | Dark glass |
| `auto` (default) | Follow `Telegram.WebApp.colorScheme`, then `prefers-color-scheme` |

Design details in [THEMING.md](./THEMING.md).

---

## 8. Hard Telegram limits

These are the numbers that bite. Keep them as constants, do not memorise them.

| Item | Limit |
|---|---|
| `sendMessage` text length | 4096 characters |
| `caption` length (document/photo) | 1024 characters |
| Bot file upload | 50 MB |
| Bot file download (`getFile`) | 20 MB |
| Upload via a *local Bot API server* | up to 2000 MB |
| Button `callback_data` | 64 bytes |
| Commands per `setMyCommands` | 100 |
| Command name | 1–32 chars, `a-z0-9_` |
| Command description | 3–256 chars |
| Messages to one chat | ~1 per second |
| Messages to one group | ~20 per minute |
| Total outbound | ~30 messages per second |
| Webhook `max_connections` | 1–100 (default 40) |

Exceeding a rate limit returns **429** with `parameters.retry_after` in seconds.
With five users you will never touch these — unless a loop is wrong. If `/count`
sends 40 messages in a row, that is a bug, not a reason to raise a limit.

---

## 9. Message formatting (MarkdownV2)

MarkdownV2 rejects the **entire message** if a single reserved character is
unescaped. The list is longer than people expect:

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

Full stops and hyphens are in it. Which means `LP-01.` — an ordinary sheet name
— is enough to make `sendMessage` fail with `400 Bad Request`.

```ts
sendMessage(chatId, mdv2(`Sheet ${sheet} is done.`));   // correct
sendMessage(chatId, `Sheet ${sheet} is done.`);         // 400 when sheet = "LP-01"
```

Three options, safest first:

1. **Escape everything** through `mdv2()` (`api/_lib/telegram.ts`). Apply
   formatting after escaping, not before.
2. **Code blocks** for tables and numbers — inside ``` only `` ` `` and `\` need
   escaping, and the monospace keeps columns straight:
   ```
   Lighting     184
   Receptacles   96
   Cable tray    38   412 m
   ```
3. **`parse_mode: 'HTML'`** — only `<`, `>`, `&` need escaping. More forgiving,
   but the supported tag set is small (`b i u s code pre a blockquote`).

For `/count` and `/panel` replies, code blocks are the best choice: the columns
line up on every device.

Long messages: split on **line boundaries**, not at character 4096. `chunk()` in
`telegram.ts` does that — a table cut mid-row is unreadable.

---

## 10. Sending files

### Rules

| Rule | Why |
|---|---|
| **`sendDocument`, never `sendPhoto`** | `sendPhoto` re-encodes to JPG and downscales. For a shop drawing the precision is gone |
| Put project + date in the filename | `PRJ-B_LP-01_2026-08-06.pdf` — in a phone's file list, `LP-01.pdf` means nothing two weeks later |
| Over 50 MB → Supabase Storage + signed URL | The Bot API refuses uploads above 50 MB |
| The in-chat preview looks rough | That is Telegram's renderer. The file itself is intact — open it in a PDF app, not the preview |

### Precise PDF export settings (Revit side)

Three settings decide 1:1 scale:

```csharp
PaperFormat    = ExportPaperFormat.ISO_A1,   // or auto-detect from the titleblock
MarginType     = MarginType.NoMargin,        // NOT Default / PrinterLimit
ZoomType       = ZoomType.Zoom,
ZoomPercentage = 100,                        // NOT FitToPage
```

| Wrong | Consequence |
|---|---|
| `MarginType.Default` | Content shifts ~5 mm, scale is no longer 1:1 |
| `ZoomType.FitToPage` | Scale is destroyed — fatal for shop drawings |
| Mismatched `PaperFormat` | An A1 sheet prints to A4 and shrinks |

Auto-detect the size from the titleblock: `SHEET_WIDTH` / `SHEET_HEIGHT`, feet
× 304.8 = mm, ±3 mm tolerance.

`doc.Export()` **needs no `Transaction`** — it is read-only. Use
`PDFExportOptions` (Revit 2022+), **not** `PrintManager`: the print-driver path
raises dialogs and hangs the process with nobody there to click OK.

### Downloading files from users

If the bot ever accepts a file (e.g. a `.dyn` for `/dynamo`):

```
getFile(file_id) → file_path
GET https://api.telegram.org/file/bot<TOKEN>/<file_path>
```

The download limit is 20 MB, and `file_path` expires after roughly an hour —
fetch it immediately, never store it as a long-lived reference.

---

## 11. Buttons, callbacks, two-step confirmation

### Inline keyboard

```ts
sendMessage(chatId, mdv2(text), {
  reply_markup: {
    inline_keyboard: [[
      { text: 'Yes',    callback_data: `confirm:${jobId}:yes` },
      { text: 'Cancel', callback_data: `confirm:${jobId}:no`  },
    ]],
  },
});
```

`callback_data` is capped at **64 bytes**. Do not put a payload there — put an
ID, keep the data in a table. A full UUID (36 chars) already eats over half the
budget; truncate to the first 8 characters if you need room.

### Answering callbacks

**Always call `answerCallbackQuery`,** even when there is nothing to say.
Without it the button spins in the client until it times out, and the user taps
again.

```ts
await answerCallbackQuery(query.id, 'Running');
await editMessageText(chatId, messageId, mdv2('⚙️ Running…'));
```

### The confirmation pattern

```
/setparam L1 tray Comments "LV LADDER"
   │
   ▼  dryRun — count only, change nothing
⚠️ This will modify 47 elements.
   It cannot be undone from Telegram.
   [Yes] [Cancel]
   │
   ▼  callback confirm:<id>:yes
✅ 47 elements modified.
```

Four guards you cannot skip:

1. **Two-minute expiry.** A stale confirmation is rejected — the model may have
   moved on.
2. **Owner only.** Compare `callback_query.from.id` with the job owner's
   `chat_id`. Otherwise one admin can approve another's change.
3. **Single use.** Mark the job `consumed` before executing, so a double tap is
   not a double run.
4. **Re-send the `dryRun` count on execution** and re-check it in the add-in. If
   the number changed, abort and ask again.

---

## 12. Web panel (Mini App)

The panel in `web/` is a Telegram Mini App: PC status, queue, and a tappable
command list that copies into the composer — plus language and theme toggles.

### Installing the menu button

Via BotFather: `/mybots` → pick the bot → **Bot Settings** → **Menu Button** →
send the panel URL. Or via the API:

```ts
setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Panel', web_app: { url: PANEL_URL } },
});
```

It can also be sent as an in-message button (what `/panelapp` does):

```ts
reply_markup: { inline_keyboard: [[
  { text: '📊 Panel', web_app: { url: PANEL_URL } },
]]}
```

The URL must be HTTPS.

### Authorization — the part most often done wrong

The page receives `window.Telegram.WebApp.initData`: a signed query string.
**`initDataUnsafe` must never be used for authorization** — the name tells you
why. Send the raw `initData` to the server and verify it there:

```
secret = HMAC_SHA256(key="WebAppData", data=<bot_token>)
hash   = HMAC_SHA256(key=secret,       data=<data_check_string>)
```

`data_check_string` = every `k=v` pair **except** `hash`, sorted alphabetically,
joined with `\n`.

Two traps:

- **The Login Widget uses a different scheme** (`secret = SHA256(bot_token)`).
  Mixing them up means verification always fails, with an error message that
  explains nothing.
- **Check `auth_date`.** Without an age limit, leaked `initData` works forever.
  This implementation rejects anything older than one hour.

Implementation: `verifyInitData()` in `api/_lib/telegram.ts`, used by
`api/panel/state.ts`.

### Theming inside a Mini App

Telegram provides:

- `WebApp.colorScheme` — `'light'` or `'dark'`
- `WebApp.themeParams` — also exposed as CSS variables `--tg-theme-bg-color`,
  `--tg-theme-text-color`, `--tg-theme-button-color`, and so on
- a `themeChanged` event when the user switches Telegram's theme
- `setHeaderColor()` / `setBackgroundColor()` to match the chrome around the panel

This panel uses `colorScheme` as the signal for `auto` mode, but does **not**
take `themeParams` as its colours. The reason: a glass theme depends on specific
relationships between layers (stacked alphas, a specular hairline, layered
shadows) that cannot be reconstructed from seven flat colours. Only the header
and background colours are matched — so there is no white band above a dark panel.

---

## 13. Errors, retries, rate limits

### Codes you will actually meet

| Code | Meaning | Action |
|---|---|---|
| `400 Bad Request: can't parse entities` | Unescaped MarkdownV2 | §9. Nearly always this |
| `400 message is not modified` | `editMessageText` with identical text | Ignore, not an error |
| `403 bot was blocked by the user` | The user blocked the bot | Set `is_active = false`, stop sending |
| `429 Too Many Requests` | Rate limited | Wait `parameters.retry_after` seconds, then retry |
| `413` / `Request Entity Too Large` | File over 50 MB | Push to Storage, send a signed URL |
| `409 Conflict` | `getUpdates` used alongside a webhook | `deleteWebhook`, or stop the poller |

### Retry policy

Retry only what is retryable: 429 and network errors. Never retry a 400 — the
result will be identical, just noisier.

```ts
try {
  await sendMessage(chatId, text);
} catch (err) {
  if (err.retryAfter) {
    await sleep(err.retryAfter * 1000);
    await sendMessage(chatId, text);
  } else {
    log(err);          // do not throw out of the webhook handler:
  }                    // non-2xx means Telegram redelivers the same update
}
```

### When the Revit PC is off

Nothing is lost. `pending` becomes `expired` after 10 minutes. The bot answers
from `machine_state.last_seen_at`:

```
🔴 PC offline since 18:42 yesterday (14 hours).
Your command stays queued — it runs automatically once Revit is open.
```

"Runs automatically" is the sentence that does the work. People do not mind
waiting; they mind not knowing until when.

### Kill switch

The `machine_state.bot_enabled` flag in Supabase. The webhook rejects everything
the moment it is off — faster than remoting into the laptop, and doable from the
Supabase dashboard on a phone.

---

## 14. Roles and permissions

Enforced on the **server**, not in the add-in and not in the menu.

```js
const LIMITS = {
  viewer: { maxSheets: 10,  blocked: ['ifc','nwc','dwg','setparam','tag','dynamo'] },
  admin:  { maxSheets: 999, blocked: [] },
};
```

Check order in the webhook, all before anything is queued:

```
1. webhook secret header matches?     → no: 403, stop
2. bot_enabled?                        → no: reply kill-switch notice
3. chat_id registered & is_active?     → no: reply "not registered"
4. command known?                      → no: reply /help
5. role sufficient?                    → no: reply "admin only"
6. args valid & within limits?         → no: reply a correct example
7. cooldown elapsed?                   → no: reply remaining seconds
8. → insert into commands, reply "⏳"
```

Cooldown is 2 minutes per user after a heavy command (`pdf`, `ifc`, `nwc`, `dwg`).

Adding a user: open the panel **from inside Telegram** as an admin and fill in
the "Users" card with their chat ID and name. How they find their own chat ID —
send the bot anything; the "not registered" reply includes it.

Writing SQL against `bot_users` is only needed for the FIRST admin: until one
admin exists, nobody is allowed to open that card.

Revoking access does not delete the row, it sets `is_active = false`: the record
of who ran which command stays intact, and their language/theme preferences come
back if they are granted access again.

---

## 15. Deploy checklist

```
[ ] Bot created, token stored in Vercel env (not in the repo)
[ ] TELEGRAM_WEBHOOK_SECRET generated randomly and set
[ ] Supabase migration applied (001_init.sql)
[ ] A bot_users row per user, with role
[ ] setWebhook called with secret_token + allowed_updates
[ ] getWebhookInfo checked: no last_error_message
[ ] npx tsx scripts/check-i18n.ts  → green
[ ] npx tsx scripts/set-commands.ts → id + en + admin menus installed
[ ] Mini App menu button points at PANEL_URL
[ ] Add-in: .addin + DLL in %APPDATA%\Autodesk\Revit\Addins\2025\
[ ] Machine token stored via DPAPI in %APPDATA%
[ ] powercfg /change standby-timeout-ac 0   (sleep kills polling)
[ ] /status from a phone → correct reply. That proves the whole chain
```

Recommended build order:

```
1. /status                    → proves the entire chain works
2. /count + /levels           → real daily value, read-only
3. /pdf                       → real output
   ── use it yourself for a week ──
4. invite one colleague
5. /tray, /panel, /png
6. the rest, driven by real requests
```

Do not invite five people before it is stable. With bugs still in, you become a
support desk while fixing them.

---

## 16. Troubleshooting

| Symptom | Most likely | How to check |
|---|---|---|
| Bot completely silent | Webhook failing / wrong URL | `getWebhookInfo` → `last_error_message` |
| Commands run twice | Handler returned non-2xx, Telegram redelivered | Always `return 200`, even on error; dedupe on `update_id` |
| `400 can't parse entities` | Unescaped MarkdownV2 | Wrap all dynamic text in `mdv2()` |
| `/` menu still in the old language | `setMyCommands` not re-run, or client cache | Re-run the script, then restart Telegram |
| `/` menu empty on one person's phone | Their app language is neither `id` nor `en` | The default (EN) list should appear — check the script sets a list with no `language_code` |
| Replies mix two languages | A key is missing in `en.ts`, falling back to `id` | `npx tsx scripts/check-i18n.ts` |
| Panel always 401 | Stale `initData`, or the hash schemes were swapped | Check `auth_date`; make sure you use `HMAC("WebAppData", token)`, not `SHA256(token)` |
| Panel stuck light on a dark phone | `data-theme="light"` set while the preference is `auto` | Auto must **remove** the attribute, not write one |
| Glass looks flat grey | The background behind it is flat | `backdrop-filter` needs something to mix — see the gradient in `body::before` |
| PDF scale is off | Wrong `MarginType` / `ZoomType` | §10 |
| `/count` returns 0 when there are dozens | Family categories are not what you assumed | See §17 |
| Bot dies after a few hours | `HttpClient` created per request → socket exhaustion | Use a single `static` instance |
| Random Revit crashes | Revit API called from the polling thread | All access must go through `ExternalEvent` |

---

## 17. What to verify yourself

Some things cannot be assumed and must be checked directly:

**In Revit:**

- **Family categories.** Many fire alarm families are actually loaded as
  `Electrical Fixtures`, not `Fire Alarm Devices`. Pick one smoke detector and
  read its category in Properties. Get this wrong and `/count` reports 0 while
  dozens exist — and nothing looks broken.
- **Level parameters.** `LevelId` is often empty for MEP elements. Cable tray
  uses `RBS_START_LEVEL_PARAM`, family instances use `FAMILY_LEVEL_PARAM`.
  Provide all three as fallbacks.
- **Elements inside links are not counted** by `FilteredElementCollector(doc)`.
- **`PDFExportOptions` enum names** were written from memory of the 2025 API. If
  something does not compile, check `RevitAPI.chm`.

**In Telegram:** the limits and parameter names here follow the Bot API as of
writing. The Bot API gains methods and fields regularly — before depending on a
specific field, check it against
[core.telegram.org/bots/api](https://core.telegram.org/bots/api). Most likely to
have moved: the `themeParams` field list, the newest Mini App methods, and upload
size limits. **[verify]**

**The single most useful validation:** run `/count` once and compare it against a
schedule that already exists in Revit. If the numbers match exactly, the level
logic is right and everything after it can be trusted.
