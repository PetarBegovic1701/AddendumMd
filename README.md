# Addendum.md

A lightweight, zero-dependency **markdown reader + editor** that runs in the
browser. Built for reading and reviewing the pile of `.md` docs in this project,
optimised for **mobile** use over your local network.

> This is an internal utility, not part of the W-M-C-E product. It lives under
> `tools/` and is intentionally outside the phase-gated codebase.

## What it does

- Browses **only `.md` files** under a configurable root directory (recursively).
- Renders markdown in a clean, mobile-first reader (frontmatter, tables, task
  lists, code blocks, nested lists, blockquotes, images, links).
- **Edits** files in place: tap ✎ to edit the raw markdown, ✎→👁 to preview,
  **Save** to write back to disk. Edit mode is a standalone reader↔editor toggle,
  independent of the addendum feature.
- **Addendum widget** (the floating ✚): a fast way to answer questions embedded in
  a doc without leaving reading flow - see below. Hidden while editing.
- **Bookmarks** (☆), a **"reviewed" checklist** (○) with a progress bar, and an
  **In-progress** flag (orange) set automatically whenever you save/append to a doc.
- **Downloads** (⤓): grab the current document, or the whole project as a `.zip`
  or one concatenated `.md`. Streamed straight to the device - no temp files.
- **Dark / light theme** toggle (◐), remembered per device.
- Review status, bookmarks, and in-progress flags are stored **server-side** in
  `state.json`, so they **sync across every device** that connects (phone + desktop).
  They are filed against each document's full path, so a document keeps its flags
  whichever folder you open as the root - the repo itself, its parent, or a
  subfolder - and two projects that both contain `docs/README.md` never mix.

## Requirements

