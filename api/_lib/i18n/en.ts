import type { Catalog, Params } from './types';

/**
 * English catalog. Must mirror `id.ts` key-for-key and placeholder-for-placeholder.
 * `scripts/check-i18n.ts` fails the build if a key or a `{placeholder}` drifts.
 */
export const en = {
  meta: { nativeName: 'English', bcp47: 'en', flag: '🇬🇧' },

  common: {
    queued: '⏳ Queued…',
    running: '⚙️ Running in Revit…',
    done: '✅ Done',
    cancelled: '🚫 Cancelled',
    expired: '⌛ Expired — Revit was not open within 10 minutes.',
    yes: 'Yes',
    no: 'Cancel',
    seconds: (p: Params) => `${p.n}s`,
    minutes: (p: Params) => `${p.n} min`,
    elapsed: (p: Params) => `Took ${p.duration}`,
    position: (p: Params) => `Queue position ${p.pos} of ${p.total}`,
    empty: '(empty)',
    // A result that arrived AFTER the server concluded the job was dead. Said
    // plainly: the "cut off" message the user already read turned out to be wrong.
    lateResult: '✅ Done (result arrived late — this job had been marked cut off)',
  },

  errors: {
    notRegistered:
      'You are not registered. Ask an admin to add your chat ID: {chatId}',
    inactive: 'Your account is disabled. Contact an admin.',
    adminOnly: 'This command is admin-only.',
    botDisabled: '🔴 The bot is temporarily disabled by an admin.',
    unknownCommand: (p: Params) =>
      `Unknown command: ${p.cmd}. Send /help for the full list.`,
    badArgs: (p: Params) => `Bad format.\nCorrect example: ${p.example}`,
    missingArgs: (p: Params) => `Missing arguments.\nExample: ${p.example}`,
    tooManySheets: (p: Params) =>
      `Maximum ${p.max} sheets per request (you asked for ${p.asked}).`,
    cooldown: (p: Params) =>
      `Wait ${p.seconds}s more — a heavy command just ran.`,
    pcOffline: (p: Params) =>
      `🔴 PC offline since ${p.since} (${p.ago}).\nYour command stays queued — it runs automatically once Revit is open.`,
    noDocument: 'Revit is running but no model is open yet.',
    docMismatch: (p: Params) => `Model mismatch. Currently open: ${p.actual}`,
    levelNotFound: (p: Params) =>
      `Level "${p.level}" not found. Send /levels for exact names.`,
    viewNotFound: (p: Params) => `Sheet/view "${p.view}" not found.`,
    revitError: (p: Params) => `Revit rejected it: ${p.message}`,
    notImplemented: (p: Params) =>
      `${p.cmd} is not available yet — the Revit add-in has no implementation for it, ` +
      'so queueing it would achieve nothing. /help marks which commands already work.',
    stuck:
      '⚠️ Cut off mid-run — Revit was closed or the add-in stopped before the result was sent. Run the command again.',
    // Different from `stuck`, and the difference matters: here Revit is still
    // alive. Sending someone to check a PC that is fine only wastes their time.
    tooLong:
      '⏱️ Stopped for taking too long — Revit is still open, but this job did not finish within the time limit. Try a smaller group (/sheets --groups) instead of a whole discipline at once.',
    workerPaused:
      '⏸️ The worker is paused by an admin. Your command stays queued, but it only runs after /resume.',
    fileTooBig: (p: Params) =>
      `File is ${p.size} MB, over Telegram's 50 MB upload limit. Download link: ${p.url}`,
    fileFailed: (p: Params) =>
      `The job finished, but the file could not be delivered: ${p.reason}\n\nRun the command again. If it keeps happening, open /api/health — the "storage" section shows whether the file bucket exists.`,
    internal: 'Internal error. It has been logged — try again shortly.',
  },

  help: {
    title: '⚡ Revit Bridge — command list',
    footer:
      'The bot is live while Revit is open (working hours). Not a 24/7 service.\nSwitch language: /lang · Switch panel theme: /theme',
    sectionInfo: 'Info & status',
    sectionQuery: 'Model data',
    sectionExport: 'File export',
    sectionModify: 'Modification (admin)',
    sectionAdmin: 'Administration',
    roleNote: (p: Params) => `Your role: ${p.role}`,
    hiddenNote: (p: Params) => `${p.n} more commands are admin-only and hidden.`,
    // Marker appended to commands the add-in cannot run yet. Without it /help
    // promises 9 commands that are certain to be refused the moment you try.
    soon: '— not available yet',
    soonNote: (p: Params) =>
      `${p.n} commands marked "not available yet" are still waiting on the Revit add-in. Typing them gets a refusal, not a queue slot.`,
  },

  status: {
    title: '📊 Status',
    online: (p: Params) => `🟢 PC online (last seen ${p.ago} ago)`,
    offline: (p: Params) => `🔴 PC offline since ${p.since}`,
    model: (p: Params) => `Model: ${p.title}`,
    noModel: 'Model: — (no document open yet)',
    revit: (p: Params) => `Revit: ${p.version} · add-in ${p.addin}`,
    queue: (p: Params) => `Queue: ${p.pending} pending, ${p.running} running`,
    paused: '⏸️ Worker is paused — jobs are not being claimed.',
  },

  count: {
    header: (p: Params) => `📍 ${p.level}`,
    row: (p: Params) => `${p.label}: ${p.n}`,
    trayLength: (p: Params) => `Cable tray: ${p.n} runs · ${p.meters} m`,
    total: (p: Params) => `Total elements: ${p.n}`,
    none: (p: Params) => `No MEP elements found on ${p.level}.`,
    detailHint: 'Add --detail to break it down by family type.',
    catLighting: 'Lighting',
    catReceptacle: 'Receptacles',
    catCableTray: 'Cable tray',
    catCommunication: 'Communication',
    catFireAlarm: 'Fire alarm',
    catTelephone: 'Telephone',
    catData: 'Data / LAN',
    catSecurity: 'Security',
  },

  exportFile: {
    starting: (p: Params) => `Exporting ${p.n} sheet(s)…`,
    sending: 'Uploading file…',
    caption: (p: Params) => `${p.project} · ${p.sheet} · ${p.date}`,
    skipped: (p: Params) => `${p.n} sheet(s) skipped (not found).`,
    slowWarning: 'This format is slow — expect 5–15 minutes.',
  },

  confirm: {
    prompt: (p: Params) =>
      `⚠️ This will modify ${p.n} elements.\nIt cannot be undone from Telegram.`,
    expired: 'Confirmation expired (2 minutes). Run the command again.',
    notYours: 'This confirmation belongs to another user.',
    applied: (p: Params) => `✅ ${p.n} elements modified.`,
  },

  admin: {
    paused: '⏸️ Worker paused. Jobs still queue but are not claimed.',
    resumed: '▶️ Worker resumed.',
    cancelled: (p: Params) => `Command ${p.id} cancelled.`,
    notCancellable: 'Command already running or finished — cannot cancel.',
    usersTitle: '👥 Registered users',
    userRow: (p: Params) => `${p.name} · ${p.role} · ${p.status}`,
    killSwitchOn: '🔴 Bot disabled for all users.',
    killSwitchOff: '🟢 Bot re-enabled.',
  },

  lang: {
    prompt: 'Choose the language the bot replies in:',
    themePrompt: 'Choose the web panel theme:',
    auto: 'Automatic (follow Telegram language)',
    changed: (p: Params) => `Language switched to ${p.lang}.`,
    unchanged: (p: Params) => `Language is already ${p.lang}.`,
    current: (p: Params) => `Current language: ${p.lang}`,
  },

  project: {
    prompt: 'Pick the project every following command should target:',
    selected: (p) => `✅ Your active project: ${p.name}\nEvery following command targets this one.`,
    followActive: '✅ Following whichever project is active in Revit.',
    followActiveButton: 'Follow the active one in Revit',
    noneOpen:
      'Revit reports no open project. If Revit really is open, the add-in is probably an older ' +
      'build — the file list is only sent by versions that support /project.',
    notFound: (p) => `Project "${p.term}" is not in the open list.`,
    ambiguous: (p) => `"${p.term}" matches ${p.n} projects at once — be more specific.`,
    stale: 'The project list changed. Send /project again.',
    needsMigration:
      'Project selection is not active yet: 004_project_selection.sql has not been run in Supabase. ' +
      'For now every command targets whichever project is active in Revit.',
  },

  commandDesc: {
    status: 'PC status, open model, queue',
    levels: 'List levels in the model',
    sheets: 'List sheets + latest revision',
    series: 'Sheet groups + ready-to-copy export commands',
    views: '3D views + ready-to-copy /png commands',
    warnings: 'Active model warnings',
    queue: 'Current command queue',
    project: 'Pick which open project commands target',
    help: 'Commands available to your role',
    count: 'Count MEP elements per floor',
    tray: 'Cable tray length per floor',
    panel: 'Panel schedule contents',
    find: 'Locate an element by Mark',
    load: 'Total connected load per floor',
    pdf: 'Export sheets to 1:1 PDF',
    png: 'Export a view to PNG',
    dwg: 'Export to DWG (admin)',
    nwc: 'Export to NWC for Navisworks (admin)',
    ifc: 'Export to IFC (admin, slow)',
    schedule: 'Export a schedule to CSV',
    setparam: 'Bulk-set a parameter (admin)',
    tag: 'Auto-tag the active view (admin)',
    dynamo: 'Run a saved Dynamo graph (admin)',
    pause: 'Stop claiming jobs (admin)',
    resume: 'Resume claiming jobs (admin)',
    cancel: 'Cancel a queued command (admin)',
    users: 'List registered users (admin)',
    lang: 'Switch bot language (ID / EN)',
    theme: 'Switch web panel theme (light / dark)',
    panelapp: 'Open the Revit Bridge web panel',
  },
} satisfies Catalog;
