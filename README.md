# paseo-agent-manager

A Paseo plugin that shows what a host is holding in memory and lets you take it back: every session
that keeps a process alive, grouped by project and workspace, with release / archive / restore / delete
for sessions, workspaces and whole projects. Idle runtimes are released automatically.

## What it looks like

```
4 workspaces · 3 active
host.lan · 27 records · 5 unarchived (4 no runtime) · 22 archived
1 holding · 118 MB · load 0.42 · cpu 7% · mem 611M/961M · swap 155M/3.0G
[● Settings ▶]  idle 10m · last sweep 20m ago · 2 released · next in 9m   [Refresh] [Release idle (1)]
┌──────────────────────────────┬──────────────────────────────────────────────┐
│▶ ▎project-a         2        │ WORKSPACE · paseo                            │
│▼ ▏workspace-name    5        │ /srv/project-a                               │
│     main · 2 holding · 210 MB│ main · 2 holding · 210 MB · 5 unarchived      │
│     session title            │ [Open in app] [Release idle (2)]             │
│     running · 132 MB · pid 7 │ [Release running (1)] [Reopen archived (1)]  │
│     ↳ sub-agent               │ [Close open tabs (5)] [Close terminals (2)]  │
│     no runtime · 20h ago     │ [Archive workspace] [Rename workspace…]      │
│▼ ▏old-workspace (archived) 0 │                                              │
│▶ ▎No workspace         1     │                                              │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

Rows are flat — nothing is indented, so long titles keep the full width. The expand arrow *is* the level
marker: one slim bar hugging the left edge and spanning the row's full height, filled by level (accent
for a project, a translucent grey for a workspace, nothing at all for a session) with the arrow glyph
inside it. Row density follows the screen: tight on a phone, roomier on desktop, so both stay
comfortable to read and to tap. Selecting a row
outlines it in the accent colour. Each row carries one secondary line of live numbers, aligned with its
title and starting with the session state (`running` / `idle` / `no runtime` / `error`).

- One tree on the left (project → workspace → session), the actions for the selection on the right.
  Phones get list → detail with a `Back` button.
- Every row carries live numbers on one line: which sessions keep a process alive, that memory,
  running count, terminals with their directory and state, provider, labels, last activity.
- `Settings` is collapsed by default and holds the view filter and the auto-release switches.
- Paseo hands a plugin exactly eleven colours (`surface0` / `surface1` / `surface2`, `border`,
  `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning`,
  `statusDanger`) and nothing else. The panel re-tones the ones it paints with so they stay legible on
  both light and dark themes, which is why the colours in the panel are not the raw theme values.

## Terms

| Shown | Means |
| --- | --- |
| `records` | every session record on this host, archived included |
| `unarchived` | the record is not archived, so Paseo may keep it in the tab strip |
| `no runtime` | nothing is running for that session right now (released, or the daemon restarted). The record, its history and its tab stay, and the next message starts a process again |
| `archived` | archived: Paseo keeps the record and history but takes it out of the tab strip |
| `holding` | sessions that currently keep an OS process alive, and the memory they use |

Only `running` and `idle` sessions hold memory. A `closed`/`no runtime` session holds none, and
`archived` sessions hold none either. Unarchived + archived = records; `no runtime` is a subset of
unarchived.

Paseo keeps which tab you have open, hidden or scrolled out of view in the app itself, so no plugin can
reproduce the tab strip exactly. `Unarchived (N)` is the closest honest equivalent: it is exactly the set
Paseo is allowed to show as tabs. The switch lives in Settings and applies to the whole tree — archived
workspaces disappear from it too, not just archived sessions.

## Actions

**Session** — `Open tab` focuses it in the app. `Release process` stops its runtime and frees the memory
while the tab and history stay. `Archive session` takes it out of the tab strip, `Restore session` puts
it back, `Delete session…` removes the record and its history for good (asks first).

**Workspace** — `Open in app`. `Release idle (N)` stops the runtimes that are not working; `Release
running (N)` also interrupts the ones that are (asks first). `Reopen archived tabs (N)` brings back the
tabs the workspace had when it was archived: they load once so the app can show their content, then the
idle timer closes them again. `Close open tabs (N)` closes every tab and frees the same memory.
`Close terminals (N)` names the terminals first if something might be running. `Archive workspace` hides
the workspace with everything it owns (an empty one is removed on the spot instead), `Rename
workspace…` sets the name Paseo shows — archived or not. An archived workspace offers `Restore
workspace`, `Rename workspace…` and `Delete workspace`.

**Project** — `Release idle (N)` and `Release running (N)` for everything under one project, or for
sessions whose workspace record is gone (they appear under `No workspace`). `Release idle (N)` in the
header does the same for the whole host.

**Terminals** — listed per workspace and one row each, with the daemon's own state (`working`,
`waiting at a prompt`, or `not reporting activity`) and a `Close` button per terminal.

**New agent** — in the composer pill panel. Desktop and web: it fires Paseo's own new-agent action, the one
behind the tab bar `+` menu and `Ctrl+Shift+A` / `Cmd+Shift+A`, so the usual draft tab opens. Native
hosts have no keyboard layer, so it opens the same draft through Paseo's own `paseo:` deep link
(`?open=draft:…`) — the tab appears instantly and the session is created when the first message is sent.
If the host cannot open that link either, it creates the session through the daemon and jumps to it.

**Open the panel** — `Open Agent Manager` in ⌘K, or the Agent Manager item in the sidebar. The composer
pill stays on session work and does not jump there.

A pill renders `label ?? title`, and the host rejects a `label` that is empty or whitespace
(`Plugin button needs label`), so neither an icon-only pill nor an empty label is possible without a
zero-width space — which passes validation but leaves an invisible text node behind and therefore nudges
the icon off centre. The pill's label therefore always carries live numbers, so it never disappears and
never looks like a stray icon.

One pill sits above the composer and follows the session it belongs to. Its label carries the open tab
count (`3 tabs`), the one number the menu is about, so it stays steady instead of chasing memory that
moves every poll; the memory is in the panel, read when it opens. Opening the pill shows one panel:

- the host line (`load`, `cpu`, `mem`, `swap`),
- every open tab of this workspace, newest first, each with its state — `running`, `unread` (the turn
  finished and has not been looked at), `needs input` (waiting on a permission), `failed`, `idle` (a
  runtime is held but nothing is working) or `no runtime` — plus the memory it holds and a `×` that
  archives that tab without switching to it first, the current tab included. The current tab is
  highlighted and inert; picking another focuses it through the same navigation the app uses, so it
  switches workspace and tab,
- `New Agent` and `Release idle (N)` (stops this workspace's idle runtimes without dropping their tabs or
  history),
- the current tab's timestamps (`Created … · Updated … · Last message …`).

Switching tabs goes through a tiny redirect surface, because a composer pill has no navigation of its
own. That surface subscribes to focus requests instead of reading one at mount, so a request that arrives
while it is already mounted — a second pick before the first navigation lands — still switches.

The pill follows the daemon's agent stream: one agent observation is opened when the plugin loads, so a
session that appears, is restored or is removed gains or loses its pill without a refetch, while the
state numbers refresh from a throttled overview read at most once every five seconds. The panel reads a
fresh snapshot each time it opens, so it never lists a tab that is gone.

## Auto-release

A session is released once it has been idle for the chosen timer (default 10 minutes; a freshly loaded
session always gets its full window) unless it is waiting on a permission. This runs off the daemon's
agent stream with a periodic safety sweep, so it keeps working while the app is closed.

A released runtime is only a pause: opening the tab wakes the session again, which is exactly what a
client does when it restores its layout on launch. `Archive released after` (default 60 minutes, `Off`
disables) closes the session record instead, through the daemon's own `close_items` — the same path as
closing a tab. The tab disappears, a restored layout can no longer resume the runtime, and the session
stays in History where Restore brings it back. Only sessions that actually held a runtime when they
were released are queued, so the historical backlog of already-closed records is never mass-archived.

`Reap stale running after` (default 5 minutes, `Off` disables) closes sessions the daemon still reports
as `running` although no process exists for them any more; the sweep used to skip those forever. It only
acts once the process scan has seen at least one live agent process, so a broken scan cannot close every
running session.

`Close idle terminals` (off by default) extends the sweep to terminals and only uses positive evidence:
either the daemon reports the terminal as idle for the whole timer, or — for terminals that never report
activity — the process in it is still a plain shell with no children and nothing running, watched for
that whole window. A terminal running a program (an editor, a REPL, an agent CLI) is never closed on its
own.

Settings live in the plugin's Settings section and in `~/.paseo/agent-manager/auto-release.json`.

## Install

```bash
paseo plugin install https://github.com/iseedot/agent-manager
paseo plugin update agent-manager --yes     # later
```

`"pluginsEnabled": true` in the daemon `config.json`, then `paseo reload`. The panel is **Agent
Manager** in the app sidebar; install once per daemon. Opening it costs one `agent-manager.snapshot`
call (sessions, workspaces, projects, terminals, host stats and auto-release settings), that answer is
kept for 30 seconds, and every action refreshes the same single call — one round trip per read, which
matters on a phone over a relay.

Needs Paseo 0.10.0+ and a Linux daemon host (`/proc` feeds the pid and memory numbers; the `paseo` CLI
serves Delete, the daemon MCP route serves Release). Nothing extra is installed: it uses the daemon's
own client and the session protocol on `ws://<daemon.listen>/ws`.

