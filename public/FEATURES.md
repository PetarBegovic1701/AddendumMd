# Addendum.md - md reader and editor - Features guide

A lightweight markdown reader and editor you run on your own machine and open in
a browser (phone or desktop). Everything below works offline, over your local
network.

---

## The basics

- **Open a document**: tap the **☰** menu (on phone) or use the list on the left,
  then tap any `.md` file.
- **Search / filter files**: type in the box at the top of the file list to filter
  by name. The tabs narrow the list further:
  - **All** - everything.
  - **★ Marked** - only bookmarked docs.
  - **In progress** - docs you've edited but not yet finished (orange).
  - **Unreviewed** - docs you haven't ticked as reviewed.
- **Progress bar**: shows how many docs you've marked reviewed.

## Top bar buttons

| Button | What it does |
|---|---|
| ☰ | Show / hide the file list (phone) |
| ☆ / ★ | Bookmark the current document |
| ○ / ● | Mark the current document **reviewed** |
| ✎ / 👁 | Switch between reading and editing (and back to preview) |
| ⤓ | Download the current document |
| ? | Open this features guide |
| ◐ | Toggle light / dark theme |
| ⚙ | Open **Settings** (root folder, help, theme) |

## Reading

Documents render with headings, tables, task lists, code blocks, quotes, images
and links. Tapping a link to another `.md` file opens it right here.

## Editing

- Tap **✎** to edit the raw markdown. Tap **👁** to preview your unsaved changes.
- **Save** writes the file back to disk; **Revert** throws your edits away.
- When you enter edit mode, the editor scrolls to roughly the same place you were
  reading - and returning to reading brings you back to where you were.
- Editing is a standalone feature, separate from the Addendum below.

## Addendum widget (the floating **+**)

For documents that ask **you** questions, the addendum widget lets you jot answers
and append them to the file without leaving your reading flow.

- **Drag it**: press and hold (~0.4s) until it grows, then drag. It snaps to the
  nearest side and its position is remembered.
- **Tap it (closed - the + icon)**: splits the screen - the document on top, a text
  box on the bottom, with a divider you can drag.
- **Tap it (open, save icon)**: appends your text to the **end of the document**,
  saves, and clears the box so you can answer the next question.
- **Tap it again straight away**: right after a save the widget turns into an
  **✕** and a small pie drains across it for about 1.5 seconds. Tapping while the
  pie is running closes the addendum - back to reading. Let the pie run out and
  the widget goes back to being a plain save button.
- **Drag the divider down** (grow the reading area): closes the addendum and
  **discards** the text.
- **Drag the divider up** (grow the addendum): appends the text, saves, and closes.
- **Open another file while it's open**: it closes and the text is discarded.

## Downloading documents

- **One document**: tap **⤓** in the top bar (or *⚙ Settings → Download → This
  document*). If you have unsaved edits, you get **exactly what's on screen** -
  the unsaved version - not the copy on disk.
- **The whole project**: *⚙ Settings → Download*, then pick either
  - **.zip** - every document as a separate file, folder structure intact; or
  - **single .md** - everything concatenated into one file, with a table of
    contents at the top.

Downloads go straight from the server into your device's Downloads folder. No
temporary file is created anywhere, and nothing is copied through the clipboard.
Nothing leaves your network - the file travels from your computer to your phone
and no further.

## Statuses

- **Bookmark (★)** - quick access via the *★ Marked* tab.
- **Reviewed (●)** - your "I've read/checked this" tick; feeds the progress bar.
- **In progress (orange)** - set automatically whenever you save or append to a
  document. Marking a document reviewed clears it. See the *In progress* tab.

All three are stored on the server, so they **sync across every device** that
connects to it.

## Root folder

The **root folder** is the directory whose `.md` files Addendum.md shows.

- It's displayed on the **first screen** when the app loads.
- Change it any time from **⚙ Settings → Change folder…**, or from the **Change
  folder** button on the first screen.
- The folder picker lets you browse drives and folders and shows how many markdown
  files are in each. Pick one and tap **Use this folder**.
- Your choice is remembered between restarts. Only `.md` files are ever served -
  no other file types are exposed.

## Reading another device's folder

The picker's path box also takes the **URL of a static file server** - for example
VS Code's *Go Live*:

```
http://192.168.x.x:5500
```

Addendum.md reads the directory listing and builds the tree just like a local folder.
Reading, filtering, bookmarks, review status and downloads all work.

- Remote folders are **read-only** - a static file server cannot be written to, so
  ✎ Edit and the addendum widget are hidden. Bookmarks and review status still work.
- If the folder holds an `index.html`, the server sends that page instead of a
  listing and there is nothing for Addendum.md to read.
- Folders starting with a dot (`.kiro`, `.agent`) are hidden by the remote server.
  A few common ones are found automatically; otherwise type the full URL to one.
- The connection is plain HTTP over your network - fine at home, not on a network
  you do not trust.

## Theme

Light or dark, toggled with **◐** (or in Settings). Remembered per device.

## Using it on your phone

Start the server on your computer and open the **"On your phone"** address it
prints (both devices on the same network). No internet connection is required.
