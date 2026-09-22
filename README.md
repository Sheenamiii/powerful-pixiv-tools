# Pixiv Power Tools

A Tampermonkey userscript that adds bulk selection, batch liking and bookmarking, full-resolution downloads, a free popularity sort, and bounded infinite scroll to Pixiv.

---

## Features

### Fast artwork selection
- Circular checkbox on every thumbnail. Click to toggle, no page navigation.
- **Click to Select** mode: click anywhere on a card to select it.
- **Select Visible** / **Clear Visible** for the current screen, **Export** / **Import** to move ID lists between sessions.

### Bulk like and bookmark
- Batch **Like** or **Like + Bookmark** over your whole selection.
- Fetches your own bookmark tags and shows them as clickable chips, so batch saves land in the right tag automatically. Custom tags and private bookmarks supported.
- Configurable delays, batch size, cooldown pauses, and a daily quota to stay well clear of rate limits.
- Stoppable mid-run. Progress and a live counter are always on screen.

### Free popularity sort
- Ranks a gallery from most-liked to least, using each artwork's public bookmark count. No Premium account needed.
- Loads the pages first, then ranks everything together, so the ordering is global rather than per-screen.
- Optionally badges every card with its like count so the ranking is verifiable at a glance.
- **Restore Original Order** puts the grid back exactly as Pixiv served it.

### Full-resolution downloads
- A download button on every thumbnail, plus **Download Selected** for a whole batch.
- Multi-page works download every page as `Title_12345_p0.jpg`, `p1`, and so on.
- Fetches from the origin CDN with the required referer, so you get the true original file, not the scaled preview. Falls back to the largest available variant when an original is unavailable.

### Hover preview
- Zero-letterbox preview that adapts to each artwork's aspect ratio.
- Scroll the wheel to page through multi-page works.
- Shows bookmark count, dimensions, page count, date, artist, and tags.

### Infinite scroll with a page budget
- Loads more results as you approach the bottom, on tag, search, and bookmark pages.
- Bounded by a page count you set, so it never runs away on a large tag.
- Turning it off returns you to the last page you loaded, with Pixiv's native pagination restored.

### Resizable, persistent panel
- Drag the header to move it, drag any edge or corner to resize it, like a desktop window.
- Position and size are remembered. Collapses to a title bar when you want it out of the way.

---

## Installation