## Notes

- Actions are addressed by workspace or session id, never by path, and never touch other workspaces.
  Archiving the last active workspace at a path asks first while it still has session records, because
  Paseo resolves directory workspaces by path.
- CPU percentage comes from the delta between the last two `/proc/stat` reads, so a read never sleeps.
  The first read after start samples a 200 ms window, and reads closer than 400 ms apart reuse the
  previous value instead of reporting tick-quantised noise.
- Terminal activity comes from the daemon and is `null` for a plain shell or a program that does not
  integrate, so the panel says `not reporting activity` rather than guessing.
- `Release` and `Restore` use the daemon's own kill and refresh requests, so the record stays valid and
  the next message resumes it. `Delete` goes through the `paseo` CLI and leaves the provider's own
  session files on disk, so an imported session can come back.
- Workspaces whose project was removed are still listed, as `project removed`. `Delete` on a workspace
  also drops its registry record, remembered in `~/.paseo/agent-manager/deleted-workspaces.json`.

## Checking which build a client runs

A client only picks up plugin code when it fetches the catalog — at connect, or when the daemon
announces `plugin_catalog_changed` after an install, a reload or an update. A phone that was asleep or
offline during the change keeps running the bundle it already has until it reconnects.

The footer of the panel shows a `ui <code>` stamp derived from the client code that is actually
executing, so a stale client is easy to spot: compare it with the code the current source produces. The
composer pill and `Open Agent Manager` in ⌘K are part of the same build.

## Development

```bash
npm ci
npm run typecheck
```

The plugin runs from source: point the daemon at this directory and reload it (`paseo plugin install
<path>`, then `paseo reload`). `index.client.tsx` and `index.server.ts` are the two halves Paseo
compiles; `shared/contracts.ts` is the RPC surface between them.

MIT