- [Node.js](https://nodejs.org) (any recent version; tested on v22).
- No `npm install` - there are zero dependencies.

## Run it - pick whichever feels easiest

You don't need to be comfortable with a terminal. On start, a browser tab opens
automatically and the window prints the address to use on your phone.

**1. Double-click (simplest).** In this folder, double-click:

- **`Addendum.md_start.cmd`** - opens a small window with status text and launches the app.
  Keep the window open while you use it; close it to stop. If Node.js isn't
  installed, it tells you where to get it.
- **`Start Addendum.md_start_no_window.vbs`** - same thing but with **no console
  window** at all. To stop it later, double-click **`Addendum.md_stop.cmd`**, which
  kills only this server (by the PID it records in `server.pid`) - not any other
  Node programs you may be running.

**2. From a terminal.** In this folder:

```sh
npm start          # uses the saved / default folder
# or, to point at a specific folder and port:
node server.js "C:/Projects/Project_folder" 8888
```

- `rootDir` (optional) - the folder whose `.md` files are served. If omitted, the
  last folder you chose in the app is used; otherwise the current directory.
- `port` (optional) - default `8888`

**Tip:** to launch it the same way every day, right-click `Addendum.md_start.cmd` →
*Send to* → *Desktop (create shortcut)*, and rename the shortcut to "Addendum.md".

Once running, the window shows an **"On your phone"** address like
`http://192.168.x.x:8888`. Open that on your phone (same Wi-Fi). No internet
connection is required; everything is served locally with no external requests.

## Choosing the folder to read

The **root folder** is the directory whose `.md` files are shown. It appears on
the first screen when the app loads, and you can change it any time:

- **⚙ Settings → Change folder…**, or the **Change folder** button on the first
  screen, opens a folder picker. Browse drives/folders (it shows how many markdown
  files are in each), then tap **Use this folder**.
- Your choice is saved to `config.json` and reused next time. A `rootDir` given on
  the command line overrides the saved choice for that run.

### Reading from another device over HTTP

Instead of a path, the picker also accepts the **URL of a static file server** -
VS Code's *Go Live* / Live Server, `python -m http.server`, nginx autoindex, and
anything else that serves directory listings:

```
http://192.168.x.x:5500
```

Type it into the picker's path box (or pass it as `rootDir` on the command line)
and Addendum.md crawls the listings and shows the tree exactly as it would a local
folder. Reading, filtering, bookmarks, review status and both download formats
all work.

Things worth knowing:

- **It is read-only.** Static file servers have no write verb, so editing, saving
  and the addendum widget are hidden for a remote root. Bookmarks and review
  status still work - those live in your local `state.json`.
- **The folder must not contain an `index.html`**, or the server sends that page
  instead of a listing and Addendum.md has nothing to read.
- **Dot-folders are invisible.** Directory listings omit names beginning with a
  dot, so `.kiro`, `.agent` and friends do not appear. Addendum.md probes a few common
  ones at the top level; for anything else, type the full URL to it
  (`http://host:5500/.kiro/specs/`) - direct access still works.
- **Traffic is plain HTTP** on your network: document names and contents are
  readable by anything positioned to watch the wire. Keep it to networks you trust.
- **Only private addresses are accepted** (`10.x`, `172.16-31.x`, `192.168.x`,
  `127.x`, `100.64-127.x`, and IPv6 unique/link-local). Addendum.md listens on
  `0.0.0.0` without authentication, so this stops a passer-by on your LAN from
  using it to reach hosts they cannot. Set `Addendum.md_ALLOW_PUBLIC=1` to lift it.

## Features guide

A built-in guide describes every feature. Open it with the **?** button in the top
bar, or from the first screen. (It lives at `public/FEATURES.md`.)

## Using it on mobile

- **☰** opens the file list (slide-in drawer). Tap a file to open it; the drawer
  closes automatically.
- Filter tabs: **All / ★ Marked / Unreviewed**. The search box filters by name.
- **☆ / ★** bookmark the current doc. **○ / ●** mark it reviewed (updates the
  progress bar). **✎** edit, **👁** preview your unsaved edits, **Save** to persist.
- **◐** toggles dark/light.

## Downloading documents

- **⤓** in the top bar downloads the document you're reading. With unsaved edits
  in the buffer, you get that version rather than what's on disk.
- **⚙ Settings → Download** offers the same, plus the whole project as either a
  **`.zip`** (folder structure preserved) or a **single `.md`** (everything
  concatenated, with a table of contents).

Both project downloads are generated on the fly and written straight to the
response socket: no temp file is created on either machine, and no archive is
ever held in memory in full. The `.zip` is built with Node's builtin `zlib`, so
the zero-dependency promise still holds.

## Addendum widget (the floating ✚)

For docs that ask you questions, the addendum widget lets you jot answers and
append them to the file without switching into full edit mode.

- **Drag it**: long-press (~0.4s) until it enlarges, then drag. It snaps to the
  nearest side and stays on-screen. Position is remembered.
- **Tap it (closed)**: opens a split view - the document (read-only) on top, an
  editable box on the bottom, with a draggable divider between them.
- **Tap it (open)**: appends your addendum text to the **end of the document**,
  saves, and clears the box so you can answer the next question.
- **Double-tap it (open)**: appends + saves + closes, back to the reader.
- **Drag the divider all the way down** (expand the reading area): closes the
  addendum and **discards** the text.
- **Drag the divider all the way up** (expand the addendum area): **commits** -
  appends the text to the end of the document, saves, and closes.
- **Tap ✎ (edit) while open**: leaves the addendum (text discarded) and enters
  the standalone edit mode. Edit mode and the addendum are separate features.
- **Open another file while addendum is open**: it closes and the text is
  discarded (nothing is saved).

Any append or save marks the document **In progress** (orange). Marking a
document **reviewed** (○) clears its in-progress flag. The **In progress** tab in
the sidebar lists every doc currently flagged.

## Files

| File | Purpose |
|---|---|
| `server.js` | Zero-dependency Node HTTP server + JSON API. |
| `public/index.html` | App shell. |
| `public/style.css` | Mobile-first, theme-aware styles. |
| `public/app.js` | UI logic + the self-contained markdown renderer. |
| `public/FEATURES.md` | The in-app features guide (opened via **?**). |
| `Addendum.md_start.cmd` | Double-click launcher (shows a window). |
| `Addendum.md_start_no_window.vbs` | Double-click launcher (no console window). |
| `Addendum.md_stop.cmd` | Stops the server started by the no-window launcher. |
| `package.json` | Enables `npm start`. |
| `server.pid` | Auto-created while running; the PID for the stop script. Git-ignored. |
| `state.json` | Auto-created. Bookmarks + reviewed + in-progress flags, keyed by full document path. Git-ignored. |
| `config.json` | Auto-created. Your chosen root folder; reopened on the next start. Git-ignored. |

## Safety notes

- The file API exposes **only paths ending in `.md`** inside the active root.
  Path traversal (`../`) and any non-markdown file are rejected.
- The folder picker lists **folder names only** (never file contents) so you can
  browse to a new root. If you'd rather lock the root, pass it on the command line
  and ignore the in-app picker.
- Downloads reuse the same path check, so only `.md` files inside the active root
  can be fetched. Note that `/api/download-all` hands over **every** document
  under the root in a single unauthenticated request - convenient for you, and
  equally convenient for anyone else who can reach the port.
- Saving uses a modification-time check: if a file changed on disk since you
  opened it, the server returns a conflict and asks before overwriting.
- The server binds to all interfaces so your phone can reach it. Only run it on
  networks you trust; there is no authentication (single-user, local use).
