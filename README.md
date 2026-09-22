# Powerful Pixiv Tools

A Tampermonkey script for Pixiv that adds some stuff Pixiv doesn't have.

### What it does

- Select multiple artworks at once
- Batch like / bookmark with bookmark tag support
- Download original-resolution images
- Download multi-page artworks and Ugoira
- Hover over artworks for a larger preview
- Sort loaded artworks by bookmark count
- Infinite scroll with a page limit
- Import / export selected artwork IDs
- Move and resize the control panel
- Keeps your settings between sessions

### Install

Don't have Tampermonkey yet? Install it first from [tampermonkey.net](https://www.tampermonkey.net/).

Then just click:

**[Install Powerful Pixiv Tools](https://raw.githubusercontent.com/Sheenamiii/powerful-pixiv-tools
/main/pixiv.user.js)**

Tampermonkey should open the install page automatically.

### Usage

Open Pixiv and the **Pixiv Power Tools** panel should show up.

Most things are pretty self-explanatory:

- Click the circle on an artwork to select it
- Turn on **Click to Select** to select cards by clicking them
- Use **Like**, **Like + Bookmark**, or **Download Selected**
- Hover an artwork to see the preview

For **Sort by Likes**, set how many extra pages you want to load in Settings and hit **Sort by Likes**. It sorts the artworks you've loaded based on their public bookmark count.

Infinite scroll uses the same page limit.

### A few things to know

The sorting isn't some hidden Pixiv Premium API. It just loads the pages and sorts them locally, so more pages = more requests.

Downloads try to use the original Pixiv CDN file. Multi-page works are downloaded separately, while Ugoira is downloaded as its original `.zip`.

Don't set ridiculous request limits. The script already has delays, batch pauses, and a daily quota, but you should still use some common sense.

### Disclaimer

Not affiliated with Pixiv Inc. Use at your own risk.