### 1. Install a userscript manager
- [Tampermonkey](https://www.tampermonkey.net/) (recommended)
- [Violentmonkey](https://violentmonkey.github.io/)

### 2. Add the script
**From GitHub (recommended):** open [`pixiv.js`](./pixiv.js) and click **Raw**. Your userscript manager will offer to install it, and will keep it updated from this repo.

**Manually:** open your manager's dashboard, choose **Create a new script**, paste the entire contents of [`pixiv.js`](./pixiv.js), and save.

### 3. Approve permissions
The script requests `@connect` access to `www.pixiv.net` and the image CDN (`i.pximg.net`), plus `GM_download` as a fallback. Your manager will prompt once. **If you dismiss that prompt, downloads will fail silently** with a 403 from the CDN.

---

## Usage

1. Open [Pixiv](https://www.pixiv.net) and log in.
2. The **Pixiv Power Tools** panel appears at the top right. Drag it anywhere.
3. Hover any thumbnail for a full-resolution preview.
4. Click the circle on a thumbnail to select it, or turn on **Click to Select** and click cards directly.
5. Pick bookmark tags (or type your own), then run **Like** or **Like + Bookmark**.

### Sorting a gallery by popularity
1. Set **Extra pages to load** in Settings to however deep you want to rank.
2. Press **Sort by Likes**. The script loads that many more pages, then ranks everything together.
3. Press **Restore Original Order** to put the gallery back.

### Downloading
- Single artwork: hover the thumbnail, click the download button.
- Several artworks: select them, then press **Download Selected**.

---

## How the page budget works

**Extra pages to load** (default `10`, range `1`-`1000`) is a single budget shared by infinite scroll and Sort by Likes. It counts pages loaded *in addition to* the one you start on.

| Action | Result |
| --- | --- |
| Start on page 1, limit 10, scroll | Pages 2-11 load (10 extra pages) |
| Turn infinite scroll off | Jumps to page 11, the last page loaded |
| Start on page 5, limit 10, scroll | Pages 6-15 load |
| Turn infinite scroll off | Jumps to page 15 |
| Use Pixiv's own pager, then enable infinite scroll | Continues from the page you are on |
| Gallery shorter than the budget | Stops at the real end, and says so |

The counter in the panel reads `loaded/limit`, for example `7/10`. When the budget runs out, the marker reads **Reached the limit of 10 extra pages** and loading stops until you raise the setting or navigate somewhere new.

The counter also runs during a **Sort by Likes** pass, even when infinite scroll is off, so you can see how far the ranking has got. It returns to `OFF` once the pass finishes.

Turning infinite scroll off reloads Pixiv's own pagination at the last page you reached, so you keep your place and can continue with the site's native controls.

---

## Configuration

Open the **Settings** tab in the panel.

**Browsing**
| Setting | Default | What it does |
| --- | --- | --- |
| Hover preview | on | Enable the full-resolution hover overlay |
| Hover delay (ms) | 200 | How long to hover before the preview appears |
| Infinite scroll default | off | Start with infinite scroll already enabled |
| Extra pages to load | 10 | Shared page budget for scrolling and sorting |

**Ranking**
| Setting | Default | What it does |
| --- | --- | --- |
| Show like counts | on | Badge each card with its bookmark count after sorting |
| Re-rank new pages | on | Keep newly loaded pages merged into the sort order |
| Download concurrency | 2 | Parallel downloads, 1-4. Higher is faster but heavier |

**Rate limits**
| Setting | Default | What it does |
| --- | --- | --- |
| Min delay (ms) | 300 | Shortest pause between API requests |
| Max delay (ms) | 700 | Longest pause between API requests |
| Batch size | 30 | Operations before a longer cooldown |
| Batch pause (s) | 8 | Length of that cooldown |
| Daily quota | 5000 | Hard cap on likes/saves per day |
| Max history | 30 | Snapshots kept in the History tab |

---

## Notes and limitations

- **Sorting costs requests.** Ranking is one lookup per artwork, so a 10-page budget on a 48-per-page gallery is roughly 480 requests, spread across 5 at a time. Raise the budget deliberately, and use **Stop** if you change your mind.
- **Sorting is client-side.** Pixiv reserves server-side popularity ordering for Premium accounts, so this ranks the pages it has loaded rather than the whole tag.
- **The budget resets on navigation.** Moving to a different tag or search gives you a fresh budget, counted from wherever you land.
- **Page counts are per-listing.** Pixiv returns 48 items per page on most listings and 60 on some, so a 10-page budget means 10 API pages, not a fixed number of artworks.
- **Save and Reset do not navigate.** Only the infinite scroll toggle jumps you to the last page.
- **Ugoira (animated) works** download as the original `.zip`, as Pixiv serves them.

---

## Changelog

### 9.2.1
- The page counter no longer counts a page whose cards were all duplicates, so the last-page marker always points at a page that actually has content.
- The panel chip shows real progress (`loaded/limit`) while a sort is loading pages, even when infinite scroll is off. It returns to `OFF` when the pass ends.
- Turning infinite scroll off while a sort is running now stops the ranking pass cleanly instead of letting it race the page change.
- Enabling infinite scroll after using Pixiv's own pager continues from the page you are actually on, rather than fetching from page 2.
- Fixed a cursor drift that could stop loading one page early when the artwork grid was briefly unavailable.

### 9.2
- **Bounded infinite scroll.** New **Extra pages to load** setting caps how many additional pages load, replacing the previous unbounded behavior.
- **Turning infinite scroll off returns you to the last page you loaded**, with Pixiv's native pagination restored, instead of leaving you at the top.
- **Sort by Likes now shares that same page budget**, loading exactly as many pages as you configured and ranking them together.
- Removed the previous **Sort loads every page** and **Max pages to load** options, which were superseded by the shared budget.
- The panel status chip now reads `loaded/limit`, and reports `LIMIT`, `END`, or `OFF` as appropriate.

### 9.1
- **Resizable panel.** Drag any edge or corner to resize, with size remembered alongside position.
- **Sort survives page changes.** The sort stays on across Pixiv's client-side navigation and re-ranks the new listing automatically.
- Fixed the sort resetting itself while loading, which could append duplicate cards.

### 9.0
- **Free popularity sort**, with like-count badges and a restore-original-order action.
- **Full-resolution downloads**, per-thumbnail and for a whole selection, including multi-page works.
- **Redesigned panel** with a consistent dark theme, an icon set, keyboard focus states, and WCAG AA contrast throughout.
- Added ARIA attributes and a reduced-motion path.

### 8.9
- Bulk like and bookmark with dynamic bookmark tag detection.
- Selection snapshots with restore, merge, rename, and delete.
- Multi-column infinite scroll.
- Full-resolution hover preview.

---

## Disclaimer

Not affiliated with, endorsed by, or associated with Pixiv Inc. Sorting, downloading, and batch operations all make real requests to Pixiv on your behalf. Use sensible delays, and keep the daily quota conservative.
