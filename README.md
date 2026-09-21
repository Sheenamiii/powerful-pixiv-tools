# Pixiv Power Tools

A userscript for Pixiv that enhances browsing efficiency with bulk artwork selection, high-resolution hover previews, infinite scroll, and automated batch liking/bookmarking.

---

## Features

- **Fast Artwork Selection**
  - Interactive selection checkboxes on artwork thumbnails.
  - One-click click-to-select mode.
  - "Select Visible" and "Clear Visible" shortcuts.
  - Export and import artwork IDs via clipboard.

- **Bulk Like & Bookmark**
  - Batch like or batch like + bookmark selected artworks.
  - Dynamic user bookmark tag fetching and tag chips for auto-tagging.
  - Custom tag input and private bookmark support.
  - Configurable rate limiting, request delays, batch sizes, cooldown pauses, and daily safety quotas to avoid API abuse.

- **Selection History & Snapshots**
  - Save current selections as snapshots.
  - Restore, merge, rename, or delete saved snapshots across sessions.
  - Auto-backup when clearing large selections.

- **Full-Resolution Hover Preview**
  - Zero-letterbox, aspect-ratio adaptive hover preview overlay.
  - Multi-page manga/illustration support (scroll wheel to navigate pages).
  - Displays metadata: bookmark count, dimensions, page count, creation date, author, and tags.

- **Multi-Column Infinite Scroll**
  - Seamless infinite scrolling across search results, tag galleries, and user bookmark pages.
  - Automatically updates page numbering in URL without reloading.

- **Persistent Settings & Draggable UI**
  - Draggable, collapsible floating control panel with position memory.
  - Customizable delays, limits, and preview toggles stored in userscript storage.

---

## Installation

### 1. Install Userscript Manager
Install one of the following browser extensions for your browser:
- [Tampermonkey](https://www.tampermonkey.net/) (Recommended)
- [Violentmonkey](https://violentmonkey.github.io/)

### 2. Add Script
1. Open your userscript manager dashboard.
2. Click **Create a new script** (`+`).
3. Copy the entire contents of [`pixiv.js`](./pixiv.js) and paste it into the editor.
4. Save the script (`Ctrl + S` or `Cmd + S`).

Alternatively, create a GitHub release or view `pixiv.js` in **Raw** format on GitHub, and your userscript manager will prompt to install it automatically.

---

## Usage

1. Open [Pixiv](https://www.pixiv.net) and log into your account.
2. The **Pixiv Power Tools** panel will appear at the top-right corner.
3. Browse search results, tag pages, or user profiles:
   - Hover over artwork cards to inspect high-resolution previews.
   - Click the circle checkbox on any thumbnail (or turn on **Click-to-Select**) to add items to your selection.
   - Select bookmark tags from your loaded tags or enter custom tags.
   - Click **Like** or **Like + Bookmark** to run the batch operation safely.

---

## Configuration

Access the settings tab (`⚙`) in the floating panel to adjust:
- **Hover Preview**: Toggle hover overlay and delay duration.
- **Infinite Scroll**: Enable or disable continuous loading.
- **Min / Max Delay**: Milliseconds between consecutive API requests.
- **Batch Size & Pause**: Periodic cooldown break duration after N operations.
- **Daily Quota**: Maximum operations allowed per day before safety lockout.
- **Max History**: Number of saved selection snapshots to retain.

---

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Pixiv Inc. Use responsible delay settings to prevent rate-limiting or account restrictions.
