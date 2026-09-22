// ==UserScript==
// @name         Powerful Pixiv Tools
// @namespace    http://tampermonkey.net/
// @version      9.2.1
// @description  Resizable panel, bounded infinite scroll, free popularity sort across loaded pages, full-resolution downloader, bulk like & bookmarking with dynamic tag detection for Pixiv
// @author       Sheenamiii
// @match        https://www.pixiv.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        unsafeWindow
// @connect      www.pixiv.net
// @connect      i.pximg.net
// @connect      i-cf.pximg.net
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEYS = {
        config: 'ppt_config_v8',
        daily: 'ppt_daily_v8',
        activeSel: 'ppt_active_selection_v8',
        history: 'ppt_selection_history_v8',
        bmtags: 'ppt_cached_bmtags_v8',
        account: 'ppt_cached_account_v8',
        tagSelection: 'ppt_saved_tag_selection_v8',
        pos: 'ppt_panel_pos_v8',
        size: 'ppt_panel_size_v8',
    };

    const DEFAULT_CONFIG = {
        delayMin: 300,
        delayMax: 700,
        batchSize: 30,
        batchPause: 8000,
        dailyLimit: 5000,
        maxHistory: 30,
        hoverPreview: true,
        hoverDelay: 200,
        infiniteScroll: false,
        showLikeBadges: true,
        liveSort: true,
        dlConcurrency: 2,
        scrollPageLimit: 10,
    };

    let config = Object.assign({}, DEFAULT_CONFIG, GM_getValue(STORAGE_KEYS.config, {}));

    function saveConfig(newCfg) {
        config = Object.assign({}, newCfg);
        GM_setValue(STORAGE_KEYS.config, config);
    }

    function getTodayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    function getDailyCount() {
        const data = GM_getValue(STORAGE_KEYS.daily, {});
        return data[getTodayKey()] || 0;
    }

    function addDailyCount(n = 1) {
        const data = GM_getValue(STORAGE_KEYS.daily, {});
        const key = getTodayKey();
        data[key] = (data[key] || 0) + n;
        Object.keys(data).forEach(k => {
            if (k !== key) delete data[k];
        });
        GM_setValue(STORAGE_KEYS.daily, data);
    }

    function getTimeUntilMidnight() {
        const now = new Date();
        const mid = new Date(now);
        mid.setHours(24, 0, 0, 0);
        const diff = mid - now;
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return `${h}h ${m}m`;
    }

    function formatRelativeTime(ts) {
        if (!ts) return 'just now';
        const sec = Math.floor((Date.now() - ts) / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days}d ago`;
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function randDelay(min, max) {
        const d = Math.floor(Math.random() * (max - min + 1)) + min;
        return sleep(d);
    }

    function escHtml(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    let cachedToken = null;

    try {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const origFetch = w.fetch;
        if (typeof origFetch === 'function') {
            w.fetch = function (...args) {
                const opts = args[1];
                if (opts?.headers && !cachedToken) {
                    try {
                        const h = opts.headers;
                        const t = typeof h.get === 'function'
                            ? h.get('x-csrf-token')
                            : (h['x-csrf-token'] || h['X-CSRF-Token']);
                        if (t && /^[a-f0-9]{32}$/i.test(t)) cachedToken = t;
                    } catch {}
                }
                return origFetch.apply(this, args);
            };
        }
        const origSetHeader = w.XMLHttpRequest?.prototype?.setRequestHeader;
        if (typeof origSetHeader === 'function') {
            w.XMLHttpRequest.prototype.setRequestHeader = function (name, val) {
                if (!cachedToken && name.toLowerCase() === 'x-csrf-token' && /^[a-f0-9]{32}$/i.test(val)) {
                    cachedToken = val;
                }
                return origSetHeader.apply(this, arguments);
            };
        }
    } catch (e) {
        console.warn('[PPT] Token interceptor failed:', e);
    }

    function getTokenSync() {
        if (cachedToken) return cachedToken;
        const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        try {
            if (uw.pixiv?.context?.token) return (cachedToken = uw.pixiv.context.token);
            if (uw.globalInitData?.token) return (cachedToken = uw.globalInitData.token);
            if (uw.pixiv?.user?.token) return (cachedToken = uw.pixiv.user.token);
            if (uw.g_csrfToken) return (cachedToken = uw.g_csrfToken);
            if (uw.__NEXT_DATA__?.props?.pageProps?.token) return (cachedToken = uw.__NEXT_DATA__.props.pageProps.token);
        } catch {}

        for (const id of ['meta-global-data', 'meta-preload-data']) {
            const el = document.getElementById(id);
            if (el) {
                try {
                    const d = JSON.parse(el.getAttribute('content'));
                    if (d?.token) return (cachedToken = d.token);
                } catch {}
            }
        }

        const m = document.querySelector('meta[name="csrf-token"]');
        if (m && m.getAttribute('content')) return (cachedToken = m.getAttribute('content'));

        for (const s of document.querySelectorAll('script')) {
            const match = s.textContent.match(/"token"\s*:\s*"([a-f0-9]{32})"/i);
            if (match) return (cachedToken = match[1]);
        }
        return null;
    }

    function getTokenAsync() {
        const sync = getTokenSync();
        if (sync) return Promise.resolve(sync);

        return new Promise(resolve => {
            if (typeof GM_xmlhttpRequest === 'undefined') return resolve(null);
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://www.pixiv.net/',
                headers: { 'Referer': 'https://www.pixiv.net/', 'Accept': 'text/html' },
                timeout: 8000,
                onload(res) {
                    try {
                        const html = res.responseText || '';
                        const match = html.match(/"token"\s*:\s*"([a-f0-9]{32})"/i);
                        if (match) {
                            cachedToken = match[1];
                            return resolve(cachedToken);
                        }
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const mg = doc.getElementById('meta-global-data');
                        if (mg) {
                            const d = JSON.parse(mg.getAttribute('content'));
                            if (d?.token) {
                                cachedToken = d.token;
                                return resolve(cachedToken);
                            }
                        }
                    } catch {}
                    resolve(null);
                },
                onerror() { resolve(null); },
                ontimeout() { resolve(null); }
            });
        });
    }

    let cachedAccount = GM_getValue(STORAGE_KEYS.account, null);

    async function fetchMyUserDataAsync() {
        if (cachedAccount?.id) return cachedAccount;

        const urlMatch = location.pathname.match(/\/users\/(\d+)/);
        if (urlMatch && location.pathname.includes('/bookmarks')) {
            cachedAccount = { id: urlMatch[1], name: '' };
            GM_setValue(STORAGE_KEYS.account, cachedAccount);
            return cachedAccount;
        }

        try {
            const mg = document.getElementById('meta-global-data');
            if (mg) {
                const d = JSON.parse(mg.getAttribute('content'));
                if (d?.userData?.id) {
                    cachedAccount = { id: String(d.userData.id), name: d.userData.name || '' };
                    GM_setValue(STORAGE_KEYS.account, cachedAccount);
                    return cachedAccount;
                }
            }
            const mp = document.getElementById('meta-preload-data');
            if (mp) {
                const d = JSON.parse(mp.getAttribute('content'));
                if (d?.userData?.id || d?.user?.id) {
                    cachedAccount = {
                        id: String(d.userData?.id || d.user?.id),
                        name: d.userData?.name || d.user?.name || ''
                    };
                    GM_setValue(STORAGE_KEYS.account, cachedAccount);
                    return cachedAccount;
                }
            }
        } catch {}

        try {
            const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const id = uw.pixiv?.user?.id
                || uw.globalInitData?.userData?.id
                || uw.__globalData?.userData?.id
                || uw.__NEXT_DATA__?.props?.pageProps?.userData?.id;
            const name = uw.pixiv?.user?.name || uw.globalInitData?.userData?.name || '';
            if (id) {
                cachedAccount = { id: String(id), name: name };
                GM_setValue(STORAGE_KEYS.account, cachedAccount);
                return cachedAccount;
            }
        } catch {}

        try {
            const meData = await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://www.pixiv.net/ajax/me?lang=en',
                    headers: { 'Referer': location.href, 'Accept': 'application/json' },
                    timeout: 6000,
                    onload(res) {
                        try {
                            const j = JSON.parse(res.responseText);
                            if (!j.error && j.body) {
                                const uid = j.body.userId || j.body.id || j.body.pixivId;
                                if (uid) {
                                    return resolve({ id: String(uid), name: j.body.name || j.body.userName || '' });
                                }
                            }
                        } catch {}
                        resolve(null);
                    },
                    onerror() { resolve(null); },
                    ontimeout() { resolve(null); }
                });
            });
            if (meData) {
                cachedAccount = meData;
                GM_setValue(STORAGE_KEYS.account, cachedAccount);
                return cachedAccount;
            }
        } catch {}

        try {
            const hpData = await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://www.pixiv.net/',
                    headers: { 'Referer': 'https://www.pixiv.net/', 'Accept': 'text/html' },
                    timeout: 7000,
                    onload(res) {
                        try {
                            const html = res.responseText || '';
                            const doc = new DOMParser().parseFromString(html, 'text/html');
                            const mg = doc.getElementById('meta-global-data');
                            if (mg) {
                                const data = JSON.parse(mg.getAttribute('content'));
                                if (data?.userData?.id) {
                                    return resolve({ id: String(data.userData.id), name: data.userData.name || '' });
                                }
                            }
                            const m = html.match(/"userId"\s*:\s*"?(\d+)"?/);
                            if (m) return resolve({ id: m[1], name: '' });
                        } catch {}
                        resolve(null);
                    },
                    onerror() { resolve(null); }
                });
            });
            if (hpData) {
                cachedAccount = hpData;
                GM_setValue(STORAGE_KEYS.account, cachedAccount);
                return cachedAccount;
            }
        } catch {}

        return null;
    }

    function scrapeBookmarkTagsFromDOM() {
        const foundTags = [];
        const seen = new Set();

        const addTag = (name, count) => {
            if (!name) return;
            const clean = name.trim().replace(/^#/, '').trim();
            if (!clean || clean === 'Any' || clean === 'Uncategorized' || seen.has(clean)) return;
            seen.add(clean);
            foundTags.push({ tag: clean, cnt: count || 0 });
        };

        document.querySelectorAll('a[href*="tag="]').forEach(a => {
            try {
                const u = new URL(a.href, location.origin);
                const tagParam = u.searchParams.get('tag');
                if (tagParam) {
                    const cntMatch = a.textContent.match(/[\d,]+/);
                    const cnt = cntMatch ? parseInt(cntMatch[0].replace(/,/g, ''), 10) : 0;
                    addTag(tagParam, cnt);
                }
            } catch {}
        });

        document.querySelectorAll('aside a, nav a, ul a').forEach(a => {
            if (!a.href.includes('/bookmarks')) return;
            const txt = a.textContent.trim();
            if (txt.startsWith('#')) {
                const match = txt.match(/^#([^\s\d]+)(?:\s*([\d,]+))?/);
                if (match) {
                    const tag = match[1];
                    const cnt = match[2] ? parseInt(match[2].replace(/,/g, ''), 10) : 0;
                    addTag(tag, cnt);
                }
            }
        });

        return foundTags;
    }

    async function fetchMyBookmarkTags(userId) {
        const domTags = scrapeBookmarkTagsFromDOM();
        const endpoints = [
            `https://www.pixiv.net/ajax/user/${userId}/illusts/bookmark/tags?lang=en`,
            `https://www.pixiv.net/ajax/user/${userId}/illustmanga/bookmark/tags?lang=ja`,
            `https://www.pixiv.net/ajax/user/${userId}/illustmanga/bookmark/tags?lang=en`,
            `https://www.pixiv.net/ajax/user/${userId}/illusts/bookmark/tags?lang=ja`
        ];

        for (const url of endpoints) {
            try {
                const list = await new Promise(resolve => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        headers: { 'Referer': location.href, 'Accept': 'application/json' },
                        timeout: 7000,
                        onload(res) {
                            try {
                                const j = JSON.parse(res.responseText);
                                if (j.error || !j.body) return resolve(null);
                                const tags = [];
                                const addTags = arr => {
                                    if (!Array.isArray(arr)) return;
                                    arr.forEach(t => {
                                        const raw = (t.tag || '').trim().replace(/^#/, '');
                                        if (raw && !tags.some(x => x.tag === raw)) {
                                            tags.push({ tag: raw, cnt: t.cnt || 0 });
                                        }
                                    });
                                };
                                if (Array.isArray(j.body)) {
                                    addTags(j.body);
                                } else if (typeof j.body === 'object') {
                                    addTags(j.body.public);
                                    addTags(j.body.private);
                                    Object.values(j.body).forEach(v => {
                                        if (Array.isArray(v)) addTags(v);
                                    });
                                }
                                resolve(tags.length > 0 ? tags : null);
                            } catch {
                                resolve(null);
                            }
                        },
                        onerror() { resolve(null); },
                        ontimeout() { resolve(null); }
                    });
                });

                if (list && list.length > 0) {
                    domTags.forEach(dt => {
                        if (!list.some(x => x.tag === dt.tag)) list.push(dt);
                    });
                    list.sort((a, b) => b.cnt - a.cnt);
                    GM_setValue(STORAGE_KEYS.bmtags, list);
                    return list;
                }
            } catch {}
        }

        if (domTags.length > 0) {
            domTags.sort((a, b) => b.cnt - a.cnt);
            GM_setValue(STORAGE_KEYS.bmtags, domTags);
            return domTags;
        }

        return GM_getValue(STORAGE_KEYS.bmtags, []);
    }

    function requestLike(illustId, token) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://www.pixiv.net/ajax/illusts/like',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'Referer': location.href,
                },
                data: JSON.stringify({ illust_id: String(illustId) }),
                onload(res) {
                    try {
                        const j = JSON.parse(res.responseText);
                        resolve({ ok: !j.error, status: res.status });
                    } catch {
                        resolve({ ok: res.status >= 200 && res.status < 300, status: res.status });
                    }
                },
                onerror() { resolve({ ok: false, status: 0 }); }
            });
        });
    }

    function requestBookmark(illustId, token, { tags = [], isPrivate = false } = {}) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://www.pixiv.net/ajax/illusts/bookmarks/add',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'Referer': location.href,
                },
                data: JSON.stringify({
                    illust_id: String(illustId),
                    restrict: isPrivate ? 1 : 0,
                    comment: '',
                    tags: tags,
                }),
                onload(res) {
                    try {
                        const j = JSON.parse(res.responseText);
                        resolve({ ok: !j.error, status: res.status });
                    } catch {
                        resolve({ ok: res.status >= 200 && res.status < 300, status: res.status });
                    }
                },
                onerror() { resolve({ ok: false, status: 0 }); }
            });
        });
    }

    function loadSavedActiveSelection() {
        try {
            const raw = GM_getValue(STORAGE_KEYS.activeSel, null)
                || GM_getValue('ppt_sel_v8', null)
                || GM_getValue('ppt_sel_v5', null);
            if (!raw) return { ids: new Set(), updatedAt: Date.now() };
            const arr = Array.isArray(raw.ids) ? raw.ids : (Array.isArray(raw) ? raw : []);
            return {
                ids: new Set(arr.map(String)),
                updatedAt: raw.updatedAt || raw.ts || Date.now()
            };
        } catch {
            return { ids: new Set(), updatedAt: Date.now() };
        }
    }

    const activeSelectionState = loadSavedActiveSelection();
    const selected = activeSelectionState.ids;
    let lastSelectionUpdateTime = activeSelectionState.updatedAt;

    let saveSelectionTimer = null;
    function persistActiveSelectionNow() {
        lastSelectionUpdateTime = Date.now();
        GM_setValue(STORAGE_KEYS.activeSel, {
            ids: [...selected],
            updatedAt: lastSelectionUpdateTime
        });
    }

    function schedulePersistActiveSelection() {
        if (saveSelectionTimer) clearTimeout(saveSelectionTimer);
        saveSelectionTimer = setTimeout(() => {
            saveSelectionTimer = null;
            persistActiveSelectionNow();
        }, 150);
    }

    function getHistoryList() {
        try {
            const list = GM_getValue(STORAGE_KEYS.history, []);
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function saveHistoryList(list) {
        try {
            const trimmed = list.slice(0, config.maxHistory || 30);
            GM_setValue(STORAGE_KEYS.history, trimmed);
        } catch (e) {
            console.warn('[PPT] Failed to save history:', e);
        }
    }

    function createSnapshot(name, customIds) {
        const idsToSave = customIds || [...selected];
        if (idsToSave.length === 0) return null;

        const list = getHistoryList();
        const tagFromUrl = (function () {
            const m = location.pathname.match(/\/(?:en\/)?tags\/([^/]+)/);
            if (m) return decodeURIComponent(m[1]);
            const q = new URLSearchParams(location.search).get('q');
            if (q) return q;
            return null;
        })();

        const defaultTitle = name || (tagFromUrl ? `Tag: ${tagFromUrl}` : `Selection ${new Date().toLocaleDateString()}`);

        const snapshot = {
            id: 'snap_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            name: defaultTitle,
            artworkIds: idsToSave,
            count: idsToSave.length,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        list.unshift(snapshot);
        saveHistoryList(list);
        return snapshot;
    }

    function restoreSnapshot(snapId, mode = 'replace') {
        const list = getHistoryList();
        const snap = list.find(s => s.id === snapId);
        if (!snap || !Array.isArray(snap.artworkIds)) return false;

        if (mode === 'replace') {
            selected.clear();
        }
        snap.artworkIds.forEach(id => selected.add(String(id)));
        persistActiveSelectionNow();
        syncAllDomVisuals();
        updateUI();
        return true;
    }

    function deleteSnapshot(snapId) {
        const list = getHistoryList();
        const next = list.filter(s => s.id !== snapId);
        saveHistoryList(next);
    }

    function renameSnapshot(snapId, newName) {
        const list = getHistoryList();
        const snap = list.find(s => s.id === snapId);
        if (snap) {
            snap.name = newName.trim();
            snap.updatedAt = Date.now();
            saveHistoryList(list);
        }
    }

    let selectMode = false;

    function toggleSelection(id) {
        id = String(id);
        if (selected.has(id)) {
            selected.delete(id);
        } else {
            selected.add(id);
        }
        schedulePersistActiveSelection();
        syncDomVisuals(id);
        updateUI();
    }

    function getVisibleArtworkIds() {
        const ids = [];
        document.querySelectorAll('a[href*="/artworks/"]').forEach(a => {
            if (!a.querySelector('img')) return;
            const m = a.href.match(/\/artworks\/(\d+)/);
            if (m && !ids.includes(m[1])) ids.push(m[1]);
        });
        return ids;
    }

    function selectAllVisible() {
        const visibleIds = getVisibleArtworkIds();
        if (visibleIds.length === 0) {
            setStatus('No visible artworks found.', '#f59e0b');
            return;
        }
        visibleIds.forEach(id => selected.add(id));
        schedulePersistActiveSelection();
        syncAllDomVisuals();
        updateUI();
        setStatus(`Added ${visibleIds.length} visible artworks.`, '#10b981');
    }

    function clearVisible() {
        const visibleIds = getVisibleArtworkIds();
        visibleIds.forEach(id => selected.delete(id));
        schedulePersistActiveSelection();
        syncAllDomVisuals();
        updateUI();
    }

    function clearAllSelection() {
        if (selected.size === 0) return;
        if (selected.size >= 3) {
            createSnapshot(`Auto-backup (${selected.size} items)`, [...selected]);
        }
        selected.clear();
        persistActiveSelectionNow();
        syncAllDomVisuals();
        updateUI();
        setStatus('Selection cleared (archived to history).', '#94a3b8');
    }

    function exportSelection() {
        if (selected.size === 0) {
            setStatus('No artworks selected to export.', '#f59e0b');
            return;
        }
        const text = [...selected].join(',');
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => setStatus(`Exported ${selected.size} IDs to clipboard.`, '#10b981'))
                .catch(() => prompt('Copy artwork IDs:', text));
        } else {
            prompt('Copy artwork IDs:', text);
        }
    }

    function importSelection() {
        const input = prompt('Paste artwork IDs (comma, space, or newline separated):');
        if (input === null) return;
        const matches = input.match(/\d+/g);
        if (!matches || matches.length === 0) {
            setStatus('No valid artwork IDs detected.', '#f43f5e');
            return;
        }
        let count = 0;
        matches.forEach(id => {
            if (!selected.has(id)) {
                selected.add(id);
                count++;
            }
        });
        persistActiveSelectionNow();
        syncAllDomVisuals();
        updateUI();
        setStatus(`Imported ${count} new artworks (total: ${selected.size}).`, '#10b981');
    }

    function syncDomVisuals(id) {
        const isSel = selected.has(id);
        document.querySelectorAll(`a[href*="/artworks/${id}"]`).forEach(a => {
            if (!a.querySelector('img')) return;
            a.classList.toggle('ppt-art-selected', isSel);
            const chk = a.querySelector('.ppt-chk');
            if (chk) chk.classList.toggle('ppt-chk-on', isSel);
        });
    }

    function syncAllDomVisuals() {
        document.querySelectorAll('a[href*="/artworks/"]').forEach(a => {
            if (!a.querySelector('img')) return;
            const m = a.href.match(/\/artworks\/(\d+)/);
            if (!m) return;
            const isSel = selected.has(m[1]);
            a.classList.toggle('ppt-art-selected', isSel);
            const chk = a.querySelector('.ppt-chk');
            if (chk) chk.classList.toggle('ppt-chk-on', isSel);
        });
    }

    function markArtworkDone(id) {
        document.querySelectorAll(`a[href*="/artworks/${id}"]`).forEach(a => {
            if (!a.querySelector('img')) return;
            a.classList.remove('ppt-art-selected');
            a.classList.add('ppt-art-done');
            const chk = a.querySelector('.ppt-chk');
            if (chk) chk.classList.remove('ppt-chk-on');
        });
    }

    function injectCheckboxes() {
        const links = document.querySelectorAll('a[href*="/artworks/"]');
        for (const a of links) {
            if (!a.querySelector('img')) continue;
            const m = a.href.match(/\/artworks\/(\d+)/);
            if (!m) continue;
            const id = m[1];

            a.classList.add('ppt-art-link');

            let chk = a.querySelector('.ppt-chk');
            if (!chk) {
                chk = document.createElement('div');
                chk.className = 'ppt-chk';
                chk.dataset.illustId = id;
                chk.title = 'Select artwork';
                a.appendChild(chk);
            }
            const isSel = selected.has(id);
            chk.classList.toggle('ppt-chk-on', isSel);
            a.classList.toggle('ppt-art-selected', isSel);

            if (!a.querySelector('.ppt-dl')) {
                const dl = document.createElement('div');
                dl.className = 'ppt-dl';
                dl.dataset.illustId = id;
                dl.title = 'Download full resolution';
                dl.setAttribute('role', 'button');
                dl.setAttribute('aria-label', 'Download full resolution');
                dl.innerHTML = svg('download', 'ppt-i-sm');
                a.appendChild(dl);
            }
        }
    }

    function injectCheckboxesIncremental() {
        document.querySelectorAll('a[href*="/artworks/"]').forEach(a => {
            if (!a.querySelector('img')) return;
            const m = a.href.match(/\/artworks\/(\d+)/);
            if (!m) return;
            const id = m[1];

            a.classList.add('ppt-art-link');

            if (!a.querySelector('.ppt-chk')) {
                const chk = document.createElement('div');
                chk.className = 'ppt-chk';
                chk.dataset.illustId = id;
                chk.title = 'Select artwork';
                a.appendChild(chk);
            }
            if (!a.querySelector('.ppt-dl')) {
                const dl = document.createElement('div');
                dl.className = 'ppt-dl';
                dl.dataset.illustId = id;
                dl.title = 'Download full resolution';
                dl.setAttribute('role', 'button');
                dl.setAttribute('aria-label', 'Download full resolution');
                dl.innerHTML = svg('download', 'ppt-i-sm');
                a.appendChild(dl);
            }

            const isSel = selected.has(id);
            const chk = a.querySelector('.ppt-chk');
            if (chk) chk.classList.toggle('ppt-chk-on', isSel);
            a.classList.toggle('ppt-art-selected', isSel);
        });
    }

    let domSyncTimer = null;
    function scheduleDomSync() {
        if (domSyncTimer) return;
        domSyncTimer = setTimeout(() => {
            domSyncTimer = null;
            injectCheckboxes();
        }, 120);
    }

    document.body.addEventListener('click', e => {
        const dl = e.target.closest('.ppt-dl');
        if (dl) {
            e.preventDefault();
            e.stopPropagation();
            const id = dl.dataset.illustId;
            if (id) {
                dl.classList.add('busy');
                downloadArtwork(id, { allPages: true, sourceEl: dl });
            }
            return;
        }
        const chk = e.target.closest('.ppt-chk');
        if (chk) {
            e.preventDefault();
            e.stopPropagation();
            const id = chk.dataset.illustId;
            if (id) toggleSelection(id);
            return;
        }
        if (selectMode) {
            const link = e.target.closest('a[href*="/artworks/"]');
            if (link && link.querySelector('img')) {
                const m = link.href.match(/\/artworks\/(\d+)/);
                if (m) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelection(m[1]);
                }
            }
        }
    }, true);

    let isRunning = false;
    let stopRequested = false;

    async function runBulkOperation(type) {
        if (isRunning) return;
        if (selected.size === 0) {
            setStatus('Select artworks first.', '#f43f5e');
            return;
        }

        setStatus('Verifying session…', '#f59e0b');
        const token = await getTokenAsync();
        if (!token) {
            setStatus('CSRF token missing. Please refresh.', '#f43f5e');
            return;
        }

        const dailyLeft = config.dailyLimit - getDailyCount();
        if (dailyLeft <= 0) {
            setStatus('Daily limit reached. Resets at midnight.', '#f43f5e');
            return;
        }

        const targetTags = getActiveBookmarkTags();
        const isPrivate = getIsPrivateBookmark();
        const targetIds = [...selected].slice(0, dailyLeft);

        isRunning = true;
        stopRequested = false;
        setOperationRunningUI(true);

        let successCount = 0;
        let failCount = 0;

        try {
            for (let i = 0; i < targetIds.length; i++) {
                if (stopRequested) {
                    setStatus(`Stopped. Processed ${successCount}/${targetIds.length}.`, '#a78bfa');
                    break;
                }

                if (getDailyCount() >= config.dailyLimit) {
                    setStatus(`Daily limit hit (${successCount} completed).`, '#f43f5e');
                    break;
                }

                const id = targetIds[i];
                const currentNum = i + 1;
                const pct = Math.round((currentNum / targetIds.length) * 100);
                setProgress(pct);
                setStatus(`Processing ${currentNum}/${targetIds.length} (#${id})…`, '#f59e0b');

                let ok = false;
                if (type === 'like') {
                    const res = await requestLike(id, token);
                    ok = res.ok;
                } else if (type === 'like_and_bookmark') {
                    const likeRes = await requestLike(id, token);
                    const bmRes = await requestBookmark(id, token, {
                        tags: targetTags,
                        isPrivate: isPrivate
                    });
                    ok = likeRes.ok && bmRes.ok;
                }

                if (ok) {
                    successCount++;
                    addDailyCount(1);
                    selected.delete(id);
                    schedulePersistActiveSelection();
                    markArtworkDone(id);
                    updateUI();
                } else {
                    failCount++;
                }

                if (successCount > 0 && successCount % config.batchSize === 0 && i < targetIds.length - 1) {
                    let pauseSec = Math.floor(config.batchPause / 1000);
                    while (pauseSec > 0 && !stopRequested) {
                        setStatus(`Cooldown pause: ${pauseSec}s…`, '#a78bfa');
                        await sleep(1000);
                        pauseSec--;
                    }
                } else if (i < targetIds.length - 1 && !stopRequested) {
                    await randDelay(config.delayMin, config.delayMax);
                }
            }

            if (!stopRequested) {
                const summary = failCount === 0
                    ? `Finished: ${successCount} artworks processed.`
                    : `Completed: ${successCount} ok, ${failCount} failed.`;
                setStatus(summary, failCount === 0 ? '#10b981' : '#f59e0b');
                setProgress(100);
            }
        } catch (err) {
            console.error('[PPT] Bulk error:', err);
            setStatus(`Error: ${err.message || 'Operation failed'}`, '#f43f5e');
        } finally {
            isRunning = false;
            stopRequested = false;
            setOperationRunningUI(false);
            updateUI();
        }
    }

    const hoverEl = document.createElement('div');
    hoverEl.id = 'ppt-hover-preview';
    hoverEl.innerHTML = `
        <div id="ppt-hover-bar"></div>
        <div id="ppt-hover-img-wrap">
            <img id="ppt-hover-img" src="" alt="">
            <div id="ppt-hover-pagenum"></div>
            <div id="ppt-hover-hint">Scroll to browse pages</div>
        </div>
    `;
    document.body.appendChild(hoverEl);

    let _hoverTimer = null;
    let _hoverCache = {};
    let _hoverAbort = false;
    let _hoveredLink = null;
    let _currentPreviewData = null;
    let _currentPage = 0;

    function fetchArtworkDetail(id) {
        if (_hoverCache[id]) return Promise.resolve(_hoverCache[id]);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.pixiv.net/ajax/illust/${id}?lang=en`,
                headers: { 'Referer': location.href, 'Accept': 'application/json' },
                timeout: 6000,
                onload(res) {
                    try {
                        const j = JSON.parse(res.responseText);
                        if (j.error || !j.body) return resolve(null);
                        const b = j.body;
                        const data = {
                            id: b.id || id,
                            title: b.title || '',
                            author: b.userName || '',
                            bookmarks: parseInt(b.bookmarkCount, 10) || 0,
                            width: b.width || 0,
                            height: b.height || 0,
                            date: b.createDate ? b.createDate.substring(0, 10) : '',
                            tags: (b.tags?.tags || []).map(t => t.tag).join(', '),
                            imgUrl: b.urls?.regular || b.urls?.original || b.urls?.small || '',
                            pageCount: parseInt(b.pageCount, 10) || 1,
                            pages: null,
                            illustType: parseInt(b.illustType, 10) || 0,
                            originalUrl: b.urls?.original || '',
                            originalPages: null,
                        };

                        if (data.pageCount > 1) {
                            GM_xmlhttpRequest({
                                method: 'GET',
                                url: `https://www.pixiv.net/ajax/illust/${id}/pages?lang=en`,
                                headers: { 'Referer': location.href, 'Accept': 'application/json' },
                                timeout: 6000,
                                onload(pRes) {
                                    try {
                                        const pj = JSON.parse(pRes.responseText);
                                        if (!pj.error && Array.isArray(pj.body)) {
                                            data.pages = pj.body.map(p => p.urls?.regular || p.urls?.original || p.urls?.small || '');
                                            data.originalPages = pj.body.map(p => p.urls?.original || '');
                                        }
                                    } catch {}
                                    _hoverCache[id] = data;
                                    resolve(data);
                                },
                                onerror() {
                                    _hoverCache[id] = data;
                                    resolve(data);
                                }
                            });
                        } else {
                            _hoverCache[id] = data;
                            resolve(data);
                        }
                    } catch {
                        resolve(null);
                    }
                },
                onerror() { resolve(null); }
            });
        });
    }

    function showHoverPreview(data) {
        if (!data || _hoverAbort) return;
        _currentPreviewData = data;
        _currentPage = 0;
        const bar = document.getElementById('ppt-hover-bar');
        const img = document.getElementById('ppt-hover-img');
        const pageNum = document.getElementById('ppt-hover-pagenum');
        const scrollHint = document.getElementById('ppt-hover-hint');

        const isMulti = Array.isArray(data.pages) && data.pages.length > 1;
        hoverEl.classList.toggle('multipage', isMulti);

        bar.innerHTML = [
            `<span class="hb-bm">${svg('heart', 'ppt-i-sm')}${data.bookmarks}</span>`,
            `<span class="hb-dim">${data.width}x${data.height}</span>`,
            isMulti ? `<span class="hb-pages">${data.pages.length} pages</span>` : '',
            data.date ? `<span class="hb-date">${data.date}</span>` : '',
            data.author ? `<span class="hb-author">${escHtml(data.author)}</span>` : '',
            data.tags ? `<span class="hb-tags">${escHtml(data.tags)}</span>` : '',
        ].filter(Boolean).join('');

        if (isMulti) {
            pageNum.textContent = `1 / ${data.pages.length}`;
            scrollHint.style.opacity = '1';
            setTimeout(() => { if (scrollHint) scrollHint.style.opacity = '0'; }, 2200);
        }

        const targetUrl = isMulti ? data.pages[0] : data.imgUrl;
        img.onload = () => {
            if (_hoverAbort) { hoverEl.classList.remove('show'); return; }
            img.style.opacity = '1';
            hoverEl.classList.add('show');
        };
        img.onerror = () => { hoverEl.classList.remove('show'); };

        if (img.src === targetUrl && img.complete) {
            img.style.opacity = '1';
            hoverEl.classList.add('show');
        } else {
            img.src = targetUrl;
        }
    }

    function updatePreviewPage() {
        if (!_currentPreviewData?.pages) return;
        const img = document.getElementById('ppt-hover-img');
        const pageNum = document.getElementById('ppt-hover-pagenum');
        const url = _currentPreviewData.pages[_currentPage];
        if (!url) return;
        pageNum.textContent = `${_currentPage + 1} / ${_currentPreviewData.pages.length}`;
        if (img.src !== url) {
            img.style.opacity = '0.4';
            img.onload = () => { img.style.opacity = '1'; };
            img.src = url;
        }
    }

    function hideHoverPreview() {
        _hoverAbort = true;
        _currentPreviewData = null;
        _currentPage = 0;
        if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
        hoverEl.classList.remove('show', 'multipage');
    }

    document.addEventListener('wheel', e => {
        if (!_currentPreviewData?.pages || _currentPreviewData.pages.length <= 1) return;
        if (!hoverEl.classList.contains('show')) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            _currentPage = Math.min(_currentPage + 1, _currentPreviewData.pages.length - 1);
        } else {
            _currentPage = Math.max(_currentPage - 1, 0);
        }
        updatePreviewPage();
    }, { passive: false });

    document.body.addEventListener('mouseover', e => {
        if (!config.hoverPreview) return;
        const link = e.target.closest('a[href*="/artworks/"]');
        if (!link || !link.querySelector('img')) return;
        if (link === _hoveredLink) return;

        hideHoverPreview();
        _hoveredLink = link;
        const m = link.href.match(/\/artworks\/(\d+)/);
        if (!m) return;
        const id = m[1];
        _hoverAbort = false;

        _hoverTimer = setTimeout(async () => {
            if (_hoverAbort) return;
            const data = await fetchArtworkDetail(id);
            if (data) showHoverPreview(data);
        }, config.hoverDelay || 200);
    });

    document.addEventListener('mousemove', e => {
        if (!_hoveredLink) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) {
            _hoveredLink = null;
            hideHoverPreview();
            return;
        }
        const link = el.closest('a[href*="/artworks/"]');
        if (link === _hoveredLink) return;
        if (_hoveredLink && _hoveredLink.contains(el)) return;

        _hoveredLink = null;
        hideHoverPreview();
    });

    let _infScrollLoading = false;
    let _infScrollDone = false;
    let _infStartPage = (function () {
        const p = new URLSearchParams(location.search).get('p');
        return p ? Math.max(1, parseInt(p, 10)) : 1;
    })();
    let _infCurrentPage = _infStartPage;
    let _infLastLoadedPage = _infStartPage;
    let _infSeenIds = new Set();
    let _infGen = 0;
    let _allPagesRunning = false;
    let _allPagesGen = 0;
    let _allPagesAbort = false;

    function scrollPageLimit() {
        return Math.max(1, Math.min(1000, config.scrollPageLimit || 10));
    }

    function lastAllowedPage() {
        return _infStartPage + scrollPageLimit();
    }

    function pagesLoadedSoFar() {
        return Math.max(0, _infLastLoadedPage - _infStartPage);
    }

    function infChipText() {
        if (!config.infiniteScroll && !_allPagesRunning) return 'OFF';
        const loaded = Math.min(pagesLoadedSoFar(), scrollPageLimit());
        return `${loaded}/${scrollPageLimit()}`;
    }

    function setInfChip() {
        const el = document.getElementById('ppt-inf-status');
        if (el) el.textContent = infChipText();
    }

    const infLoaderEl = document.createElement('div');
    infLoaderEl.id = 'ppt-inf-loader';
    infLoaderEl.innerHTML = '<span class="ppt-spinner"></span>Loading page <span class="ppt-inf-page-num">2</span>';

    const infEndEl = document.createElement('div');
    infEndEl.id = 'ppt-inf-end';
    infEndEl.textContent = 'End of results';

    function collectExistingArtworkIds() {
        document.querySelectorAll('a[href*="/artworks/"]').forEach(a => {
            const m = a.href.match(/\/artworks\/(\d+)/);
            if (m) _infSeenIds.add(String(m[1]));
        });
    }

    function updateBrowserUrlPage(page) {
        try {
            const u = new URL(location.href);
            u.searchParams.set('p', String(page));
            history.replaceState(null, '', u.toString());
        } catch {}
    }

    function findArtworkGridContainer() {
        const links = document.querySelectorAll('a[href*="/artworks/"]');
        if (!links.length) return null;

        for (const link of links) {
            if (!link.querySelector('img')) continue;
            let el = link.parentElement;
            while (el && el !== document.body) {
                if (el.children.length >= 4) {
                    const distinctIds = new Set();
                    for (const child of el.children) {
                        const childArtLink = child.querySelector('a[href*="/artworks/"]');
                        if (childArtLink) {
                            const m = childArtLink.href.match(/\/artworks\/(\d+)/);
                            if (m) distinctIds.add(m[1]);
                        }
                    }
                    if (distinctIds.size >= 4) {
                        return el;
                    }
                }
                el = el.parentElement;
            }
        }

        let bestUl = null;
        let maxDistinct = 0;
        document.querySelectorAll('ul').forEach(ul => {
            const set = new Set();
            ul.querySelectorAll(':scope > * a[href*="/artworks/"]').forEach(a => {
                const m = a.href.match(/\/artworks\/(\d+)/);
                if (m) set.add(m[1]);
            });
            if (set.size > maxDistinct) {
                maxDistinct = set.size;
                bestUl = ul;
            }
        });
        if (bestUl && maxDistinct >= 3) return bestUl;

        return null;
    }

    function getArtworkCardTemplate(grid) {
        if (!grid || !grid.children.length) return null;
        for (const child of grid.children) {
            if (child.querySelector('a[href*="/artworks/"] img')) {
                return child;
            }
        }
        return null;
    }

    function buildNextApiUrl(page) {
        if (/\/users\/\d+\/bookmarks\/artworks/.test(location.pathname)) {
            const userMatch = location.pathname.match(/\/users\/(\d+)/);
            if (!userMatch) return null;
            const uid = userMatch[1];
            const params = new URLSearchParams(location.search);
            const tag = params.get('tag') || '';
            const rest = params.get('rest') || 'show';
            const limit = 48;
            const offset = (page - 1) * limit;
            return `https://www.pixiv.net/ajax/user/${uid}/illusts/bookmarks?tag=${encodeURIComponent(tag)}&offset=${offset}&limit=${limit}&rest=${rest}&lang=en`;
        }

        if (/\/(?:en\/)?tags\//.test(location.pathname) || location.pathname.includes('/search')) {
            const tagMatch = location.pathname.match(/\/(?:en\/)?tags\/([^/]+)/);
            const tag = tagMatch ? decodeURIComponent(tagMatch[1]) : (new URLSearchParams(location.search).get('q') || '');
            if (!tag) return null;
            const params = new URLSearchParams(location.search);
            const sMode = params.get('s_mode') || 's_tag_full';
            const order = params.get('order') || 'date_d';
            const mode = params.get('mode') || 'all';
            let type = 'artworks';
            if (location.pathname.includes('/illustrations')) type = 'illustrations';
            else if (location.pathname.includes('/manga')) type = 'manga';
            return `https://www.pixiv.net/ajax/search/${type}/${encodeURIComponent(tag)}?word=${encodeURIComponent(tag)}&order=${order}&mode=${mode}&p=${page}&s_mode=${sMode}&type=${type}&lang=en`;
        }

        if (/\/users\/\d+/.test(location.pathname)) {
            const userMatch = location.pathname.match(/\/users\/(\d+)/);
            if (!userMatch) return null;
            const uid = userMatch[1];
            const limit = 48;
            const offset = (page - 1) * limit;
            return `https://www.pixiv.net/ajax/user/${uid}/illusts/tag?tag=&offset=${offset}&limit=${limit}&lang=en`;
        }

        return null;
    }

    function parseWorksFromApiResponse(json) {
        if (json.error || !json.body) return [];
        const body = json.body;
        if (body.works && Array.isArray(body.works)) {
            seedLikeCounts(body.works);
            return body.works;
        }
        const candidates = [
            body.illust?.data,
            body.illustManga?.data,
            body.manga?.data,
            body.popular?.recent,
            body.popular?.permanent,
        ];
        for (const src of candidates) {
            if (Array.isArray(src) && src.length > 0) {
                seedLikeCounts(src);
                return src;
            }
        }
        return [];
    }

    function seedLikeCounts(works) {
        if (!Array.isArray(works)) return;
        works.forEach(w => {
            const id = String(w.id || w.illustId || '');
            if (!id) return;
            const raw = w.bookmarkCount ?? w.bookmarks;
            if (raw === undefined || raw === null) return;
            const cnt = parseInt(raw, 10);
            if (Number.isFinite(cnt) && typeof _bmCache[id] !== 'number') _bmCache[id] = cnt;
        });
    }

    function createThumbCardElement(work, templateItem) {
        const id = String(work.id || work.illustId || '');
        if (!id || _infSeenIds.has(id)) return null;
        _infSeenIds.add(id);

        const thumb = work.url || work.profileImageUrl || '';
        const title = work.title || '';
        const userName = work.userName || work.author || '';
        const userId = work.userId || work.authorId || '';
        const pageCount = parseInt(work.pageCount, 10) || 1;

        if (templateItem) {
            const clone = templateItem.cloneNode(true);
            clone.querySelectorAll('a[href*="/artworks/"]').forEach(a => {
                a.href = `/artworks/${id}`;
                a.classList.remove('ppt-art-link', 'ppt-art-selected', 'ppt-art-done');
                const oldChk = a.querySelector('.ppt-chk');
                if (oldChk) oldChk.remove();
                const oldDl = a.querySelector('.ppt-dl');
                if (oldDl) oldDl.remove();

                const oldBadge = a.querySelector('.ppt-bm');
                if (oldBadge) oldBadge.remove();
            });
            if (userId) {
                clone.querySelectorAll('a[href*="/users/"]').forEach(a => {
                    a.href = `/users/${userId}`;
                    if (userName && a.textContent && a.children.length === 0) {
                        a.textContent = userName;
                    }
                });
            }
            clone.querySelectorAll('img').forEach(img => {
                if (img.closest('a[href*="/artworks/"]')) {
                    img.src = thumb;
                    img.alt = title;
                    if (img.dataset) {
                        img.dataset.src = thumb;
                        delete img.dataset.lazyloadSrc;
                    }
                    img.removeAttribute('data-lazyload-src');
                    img.loading = 'lazy';
                }
            });
            const titleEl = clone.querySelector('a[href*="/artworks/"]:not(:has(img))') || clone.querySelector('[class*="title"], [class*="Title"]');
            if (titleEl && title) {
                titleEl.textContent = title;
                titleEl.title = title;
            }
            return clone;
        }

        const li = document.createElement('li');
        li.style.cssText = 'list-style:none;display:inline-block;';
        const a = document.createElement('a');
        a.href = `/artworks/${id}`;
        a.style.cssText = 'display:block;position:relative;border-radius:6px;overflow:hidden;';
        const img = document.createElement('img');
        img.src = thumb;
        img.alt = title;
        img.loading = 'lazy';
        img.style.cssText = 'width:184px;height:184px;object-fit:cover;display:block;background:#1a1d2e;';
        a.appendChild(img);
        if (pageCount > 1) {
            const badge = document.createElement('span');
            badge.textContent = pageCount;
            badge.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,.75);color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:700;';
            a.appendChild(badge);
        }
        li.appendChild(a);
        return li;
    }

    function hideNativePagination() {
        document.querySelectorAll('nav[role="navigation"], nav[class*="pager"], nav[class*="Pager"], [class*="pagination"]').forEach(nav => {
            nav.style.display = 'none';
        });
    }

    function showNativePagination() {
        document.querySelectorAll('nav[role="navigation"], nav[class*="pager"], nav[class*="Pager"], [class*="pagination"]').forEach(nav => {
            nav.style.display = '';
        });
    }

    function appendLoaderToDOM() {
        if (document.getElementById('ppt-inf-loader')) return;
        const grid = findArtworkGridContainer();
        const nav = document.querySelector('nav[role="navigation"], nav[class*="pager"], nav[class*="Pager"]');
        if (nav && nav.parentElement) {
            nav.parentElement.insertBefore(infLoaderEl, nav);
            nav.parentElement.insertBefore(infEndEl, nav);
        } else if (grid && grid.parentElement) {
            grid.parentElement.insertBefore(infLoaderEl, grid.nextSibling);
            grid.parentElement.insertBefore(infEndEl, grid.nextSibling);
        }
    }

    async function loadNextInfinitePage({ force = false } = {}) {
        if (_infScrollLoading || _infScrollDone) return false;
        if (!force && !config.infiniteScroll) return false;

        if (_infCurrentPage >= lastAllowedPage()) {
            _infScrollDone = true;
            infLoaderEl.classList.remove('show');
            infEndEl.textContent = `Reached the limit of ${scrollPageLimit()} extra pages`;
            infEndEl.classList.add('show');
            const infStatusEl = document.getElementById('ppt-inf-status');
            if (infStatusEl) infStatusEl.textContent = 'LIMIT ' + infChipText();
            return false;
        }

        _infScrollLoading = true;
        _infCurrentPage++;
        const gen = _infGen;

        const url = buildNextApiUrl(_infCurrentPage);
        if (!url) {
            _infScrollDone = true;
            _infScrollLoading = false;
            return false;
        }

        const pageNumEl = infLoaderEl.querySelector('.ppt-inf-page-num');
        if (pageNumEl) pageNumEl.textContent = _infCurrentPage;
        infLoaderEl.classList.add('show');

        const infStatusEl = document.getElementById('ppt-inf-status');
        if (infStatusEl) infStatusEl.textContent = infChipText();

        try {
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: { 'Referer': location.href, 'Accept': 'application/json' },
                    onload(res) {
                        try {
                            resolve(JSON.parse(res.responseText));
                        } catch {
                            reject('parse error');
                        }
                    },
                    onerror() { reject('network error'); }
                });
            });

            const works = parseWorksFromApiResponse(response);
            if (gen !== _infGen || (!force && !config.infiniteScroll)) {
                _infCurrentPage = Math.max(_infStartPage, _infCurrentPage - 1);
                return false;
            }

            if (works.length === 0) {
                _infScrollDone = true;
                infLoaderEl.classList.remove('show');
                infEndEl.textContent = 'End of results';
                infEndEl.classList.add('show');
                if (infStatusEl) infStatusEl.textContent = 'END ' + infChipText();
                return false;
            }

            const grid = findArtworkGridContainer();
            if (!grid) {
                _infCurrentPage = Math.max(_infStartPage, _infCurrentPage - 1);
                return false;
            }

            const templateItem = getArtworkCardTemplate(grid);
            let added = 0;
            works.forEach(work => {
                const el = createThumbCardElement(work, templateItem);
                if (el) {
                    grid.appendChild(el);
                    added++;
                }
            });

            injectCheckboxesIncremental();
            syncAllDomVisuals();
            if (sortMode && config.liveSort && !_allPagesRunning) scheduleSortGrid();

            updateBrowserUrlPage(_infCurrentPage);
            if (added > 0) _infLastLoadedPage = _infCurrentPage;
            setInfChip();
            return added > 0;
        } catch (err) {
            console.warn('[PPT] Infinite scroll error:', err);
            _infCurrentPage--;
            return false;
        } finally {
            infLoaderEl.classList.remove('show');
            _infScrollLoading = false;
        }
    }

    function nearScrollBottom() {
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;
        return docHeight - scrollBottom < 850;
    }

    function onInfScroll() {
        if (!config.infiniteScroll || _infScrollLoading || _infScrollDone) return;
        if (_allPagesRunning) return;
        if (!nearScrollBottom()) return;

        loadNextInfinitePage().then(added => {
            if (!added) return;
            if (!config.infiniteScroll || _infScrollDone || _allPagesRunning) return;
            if (!nearScrollBottom()) return;
            setTimeout(onInfScroll, 160);
        });
    }

    function rebaseIfNothingLoaded() {
        if (_infCurrentPage > _infStartPage) return;
        const p = new URLSearchParams(location.search).get('p');
        const urlPage = p ? Math.max(1, parseInt(p, 10)) : 1;
        if (urlPage === _infStartPage) return;
        _infStartPage = urlPage;
        _infCurrentPage = urlPage;
        _infLastLoadedPage = urlPage;
        _infSeenIds = new Set();
    }

    function enableInfiniteScroll() {
        config.infiniteScroll = true;
        saveConfig(config);
        rebaseIfNothingLoaded();
        _infScrollDone = false;

        const toggle = document.getElementById('ppt-inf-toggle');
        if (toggle) toggle.checked = true;

        collectExistingArtworkIds();
        appendLoaderToDOM();
        hideNativePagination();
        window.addEventListener('scroll', onInfScroll, { passive: true });

        const infStatusEl = document.getElementById('ppt-inf-status');
        setInfChip();
        onInfScroll();
    }

    function disableInfiniteScroll({ navigate = true } = {}) {
        config.infiniteScroll = false;
        saveConfig(config);
        stopLoadingAllPages();
        _infGen++;
        _infScrollLoading = false;

        const toggle = document.getElementById('ppt-inf-toggle');
        if (toggle) toggle.checked = false;

        window.removeEventListener('scroll', onInfScroll);
        infLoaderEl.classList.remove('show');
        infEndEl.classList.remove('show');
        showNativePagination();

        const infStatusEl = document.getElementById('ppt-inf-status');
        if (infStatusEl) infStatusEl.textContent = 'OFF';

        if (!navigate) return;

        const target = Math.max(_infStartPage, Math.min(_infLastLoadedPage, lastAllowedPage()));
        if (target <= _infStartPage) return;

        const u = new URL(location.href);
        u.searchParams.set('p', String(target));

        if (u.toString() === location.href) {
            location.reload();
            return;
        }
        location.assign(u.toString());
    }

    let sortMode = false;
    let _sortGen = 0;
    let _sortTimer = null;
    let _isSorting = false;
    const _bmCache = {};
    let _originalOrder = null;

    function runPool(items, worker, limit = 5) {
        return new Promise(resolve => {
            const results = new Array(items.length);
            if (items.length === 0) return resolve(results);

            let next = 0;
            let active = 0;
            let done = 0;

            const pump = () => {
                while (active < limit && next < items.length) {
                    const i = next++;
                    active++;
                    Promise.resolve()
                        .then(() => worker(items[i], i))
                        .catch(() => null)
                        .then(v => {
                            results[i] = v;
                            active--;
                            done++;
                            if (done === items.length) resolve(results);
                            else pump();
                        });
                }
            };
            pump();
        });
    }

    function fetchLikeCount(id) {
        id = String(id);
        if (typeof _bmCache[id] === 'number') return Promise.resolve(_bmCache[id]);

        const hc = _hoverCache[id];
        if (hc && typeof hc.bookmarks === 'number') {
            _bmCache[id] = hc.bookmarks;
            return Promise.resolve(hc.bookmarks);
        }

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.pixiv.net/ajax/illust/${id}?lang=en`,
                headers: { 'Referer': location.href, 'Accept': 'application/json' },
                timeout: 8000,
                onload(res) {
                    try {
                        const j = JSON.parse(res.responseText);
                        if (j.error || !j.body) return resolve(null);
                        const cnt = parseInt(j.body.bookmarkCount, 10) || 0;
                        _bmCache[id] = cnt;
                        if (_hoverCache[id]) _hoverCache[id].bookmarks = cnt;
                        resolve(cnt);
                    } catch {
                        resolve(null);
                    }
                },
                onerror() { resolve(null); },
                ontimeout() { resolve(null); }
            });
        });
    }

    function getGridCards() {
        const grid = findArtworkGridContainer();
        if (!grid) return { grid: null, cards: [] };

        const cards = [];
        for (const child of Array.from(grid.children)) {
            const link = child.querySelector('a[href*="/artworks/"]');
            if (!link || !link.querySelector('img')) continue;
            const m = link.href.match(/\/artworks\/(\d+)/);
            if (!m) continue;
            cards.push({ el: child, id: m[1], index: cards.length });
        }
        return { grid, cards };
    }

    function applyOrder(cards, orderedCards) {
        const live = cards.filter(c => c.el.parentNode);
        if (live.length === 0) return;

        const slots = live.map(c => {
            const marker = document.createComment('ppt-slot');
            c.el.parentNode.insertBefore(marker, c.el);
            return marker;
        });

        orderedCards.filter(c => c.el.parentNode).forEach((c, i) => {
            const marker = slots[i];
            if (!marker || !marker.parentNode) return;
            marker.parentNode.insertBefore(c.el, marker);
        });

        slots.forEach(m => m.remove());
    }

    async function sortGridByPopularity({ silent = false } = {}) {
        if (isRunning) {
            if (!silent) setStatus('Busy with another operation. Try again when it finishes.', '#f59e0b');
            return;
        }

        if (_isSorting) {
            if (silent) scheduleSortGrid();
            return;
        }

        const { grid, cards } = getGridCards();
        if (!grid || cards.length < 2) {
            if (!silent) setStatus('No artwork grid found on this page.', '#f59e0b');
            return;
        }

        _isSorting = true;
        try {
            const gen = ++_sortGen;
            if (!_originalOrder) _originalOrder = cards.map(c => c.el);

            const uncached = cards.filter(c => typeof _bmCache[c.id] !== 'number').map(c => c.id);

            if (uncached.length > 0) {
                const total = uncached.length;
                let done = 0;
                setProgress(0);
                setStatus(`Ranking by likes… 0/${total}`, '#f59e0b');

                const results = await runPool(uncached, async id => {
                    let v = await fetchLikeCount(id);
                    if (v === null) v = await fetchLikeCount(id);
                    done++;
                    if (gen === _sortGen) {
                        setStatus(`Ranking by likes… ${done}/${total}`, '#f59e0b');
                        setProgress(Math.round((done / total) * 100));
                    }
                    return v;
                }, 5);

                if (gen !== _sortGen) return;

                uncached.forEach((id, i) => {
                    if (typeof _bmCache[id] !== 'number') {
                        _bmCache[id] = typeof results[i] === 'number' ? results[i] : -1;
                    }
                });
            }

            if (gen !== _sortGen) return;

            const fresh = getGridCards().cards;
            const countOf = c => (typeof _bmCache[c.id] === 'number' ? _bmCache[c.id] : -1);
            const ordered = [...fresh].sort((a, b) => (countOf(b) - countOf(a)) || (a.index - b.index));

            applyOrder(fresh, ordered);
            paintLikeBadges();
            syncAllDomVisuals();

            setProgress(-1);
            if (!_allPagesRunning) {
                setStatus(`Sorted ${fresh.length} artworks by likes.`, '#10b981');
            }
        } finally {
            _isSorting = false;
        }
    }

    function paintLikeBadges() {
        const { cards } = getGridCards();
        cards.forEach(c => {
            const link = c.el.querySelector('a[href*="/artworks/"]');
            if (!link) return;

            let badge = link.querySelector('.ppt-bm');
            const cnt = typeof _bmCache[c.id] === 'number' ? _bmCache[c.id] : null;

            if (!config.showLikeBadges || cnt === null || cnt < 0) {
                if (badge) badge.remove();
                return;
            }
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ppt-bm';
                link.appendChild(badge);
            }
            badge.textContent = `${cnt.toLocaleString()} likes`;
        });
    }

    function clearLikeBadges() {
        document.querySelectorAll('.ppt-bm').forEach(b => b.remove());
    }

    function restoreOriginalOrder() {
        if (!_originalOrder) {
            setStatus('Nothing to restore. Sort the grid first.', '#f59e0b');
            return;
        }

        _sortGen++;
        const { cards } = getGridCards();
        if (cards.length === 0) return;

        const live = cards.map(c => c.el);
        const liveSet = new Set(live);
        const fromOriginal = _originalOrder.filter(el => liveSet.has(el));
        const seen = new Set(fromOriginal);
        const extras = live.filter(el => !seen.has(el));

        applyOrder(cards, [...fromOriginal, ...extras].map(el => ({ el })));
        clearLikeBadges();
        syncAllDomVisuals();
        setStatus('Restored original order.', '#94a3b8');
    }

    function scheduleSortGrid() {
        if (_sortTimer) clearTimeout(_sortTimer);
        _sortTimer = setTimeout(() => {
            _sortTimer = null;
            if (!sortMode || !config.liveSort) return;

            if (_infScrollLoading) return scheduleSortGrid();
            sortGridByPopularity({ silent: true });
        }, 400);
    }

    function toggleSortMode(on) {
        sortMode = typeof on === 'boolean' ? on : !sortMode;

        const btn = document.getElementById('btn-sort-likes');
        if (btn) {
            btn.classList.toggle('active', sortMode);
            btn.setAttribute('aria-pressed', sortMode ? 'true' : 'false');
            const state = btn.querySelector('.ppt-toggle-state');
            if (state) state.textContent = sortMode ? 'ON' : 'OFF';
        }

        if (sortMode) {
            loadEveryPageThenSort();
        } else {
            stopLoadingAllPages();
            restoreOriginalOrder();
        }
    }

    let _lastKey = location.pathname + location.search.replace(/[?&]p=\d+/, '');
    let _navTimer = null;

    function currentNavKey() {
        return location.pathname + location.search.replace(/[?&]p=\d+/, '');
    }

    function resetPerPageState() {
        _sortGen++;
        _isSorting = false;
        _originalOrder = null;
        _infGen++;
        _infScrollLoading = false;
        _infSeenIds = new Set();
        _infScrollDone = false;
        _infStartPage = (function () {
            const p = new URLSearchParams(location.search).get('p');
            return p ? Math.max(1, parseInt(p, 10)) : 1;
        })();
        _infCurrentPage = _infStartPage;
        _infLastLoadedPage = _infStartPage;
        document.querySelectorAll('.ppt-bm').forEach(b => b.remove());
        infEndEl.textContent = 'End of results';
        infEndEl.classList.remove('show');
    }

    function handlePossibleNavigation() {
        const key = currentNavKey();
        if (key === _lastKey) return;
        _lastKey = key;

        if (_navTimer) clearTimeout(_navTimer);
        _navTimer = setTimeout(() => {
            _navTimer = null;
            if (!findArtworkGridContainer()) return;

            resetPerPageState();
            collectExistingArtworkIds();

            if (config.infiniteScroll) appendLoaderToDOM();

            if (sortMode) {
                loadEveryPageThenSort({ silent: true });
            }
        }, 600);
    }

    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function () {
        const r = _pushState.apply(this, arguments);
        window.dispatchEvent(new Event('ppt:locationchange'));
        return r;
    };
    history.replaceState = function () {
        const r = _replaceState.apply(this, arguments);
        window.dispatchEvent(new Event('ppt:locationchange'));
        return r;
    };
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('ppt:locationchange')));
    window.addEventListener('ppt:locationchange', handlePossibleNavigation);


    async function loadEveryPageThenSort({ silent = false } = {}) {
        if (isRunning) {
            if (!silent) setStatus('Busy with another operation. Try again when it finishes.', '#f59e0b');
            return;
        }

        const gen = ++_allPagesGen;
        _allPagesRunning = true;
        _allPagesAbort = false;
        setOperationRunningUI(false);
        const stopBtn = document.getElementById('btn-stop-op');
        if (stopBtn) stopBtn.style.display = 'flex';

        collectExistingArtworkIds();
        appendLoaderToDOM();
        _infScrollDone = false;
        infEndEl.classList.remove('show');

        let pagesFetched = 0;
        const superseded = () => gen !== _allPagesGen || _allPagesAbort || !sortMode;

        try {
            for (;;) {
                if (superseded()) break;

                const added = await loadNextInfinitePage({ force: true });
                if (superseded()) break;
                if (!added) break;

                pagesFetched++;

                const loaded = getGridCards().cards.length;
                if (!silent) setStatus(`Loading ${pagesLoadedSoFar()}/${scrollPageLimit()} extra pages. ${loaded} artworks loaded.`, '#f59e0b');
                setProgress(Math.min(99, Math.round((pagesLoadedSoFar() / scrollPageLimit()) * 100)));

                await sleep(200);
            }

            if (gen !== _allPagesGen) return;

            if (_allPagesAbort) {
                setStatus('Stopped loading pages.', '#a78bfa');
                setProgress(-1);
                return;
            }

            const total = getGridCards().cards.length;
            setStatus(`Ranking ${total} artworks…`, '#f59e0b');
            await sortGridByPopularity({ silent: true });
            setProgress(-1);

            const span = pagesLoadedSoFar() + 1;
            setStatus(`Ranked ${total} artworks across ${span} page${span === 1 ? '' : 's'}.`, '#10b981');
        } catch (err) {
            console.error('[PPT] Load-all error:', err);
            if (gen === _allPagesGen) {
                setProgress(-1);
                setStatus(`Stopped after ${pagesFetched} pages: ${err.message || 'error'}`, '#f59e0b');
            }
        } finally {
            if (gen === _allPagesGen) {
                _allPagesRunning = false;
                setOperationRunningUI(false);
                const infStatusEl = document.getElementById('ppt-inf-status');
                setInfChip();
            }
        }
    }

    function stopLoadingAllPages() {
        if (!_allPagesRunning) return false;
        _allPagesAbort = true;
        return true;
    }

    let dlStopRequested = false;
    let _bulkDownloadRunning = false;
    let _dlRunning = 0;
    const _dlPumps = new Set();
    const _dlMetaCache = {};

    function sanitizeFilename(str) {
        return String(str || '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/[\x00-\x1f\x7f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || 'pixiv';
    }

    function extFromUrl(url, fallback = 'jpg') {
        try {
            const path = new URL(url, location.origin).pathname;
            const m = path.match(/\.([a-z0-9]{2,5})$/i);
            if (m) return m[1].toLowerCase();
        } catch {}
        return fallback;
    }

    function fetchIllustOriginals(id) {
        id = String(id);
        if (_dlMetaCache[id]) return Promise.resolve(_dlMetaCache[id]);

        const cached = _hoverCache[id];
        if (cached && (cached.originalUrl || cached.imgUrl)) {

            const orig = (Array.isArray(cached.originalPages) ? cached.originalPages : [cached.originalUrl])
                .filter(Boolean);
            const reg = (Array.isArray(cached.pages) ? cached.pages : [cached.imgUrl])
                .filter(Boolean);
            const pages = orig.length > 0 ? orig : reg;

            if (pages.length > 0) {
                const meta = {
                    title: cached.title || `illust_${id}`,
                    illustType: cached.illustType || 0,
                    pageCount: cached.pageCount || pages.length,
                    originals: pages,
                    fellBack: orig.length === 0,
                };
                _dlMetaCache[id] = meta;
                return Promise.resolve(meta);
            }
        }

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.pixiv.net/ajax/illust/${id}?lang=en`,
                headers: { 'Referer': location.href, 'Accept': 'application/json' },
                timeout: 8000,
                onload(res) {
                    let body = null;
                    try {
                        const j = JSON.parse(res.responseText);
                        if (!j.error && j.body) body = j.body;
                    } catch {}
                    if (!body) return resolve(null);

                    const meta = {
                        title: body.title || `illust_${id}`,
                        illustType: parseInt(body.illustType, 10) || 0,
                        pageCount: parseInt(body.pageCount, 10) || 1,

                        originals: [body.urls?.original || body.urls?.regular || body.urls?.small || ''],
                        fellBack: !body.urls?.original && !!(body.urls?.regular || body.urls?.small),
                    };

                    const finish = () => {
                        meta.originals = meta.originals.filter(Boolean);
                        if (meta.originals.length === 0) return resolve(null);
                        _dlMetaCache[id] = meta;
                        resolve(meta);
                    };

                    if (meta.pageCount > 1 && meta.illustType !== 2) {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: `https://www.pixiv.net/ajax/illust/${id}/pages?lang=en`,
                            headers: { 'Referer': location.href, 'Accept': 'application/json' },
                            timeout: 8000,
                            onload(pRes) {
                                try {
                                    const pj = JSON.parse(pRes.responseText);
                                    if (!pj.error && Array.isArray(pj.body)) {
                                        const list = pj.body.map(p => p.urls?.original || '').filter(Boolean);
                                        if (list.length > 0) meta.originals = list;
                                    }
                                } catch {}
                                finish();
                            },
                            onerror() { finish(); },
                            ontimeout() { finish(); }
                        });
                    } else {
                        finish();
                    }
                },
                onerror() { resolve(null); },
                ontimeout() { resolve(null); }
            });
        });
    }

    function saveBlob(blob, filename) {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(objUrl);
        }, 2000);
    }

    function downloadBlob(url, filename) {
        return new Promise(resolve => {
            const fallbackToGM = () => {
                if (typeof GM_download === 'function') {
                    try {
                        GM_download({
                            url,
                            name: filename,
                            headers: { 'Referer': 'https://www.pixiv.net/' },
                            onload: () => resolve({ ok: true, via: 'gm' }),
                            onerror: () => resolve({ ok: false }),
                            ontimeout: () => resolve({ ok: false })
                        });
                        return;
                    } catch {}
                }
                resolve({ ok: false });
            };

            if (typeof GM_xmlhttpRequest === 'undefined') return fallbackToGM();

            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                headers: { 'Referer': 'https://www.pixiv.net/', 'Accept': 'image/*,*/*' },
                timeout: 120000,
                onload(res) {
                    if (res.status < 200 || res.status >= 300) return fallbackToGM();

                    let blob = res.response;
                    if (!(blob instanceof Blob)) {
                        if (typeof blob === 'string' && blob.length > 0) {
                            try {
                                blob = new Blob([blob], { type: 'application/octet-stream' });
                            } catch {
                                return fallbackToGM();
                            }
                        } else {
                            return fallbackToGM();
                        }
                    }
                    if (blob.size === 0) return fallbackToGM();

                    saveBlob(blob, filename);
                    resolve({ ok: true, bytes: blob.size });
                },
                onerror() { fallbackToGM(); },
                ontimeout() { fallbackToGM(); }
            });
        });
    }

    function enqueueDownloadJobs(jobs, onProgress) {
        return new Promise(resolve => {
            if (jobs.length === 0) return resolve({ ok: 0, fail: 0 });

            let idx = 0;
            let done = 0;
            let ok = 0;
            let fail = 0;

            const pump = () => {
                const limit = Math.max(1, Math.min(4, config.dlConcurrency || 2));
                while (_dlRunning < limit && idx < jobs.length) {
                    const job = jobs[idx++];
                    _dlRunning++;

                    downloadBlob(job.url, job.filename)
                        .then(r => { if (r.ok) ok++; else fail++; })
                        .catch(() => { fail++; })
                        .then(() => {
                            _dlRunning--;
                            done++;
                            if (onProgress) onProgress(ok, fail, done, jobs.length);
                            if (done === jobs.length) {
                                _dlPumps.delete(pump);
                                resolve({ ok, fail });
                            } else {
                                wakeDownloadPumps();
                            }
                        });
                }
            };

            _dlPumps.add(pump);
            pump();
        });
    }

    function wakeDownloadPumps() {
        _dlPumps.forEach(p => {
            try { p(); } catch {}
        });
    }

    async function downloadArtwork(id, { allPages = true, sourceEl = null, silent = false } = {}) {
        if (isRunning && !_bulkDownloadRunning) {
            setStatus('Busy with another operation. Try again when it finishes.', '#f59e0b');
            if (sourceEl) sourceEl.classList.remove('busy');
            return;
        }

        try {
            if (!silent) setStatus(`Fetching artwork info… (#${id})`, '#f59e0b');

            const meta = await fetchIllustOriginals(id);
            if (!meta || meta.originals.length === 0) {
                setStatus(`Could not resolve the original file for #${id}.`, '#f43f5e');
                return;
            }

            const urls = allPages ? meta.originals : meta.originals.slice(0, 1);
            const base = sanitizeFilename(meta.title);
            const jobs = urls.map((url, i) => ({
                url,
                filename: `${base}_${id}_p${i}.${extFromUrl(url)}`
            }));

            if (!silent) setStatus(`Downloading ${base} (0/${jobs.length})…`, '#f59e0b');

            const res = await enqueueDownloadJobs(jobs, (ok, fail, done, total) => {
                if (!silent) setStatus(`Downloading ${base} (${done}/${total})…`, '#f59e0b');
            });

            if (res.fail === 0) {
                const note = meta.fellBack ? ' (original unavailable, saved largest available)' : '';
                setStatus(`Downloaded ${jobs.length} file${jobs.length > 1 ? 's' : ''}: ${base}${note}`, meta.fellBack ? '#f59e0b' : '#10b981');
            } else {
                setStatus(`Downloaded ${res.ok}/${jobs.length} for ${base} (${res.fail} failed).`, '#f59e0b');
            }
        } catch (err) {
            console.error('[PPT] Download error:', err);
            setStatus(`Error: ${err.message || 'Download failed'}`, '#f43f5e');
        } finally {
            if (sourceEl) sourceEl.classList.remove('busy');
        }
    }

    async function runBulkDownload() {
        if (isRunning) return;
        if (selected.size === 0) {
            setStatus('Select artworks first.', '#f43f5e');
            return;
        }

        const targetIds = [...selected];
        isRunning = true;
        _bulkDownloadRunning = true;
        dlStopRequested = false;
        setOperationRunningUI(true);
        setProgress(0);

        let okWorks = 0;
        let failWorks = 0;

        try {
            for (let i = 0; i < targetIds.length; i++) {
                if (dlStopRequested) {
                    setStatus(`Stopped. Downloaded ${okWorks}/${targetIds.length} artworks.`, '#a78bfa');
                    break;
                }

                const id = targetIds[i];
                setProgress(Math.round(((i + 1) / targetIds.length) * 100));
                setStatus(`Downloading ${i + 1}/${targetIds.length} (#${id})…`, '#f59e0b');

                const meta = await fetchIllustOriginals(id);
                if (!meta || meta.originals.length === 0) {
                    failWorks++;
                    continue;
                }

                const base = sanitizeFilename(meta.title);
                const jobs = meta.originals.map((url, p) => ({
                    url,
                    filename: `${base}_${id}_p${p}.${extFromUrl(url)}`
                }));

                const res = await enqueueDownloadJobs(jobs);
                if (res.ok > 0) okWorks++;
                else failWorks++;

                if (!dlStopRequested && i < targetIds.length - 1) {
                    await randDelay(config.delayMin, config.delayMax);
                }
            }

            if (!dlStopRequested) {
                const summary = failWorks === 0
                    ? `Finished: ${okWorks} artworks downloaded.`
                    : `Completed: ${okWorks} ok, ${failWorks} failed.`;
                setStatus(summary, failWorks === 0 ? '#10b981' : '#f59e0b');
                setProgress(100);
            }
        } catch (err) {
            console.error('[PPT] Bulk download error:', err);
            setStatus(`Error: ${err.message || 'Download failed'}`, '#f43f5e');
        } finally {
            isRunning = false;
            _bulkDownloadRunning = false;
            dlStopRequested = false;
            setOperationRunningUI(false);
            updateUI();
        }
    }

    const ICONS = {
        heart: '<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>',
        bookmark: '<path d="M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"/>',
        download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>',
        upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>',
        refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
        settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
        history: '<path d="M12 8l0 4l2 2"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>',
        x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
        check: '<path d="M5 12l5 5l10 -10"/>',
        minus: '<path d="M5 12l14 0"/>',
        star: '<path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/>',
        tag: '<path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/>',
        lock: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
        trash: '<path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
        flame: '<path d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.621 -2.333 5.588c0 3.704 3.134 6.706 7 6.706s7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235"/>',
        pointer: '<path d="M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 -.309 -2.228l-13.582 -3.904l3.904 13.563z"/>',
        arrowsSort: '<path d="M3 9l4 -4l4 4m-4 -4v14"/><path d="M21 15l-4 4l-4 -4m4 4v-14"/>',
        infinity: '<path d="M9.828 9.172a4 4 0 1 0 0 5.656a10 10 0 0 0 2.172 -2.828a10 10 0 0 1 2.172 -2.828a4 4 0 1 1 0 5.656a10 10 0 0 1 -2.172 -2.828a10 10 0 0 0 -2.172 -2.828"/>',
        plus: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
        arrowBack: '<path d="M9 11l-4 4l4 4m-4 -4h11a4 4 0 0 0 0 -8h-1"/>',
        pencil: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
        clipboard: '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/>',
        deviceFloppy: '<path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2"/><path d="M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M14 4l0 4l-6 0l0 -4"/>',
        eyeOff: '<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>',
        handStop: '<path d="M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5"/><path d="M14 5.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47"/>',
        squareX: '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M9 9l6 6m0 -6l-6 6"/>',
        eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
        sortDesc: '<path d="M4 6l9 0"/><path d="M4 12l7 0"/><path d="M4 18l7 0"/><path d="M15 15l3 3l3 -3"/><path d="M18 6l0 12"/>',
        restore: '<path d="M3.06 13a9 9 0 1 0 .49 -4.087"/><path d="M3 4.001v5h5"/><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
    };

    function svg(name, cls = 'ppt-i') {
        const body = ICONS[name];
        if (!body) return '';
        return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        :root {
            --ppt-bg: #0a0a0c;
            --ppt-surface: #101014;
            --ppt-surface-2: #16161b;
            --ppt-surface-3: #1d1d24;
            --ppt-line: #232329;
            --ppt-line-2: #30303a;
            --ppt-text: #ededf0;
            --ppt-text-2: #a3a3ad;
            --ppt-text-3: #8a8a96;
            --ppt-accent: #f43f5e;
            --ppt-accent-strong: #e11d48;
            --ppt-accent-soft: rgba(244, 63, 94, 0.13);
            --ppt-accent-line: rgba(244, 63, 94, 0.4);
            --ppt-ok: #34d399;
            --ppt-ok-soft: rgba(52, 211, 153, 0.12);
            --ppt-warn: #fbbf24;
            --ppt-danger: #f87171;
            --ppt-r-xs: 3px;
            --ppt-r-sm: 5px;
            --ppt-r: 6px;
            --ppt-r-lg: 10px;
            --ppt-r-pill: 999px;
            --ppt-ease: cubic-bezier(0.16, 1, 0.3, 1);
            --ppt-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
            --ppt-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }

        #ppt-panel {
            position: fixed;
            top: 76px;
            right: 18px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            width: 268px;
            min-width: 220px;
            max-width: min(560px, calc(100vw - 20px));
            max-height: calc(100vh - 96px);
            background: var(--ppt-bg);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r-lg);
            color: var(--ppt-text);
            font-family: var(--ppt-sans);
            font-size: 11px;
            line-height: 1.45;
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.5);
            user-select: none;
            box-sizing: border-box;
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }
        #ppt-panel *, #ppt-hover-preview *, #ppt-inf-loader *, #ppt-inf-end * { box-sizing: border-box; }
        #ppt-panel.minimized { width: auto; }
        #ppt-panel.minimized .ppt-view, #ppt-panel.minimized .ppt-tabs, #ppt-panel.minimized .ppt-resize { display: none !important; }

        /* ---------- Resize handles ---------- */
        .ppt-resize {
            position: absolute;
            z-index: 3;
            touch-action: none;
        }
        .ppt-resize-e { top: 0; right: 0; width: 6px; height: 100%; cursor: ew-resize; }
        .ppt-resize-s { left: 0; bottom: 0; width: 100%; height: 6px; cursor: ns-resize; }
        .ppt-resize-w { top: 0; left: 0; width: 6px; height: 100%; cursor: ew-resize; }
        .ppt-resize-se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
        .ppt-resize-sw { left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; }
        .ppt-resize-grip {
            position: absolute;
            right: 3px;
            bottom: 3px;
            width: 9px;
            height: 9px;
            pointer-events: none;
            opacity: 0.4;
            transition: opacity 0.15s var(--ppt-ease);
            background:
                linear-gradient(135deg, transparent 0 45%, currentColor 45% 55%, transparent 55% 100%),
                linear-gradient(135deg, transparent 0 72%, currentColor 72% 82%, transparent 82% 100%);
            color: var(--ppt-text-3);
        }
        #ppt-panel:hover .ppt-resize-grip { opacity: 0.85; }
        body.ppt-resizing { user-select: none !important; }
        body.ppt-resizing iframe { pointer-events: none; }

        #ppt-panel svg.ppt-i { width: 14px; height: 14px; flex: none; stroke-width: 1.75; }
        #ppt-panel svg.ppt-i-sm { width: 12px; height: 12px; flex: none; stroke-width: 1.75; }

        /* ---------- Header ---------- */
        .ppt-hdr {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 9px 11px;
            cursor: grab;
            background: var(--ppt-surface);
            border-bottom: 1px solid var(--ppt-line);
        }
        .ppt-hdr:active { cursor: grabbing; }
        .ppt-brand {
            display: flex;
            align-items: center;
            gap: 7px;
            pointer-events: none;
            min-width: 0;
        }
        .ppt-brand-mark {
            display: grid;
            place-items: center;
            width: 20px;
            height: 20px;
            flex: none;
            border-radius: var(--ppt-r-sm);
            background: var(--ppt-accent-soft);
            color: var(--ppt-accent);
        }
        .ppt-brand-mark svg { width: 13px; height: 13px; stroke-width: 2; }
        .ppt-brand-name {
            font-size: 11.5px;
            font-weight: 650;
            letter-spacing: -0.01em;
            color: var(--ppt-text);
            white-space: nowrap;
        }
        .ppt-hdr-actions { display: flex; align-items: center; gap: 2px; flex: none; }
        .ppt-icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            padding: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--ppt-r);
            color: var(--ppt-text-3);
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease);
        }
        .ppt-icon-btn:hover { background: var(--ppt-surface-3); color: var(--ppt-text); }
        .ppt-icon-btn:active { transform: scale(0.94); }
        .ppt-icon-btn.active { background: var(--ppt-accent-soft); border-color: var(--ppt-accent-line); color: var(--ppt-accent); }

        /* ---------- Tabs ---------- */
        .ppt-tabs {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 3px;
            padding: 7px 8px;
            background: var(--ppt-bg);
            border-bottom: 1px solid var(--ppt-line);
        }
        .ppt-tab {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            height: 26px;
            padding: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--ppt-r);
            color: var(--ppt-text-3);
            font-family: var(--ppt-sans);
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease);
        }
        .ppt-tab:hover { background: var(--ppt-surface-2); color: var(--ppt-text-2); }
        .ppt-tab.active {
            background: var(--ppt-surface-3);
            border-color: var(--ppt-line-2);
            color: var(--ppt-text);
        }
        .ppt-tab.active svg { color: var(--ppt-accent); }

        /* ---------- Views ---------- */
        .ppt-view { display: none; padding: 11px; overflow-y: auto; overscroll-behavior: contain; }
        .ppt-view.ppt-view-active { display: block; }
        .ppt-view::-webkit-scrollbar { width: 4px; }
        .ppt-view::-webkit-scrollbar-thumb { background: var(--ppt-line-2); border-radius: var(--ppt-r-sm); }

        .ppt-sec-label {
            display: flex;
            align-items: center;
            gap: 6px;
            margin: 0 0 8px;
            font-family: var(--ppt-mono);
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--ppt-text-3);
        }
        .ppt-sec-label::after {
            content: '';
            flex: 1;
            height: 1px;
            background: var(--ppt-line);
        }

        /* ---------- Metric row ---------- */
        .ppt-metric {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 8px;
            padding-bottom: 9px;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--ppt-line);
        }
        .ppt-metric-val {
            display: flex;
            align-items: baseline;
            gap: 6px;
            min-width: 0;
        }
        .ppt-metric-num {
            font-family: var(--ppt-mono);
            font-size: 20px;
            font-weight: 600;
            line-height: 1;
            letter-spacing: -0.02em;
            color: var(--ppt-text);
            font-variant-numeric: tabular-nums;
        }
        .ppt-metric-unit { font-size: 10px; color: var(--ppt-text-3); white-space: nowrap; }
        .ppt-metric-acts { display: flex; align-items: center; gap: 2px; flex: none; }
        .ppt-text-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 6px;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--ppt-r);
            color: var(--ppt-text-3);
            font-family: var(--ppt-sans);
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease);
        }
        .ppt-text-btn:hover { background: var(--ppt-surface-2); color: var(--ppt-text); }
        .ppt-text-btn:active { transform: scale(0.97); }
        .ppt-text-btn.danger:hover { background: rgba(248, 113, 113, 0.12); color: var(--ppt-danger); }

        /* ---------- Buttons ---------- */
        .ppt-btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .ppt-btn-grid + .ppt-btn-grid { margin-top: 6px; }
        .ppt-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            height: 30px;
            padding: 0 9px;
            background: var(--ppt-surface-2);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r);
            color: var(--ppt-text-2);
            font-family: var(--ppt-sans);
            font-size: 10.5px;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
            outline: none;
            transition: background 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease), transform 0.1s var(--ppt-ease);
        }
        .ppt-btn:hover:not(:disabled) { background: var(--ppt-surface-3); border-color: var(--ppt-line-2); color: var(--ppt-text); }
        .ppt-btn:active:not(:disabled) { transform: scale(0.98); }
        .ppt-btn:focus-visible { border-color: var(--ppt-accent); box-shadow: 0 0 0 2px var(--ppt-accent-soft); }
        .ppt-btn:disabled { opacity: 0.34; cursor: not-allowed; }
        .ppt-btn svg { width: 13px; height: 13px; stroke-width: 1.9; }

        .ppt-btn-primary {
            background: var(--ppt-accent-strong);
            border-color: var(--ppt-accent-strong);
            color: #fff;
        }
        .ppt-btn-primary:hover:not(:disabled) { background: #be123c; border-color: #be123c; color: #fff; }
        .ppt-btn-ok {
            background: var(--ppt-surface-2);
            border-color: rgba(52, 211, 153, 0.34);
            color: var(--ppt-ok);
        }
        .ppt-btn-ok:hover:not(:disabled) { background: var(--ppt-ok-soft); border-color: var(--ppt-ok); color: var(--ppt-ok); }
        .ppt-btn-wide { width: 100%; }
        .ppt-btn-row { display: flex; gap: 6px; }
        .ppt-btn-row .ppt-btn { flex: 1; }
        .ppt-btn-spaced { margin-top: 6px; }

        .ppt-toggle {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 100%;
            height: 30px;
            padding: 0 9px;
            background: var(--ppt-surface-2);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r);
            color: var(--ppt-text-2);
            font-family: var(--ppt-sans);
            font-size: 10.5px;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
            outline: none;
            transition: background 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease);
        }
        .ppt-toggle:hover:not(:disabled) { background: var(--ppt-surface-3); color: var(--ppt-text); }
        .ppt-toggle:active:not(:disabled) { transform: scale(0.98); }
        .ppt-toggle:focus-visible { border-color: var(--ppt-accent); box-shadow: 0 0 0 2px var(--ppt-accent-soft); }
        .ppt-toggle:disabled { opacity: 0.34; cursor: not-allowed; }
        .ppt-toggle.active {
            background: var(--ppt-accent-soft);
            border-color: var(--ppt-accent-line);
            color: var(--ppt-accent);
        }
        .ppt-toggle svg { width: 13px; height: 13px; stroke-width: 1.9; }
        .ppt-toggle-state {
            font-family: var(--ppt-mono);
            font-size: 9px;
            letter-spacing: 0.06em;
            padding: 1px 5px;
            border-radius: var(--ppt-r-xs);
            background: var(--ppt-surface-3);
            color: var(--ppt-text-3);
        }
        .ppt-toggle.active .ppt-toggle-state { background: rgba(244, 63, 94, 0.2); color: var(--ppt-accent); }

        .ppt-stop {
            display: none;
            align-items: center;
            justify-content: center;
            gap: 5px;
            width: 100%;
            height: 30px;
            margin-top: 6px;
            background: rgba(248, 113, 113, 0.1);
            border: 1px solid rgba(248, 113, 113, 0.32);
            border-radius: var(--ppt-r);
            color: var(--ppt-danger);
            font-family: var(--ppt-sans);
            font-size: 10.5px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease);
        }
        .ppt-stop:hover { background: rgba(248, 113, 113, 0.18); }
        .ppt-stop svg { width: 13px; height: 13px; }

        /* ---------- Inline switch ---------- */
        .ppt-switch-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 7px 0;
            border-bottom: 1px solid var(--ppt-line);
            margin-bottom: 10px;
        }
        .ppt-switch {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            cursor: pointer;
            color: var(--ppt-text-2);
            font-size: 10.5px;
            font-weight: 600;
        }
        .ppt-switch input { position: absolute; opacity: 0; pointer-events: none; }
        .ppt-switch-track {
            position: relative;
            width: 28px;
            height: 16px;
            flex: none;
            border-radius: var(--ppt-r-pill);
            background: var(--ppt-surface-3);
            border: 1px solid var(--ppt-line-2);
            transition: background 0.16s var(--ppt-ease), border-color 0.16s var(--ppt-ease);
        }
        .ppt-switch-track::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--ppt-text-3);
            transition: transform 0.16s var(--ppt-ease), background 0.16s var(--ppt-ease);
        }
        .ppt-switch input:checked + .ppt-switch-track { background: var(--ppt-accent-soft); border-color: var(--ppt-accent); }
        .ppt-switch input:checked + .ppt-switch-track::after { transform: translateX(12px); background: var(--ppt-accent); }
        .ppt-switch input:focus-visible + .ppt-switch-track { box-shadow: 0 0 0 2px var(--ppt-accent-soft); }
        .ppt-switch-meta {
            font-family: var(--ppt-mono);
            font-size: 9.5px;
            color: var(--ppt-text-3);
            font-variant-numeric: tabular-nums;
        }

        /* ---------- Section block ---------- */
        .ppt-block {
            padding-top: 10px;
            margin-top: 10px;
            border-top: 1px solid var(--ppt-line);
        }
        .ppt-block-hdr {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            margin-bottom: 8px;
        }
        .ppt-block-title {
            display: flex;
            align-items: center;
            gap: 5px;
            font-family: var(--ppt-mono);
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.07em;
            text-transform: uppercase;
            color: var(--ppt-text-3);
        }
        .ppt-block-title svg { width: 11px; height: 11px; }

        .ppt-acct {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-bottom: 8px;
            font-size: 10px;
            color: var(--ppt-text-3);
        }
        .ppt-acct-id {
            font-family: var(--ppt-mono);
            font-weight: 600;
            color: var(--ppt-text-2);
            font-variant-numeric: tabular-nums;
        }

        .ppt-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            max-height: 84px;
            overflow-y: auto;
            margin-bottom: 8px;
        }
        .ppt-chips::-webkit-scrollbar { width: 3px; }
        .ppt-chips::-webkit-scrollbar-thumb { background: var(--ppt-line-2); border-radius: var(--ppt-r-xs); }
        .ppt-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 7px;
            background: var(--ppt-surface-2);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r-pill);
            color: var(--ppt-text-2);
            font-size: 9.5px;
            white-space: nowrap;
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease);
        }
        .ppt-chip:hover { background: var(--ppt-surface-3); border-color: var(--ppt-line-2); color: var(--ppt-text); }
        .ppt-chip.active {
            background: var(--ppt-accent-soft);
            border-color: var(--ppt-accent-line);
            color: var(--ppt-accent);
        }
        .ppt-chip .cnt {
            font-family: var(--ppt-mono);
            font-size: 8.5px;
            color: var(--ppt-text-3);
            font-variant-numeric: tabular-nums;
        }
        .ppt-chip.active .cnt { color: var(--ppt-accent); }

        .ppt-input {
            width: 100%;
            height: 28px;
            padding: 0 8px;
            background: var(--ppt-surface);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r);
            color: var(--ppt-text);
            font-family: var(--ppt-sans);
            font-size: 10.5px;
            outline: none;
            transition: border-color 0.14s var(--ppt-ease), box-shadow 0.14s var(--ppt-ease);
        }
        .ppt-input::placeholder { color: var(--ppt-text-3); }
        .ppt-input:focus { border-color: var(--ppt-accent); box-shadow: 0 0 0 2px var(--ppt-accent-soft); }

        .ppt-row-between {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-top: 8px;
        }
        .ppt-check {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            color: var(--ppt-text-2);
            font-size: 10px;
            cursor: pointer;
        }
        .ppt-check input { width: 13px; height: 13px; accent-color: var(--ppt-accent); cursor: pointer; }
        .ppt-note {
            font-family: var(--ppt-mono);
            font-size: 9.5px;
            color: var(--ppt-text-3);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 140px;
            text-align: right;
        }
        .ppt-note.on { color: var(--ppt-accent); }

        /* ---------- Progress + status ---------- */
        .ppt-prog {
            display: none;
            height: 3px;
            margin: 9px 0 7px;
            border-radius: var(--ppt-r-xs);
            background: var(--ppt-surface-3);
            overflow: hidden;
        }
        .ppt-prog-bar {
            height: 100%;
            width: 100%;
            transform: scaleX(0);
            transform-origin: left center;
            background: var(--ppt-accent);
            border-radius: var(--ppt-r-xs);
            transition: transform 0.2s var(--ppt-ease);
        }
        .ppt-status {
            min-height: 15px;
            margin-top: 8px;
            font-size: 10px;
            color: var(--ppt-text-3);
            word-break: break-word;
        }
        .ppt-quota {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding-top: 8px;
            margin-top: 9px;
            border-top: 1px solid var(--ppt-line);
            font-family: var(--ppt-mono);
            font-size: 9.5px;
            color: var(--ppt-text-3);
            font-variant-numeric: tabular-nums;
        }
        .ppt-quota b { font-weight: 600; color: var(--ppt-text-2); }

        /* ---------- History ---------- */
        .ppt-hist {
            max-height: 244px;
            overflow-y: auto;
            margin: 0 -11px;
        }
        .ppt-hist::-webkit-scrollbar { width: 4px; }
        .ppt-hist::-webkit-scrollbar-thumb { background: var(--ppt-line-2); border-radius: var(--ppt-r-sm); }
        .ppt-hist-item {
            padding: 9px 11px;
            border-bottom: 1px solid var(--ppt-line);
            transition: background 0.14s var(--ppt-ease);
        }
        .ppt-hist-item:hover { background: var(--ppt-surface); }
        .ppt-hist-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 3px;
        }
        .ppt-hist-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--ppt-text);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ppt-hist-badge {
            flex: none;
            padding: 1px 5px;
            border-radius: var(--ppt-r-xs);
            background: var(--ppt-surface-3);
            font-family: var(--ppt-mono);
            font-size: 9px;
            font-weight: 600;
            color: var(--ppt-text-2);
            font-variant-numeric: tabular-nums;
        }
        .ppt-hist-time {
            font-family: var(--ppt-mono);
            font-size: 9px;
            color: var(--ppt-text-3);
        }
        .ppt-hist-acts { display: flex; gap: 4px; margin-top: 7px; }
        .ppt-hist-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 7px;
            background: var(--ppt-surface-2);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r);
            color: var(--ppt-text-2);
            font-family: var(--ppt-sans);
            font-size: 9.5px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.14s var(--ppt-ease), color 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease);
        }
        .ppt-hist-btn:hover { background: var(--ppt-surface-3); color: var(--ppt-text); border-color: var(--ppt-line-2); }
        .ppt-hist-btn.danger { margin-left: auto; padding: 3px 6px; }
        .ppt-hist-btn.danger:hover { background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.4); color: var(--ppt-danger); }

        .ppt-empty {
            padding: 26px 14px;
            text-align: center;
            color: var(--ppt-text-3);
        }
        .ppt-empty svg { width: 22px; height: 22px; margin-bottom: 8px; color: var(--ppt-line-2); stroke-width: 1.5; }
        .ppt-empty-t { font-size: 10.5px; color: var(--ppt-text-2); margin-bottom: 3px; }
        .ppt-empty-s { font-size: 9.5px; }

        /* ---------- Settings rows ---------- */
        .ppt-set {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            min-height: 30px;
            padding: 3px 0;
            border-bottom: 1px solid var(--ppt-line);
        }
        .ppt-set:last-of-type { border-bottom: none; }
        .ppt-set-label { font-size: 10.5px; color: var(--ppt-text-2); }
        .ppt-set-input {
            width: 62px;
            height: 24px;
            padding: 0 7px;
            background: var(--ppt-surface);
            border: 1px solid var(--ppt-line);
            border-radius: var(--ppt-r-sm);
            color: var(--ppt-text);
            font-family: var(--ppt-mono);
            font-size: 10.5px;
            text-align: right;
            outline: none;
            font-variant-numeric: tabular-nums;
            transition: border-color 0.14s var(--ppt-ease), box-shadow 0.14s var(--ppt-ease);
        }
        .ppt-set-input:focus { border-color: var(--ppt-accent); box-shadow: 0 0 0 2px var(--ppt-accent-soft); }
        .ppt-set-check { width: 14px; height: 14px; accent-color: var(--ppt-accent); cursor: pointer; }

        /* ---------- Thumbnail overlays ---------- */
        .ppt-art-link { position: relative !important; }
        .ppt-chk, .ppt-dl {
            position: absolute;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 1.5px solid rgba(255, 255, 255, 0.72);
            background: rgba(10, 10, 12, 0.72);
            backdrop-filter: blur(3px);
            -webkit-backdrop-filter: blur(3px);
            color: #fff;
            cursor: pointer;
            z-index: 999;
            display: none;
            align-items: center;
            justify-content: center;
            transition: background 0.14s var(--ppt-ease), border-color 0.14s var(--ppt-ease), transform 0.12s var(--ppt-ease);
            box-sizing: border-box;
        }
        .ppt-chk { top: 6px; left: 6px; }
        .ppt-dl { top: 6px; right: 6px; font-size: 11px; line-height: 1; }
        .ppt-chk::after {
            content: '';
            width: 9px;
            height: 9px;
            border-radius: 50%;
            background: transparent;
            transition: background 0.14s var(--ppt-ease);
        }
        .ppt-chk.ppt-chk-on { display: flex; background: var(--ppt-accent); border-color: var(--ppt-accent); }
        .ppt-chk.ppt-chk-on::after { background: #f7f7f8; }
        .ppt-dl:hover { background: #059669; border-color: var(--ppt-ok); transform: scale(1.08); }
        .ppt-art-link:hover .ppt-chk, .ppt-art-link:hover .ppt-dl, body.ppt-selecting-mode .ppt-chk { display: flex; }
        .ppt-dl.busy { background: #059669; border-color: var(--ppt-ok); animation: ppt-pulse 1s ease-in-out infinite; }
        @keyframes ppt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        a.ppt-art-selected { outline: 2px solid var(--ppt-accent) !important; outline-offset: -2px; border-radius: var(--ppt-r); }
        a.ppt-art-done { outline: 2px solid var(--ppt-ok) !important; outline-offset: -2px; border-radius: var(--ppt-r); }

        .ppt-bm {
            position: absolute;
            bottom: 6px;
            left: 6px;
            padding: 1px 6px;
            border-radius: var(--ppt-r-pill);
            background: rgba(10, 10, 12, 0.82);
            backdrop-filter: blur(3px);
            -webkit-backdrop-filter: blur(3px);
            color: #fb7185;
            font-family: var(--ppt-mono);
            font-size: 9.5px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
            z-index: 999;
            pointer-events: none;
        }

        /* ---------- Hover preview ---------- */
        #ppt-hover-preview {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 999998;
            pointer-events: none;
            display: none;
            flex-direction: column;
            align-items: center;
            width: fit-content;
            max-width: 75vw;
            max-height: 85vh;
            border-radius: var(--ppt-r-lg);
            background: var(--ppt-bg);
            border: 1px solid var(--ppt-line);
            box-shadow: 0 24px 70px rgba(0, 0, 0, 0.85);
            overflow: hidden;
        }
        #ppt-hover-preview.show { display: inline-flex; }
        #ppt-hover-bar {
            width: 0;
            min-width: 100%;
            max-width: 100%;
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 7px 12px;
            background: var(--ppt-surface);
            border-bottom: 1px solid var(--ppt-line);
            font-family: var(--ppt-mono);
            font-size: 10.5px;
            color: var(--ppt-text-2);
            white-space: nowrap;
            overflow: hidden;
            font-variant-numeric: tabular-nums;
        }
        #ppt-hover-bar .hb-bm { display: inline-flex; align-items: center; gap: 4px; color: var(--ppt-accent); font-weight: 600; flex: none; }
        #ppt-hover-bar .hb-bm svg { width: 11px; height: 11px; }
        #ppt-hover-bar .hb-dim { color: var(--ppt-ok); flex: none; }
        #ppt-hover-bar .hb-pages { color: var(--ppt-text); font-weight: 600; flex: none; }
        #ppt-hover-bar .hb-date { color: var(--ppt-text-3); flex: none; }
        #ppt-hover-bar .hb-author { color: var(--ppt-text); font-family: var(--ppt-sans); font-weight: 600; flex: none; }
        #ppt-hover-bar .hb-tags { color: var(--ppt-text-3); font-family: var(--ppt-sans); overflow: hidden; text-overflow: ellipsis; flex: 1; }
        #ppt-hover-img-wrap { display: flex; align-items: center; justify-content: center; position: relative; width: fit-content; }
        #ppt-hover-img {
            max-width: 75vw;
            max-height: calc(85vh - 34px);
            object-fit: contain;
            display: block;
            width: auto;
            height: auto;
            transition: opacity 0.15s var(--ppt-ease);
        }
        #ppt-hover-pagenum {
            display: none;
            position: absolute;
            bottom: 10px;
            right: 10px;
            padding: 2px 9px;
            border-radius: var(--ppt-r-pill);
            background: rgba(10, 10, 12, 0.82);
            backdrop-filter: blur(3px);
            -webkit-backdrop-filter: blur(3px);
            color: #fff;
            font-family: var(--ppt-mono);
            font-size: 11px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            z-index: 2;
            pointer-events: none;
        }
        #ppt-hover-preview.multipage #ppt-hover-pagenum { display: block; }
        #ppt-hover-hint {
            display: none;
            position: absolute;
            bottom: 44px;
            left: 50%;
            transform: translateX(-50%);
            padding: 3px 11px;
            border-radius: var(--ppt-r-pill);
            background: rgba(10, 10, 12, 0.76);
            backdrop-filter: blur(3px);
            -webkit-backdrop-filter: blur(3px);
            color: var(--ppt-text-2);
            font-size: 9.5px;
            z-index: 2;
            pointer-events: none;
            transition: opacity 0.7s var(--ppt-ease);
        }
        #ppt-hover-preview.multipage #ppt-hover-hint { display: block; }

        /* ---------- Infinite scroll ---------- */
        #ppt-inf-loader {
            display: none;
            width: 100%;
            padding: 26px 0;
            text-align: center;
            font-family: var(--ppt-mono);
            font-size: 11px;
            color: var(--ppt-text-3);
        }
        #ppt-inf-loader.show { display: block; }
        .ppt-inf-page-num { color: var(--ppt-text-2); font-weight: 600; }
        #ppt-inf-loader .ppt-spinner {
            display: inline-block;
            width: 13px;
            height: 13px;
            margin-right: 7px;
            vertical-align: -2px;
            border: 1.5px solid var(--ppt-line-2);
            border-top-color: var(--ppt-accent);
            border-radius: 50%;
            animation: ppt-spin 0.7s linear infinite;
        }
        @keyframes ppt-spin { to { transform: rotate(360deg); } }
        #ppt-inf-end {
            display: none;
            width: 100%;
            padding: 22px 0;
            text-align: center;
            font-family: var(--ppt-mono);
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--ppt-text-3);
        }
        #ppt-inf-end.show { display: block; }

        @media (prefers-reduced-motion: reduce) {
            #ppt-panel *, #ppt-hover-preview *, #ppt-inf-loader * {
                animation-duration: 0.001ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.001ms !important;
            }
        }
    `;
    document.head.appendChild(styleEl);

    const panel = document.createElement('div');
    panel.id = 'ppt-panel';
    panel.innerHTML = `
        <div class="ppt-hdr">
            <div class="ppt-brand">
                <span class="ppt-brand-mark">${svg('flame')}</span>
                <span class="ppt-brand-name">Pixiv Power Tools</span>
            </div>
            <div class="ppt-hdr-actions">
                <button class="ppt-icon-btn" id="btn-minimize" title="Collapse panel" aria-label="Collapse panel">${svg('minus', 'ppt-i-sm')}</button>
            </div>
        </div>

        <div class="ppt-tabs" role="tablist">
            <button class="ppt-tab active" id="tab-main" role="tab" aria-selected="true">${svg('pointer', 'ppt-i-sm')}Select</button>
            <button class="ppt-tab" id="tab-history" role="tab" aria-selected="false">${svg('history', 'ppt-i-sm')}History</button>
            <button class="ppt-tab" id="tab-settings" role="tab" aria-selected="false">${svg('settings', 'ppt-i-sm')}Settings</button>
        </div>

        <div class="ppt-view ppt-view-active" id="view-main">
            <div class="ppt-metric">
                <div class="ppt-metric-val">
                    <span class="ppt-metric-num" id="stat-count">0</span>
                    <span class="ppt-metric-unit">selected</span>
                </div>
                <div class="ppt-metric-acts">
                    <button class="ppt-text-btn" id="btn-quick-snapshot" title="Save selection to history">${svg('deviceFloppy', 'ppt-i-sm')}Snapshot</button>
                    <button class="ppt-text-btn danger" id="btn-clear-all" title="Clear active selection">${svg('trash', 'ppt-i-sm')}Clear</button>
                </div>
            </div>

            <button class="ppt-toggle" id="btn-sel-mode" aria-pressed="false">
                ${svg('pointer')}<span>Click to Select</span><span class="ppt-toggle-state">OFF</span>
            </button>

            <div class="ppt-btn-grid ppt-btn-spaced">
                <button class="ppt-btn" id="btn-sel-visible">${svg('check')}Select Visible</button>
                <button class="ppt-btn" id="btn-clr-visible">${svg('squareX')}Clear Visible</button>
            </div>

            <div class="ppt-switch-row">
                <label class="ppt-switch">
                    <input type="checkbox" id="ppt-inf-toggle" ${config.infiniteScroll ? 'checked' : ''}>
                    <span class="ppt-switch-track"></span>
                    <span>Infinite Scroll</span>
                </label>
                <span class="ppt-switch-meta" id="ppt-inf-status">${infChipText()}</span>
            </div>

            <div class="ppt-block" style="border-top:none;padding-top:0;margin-top:0">
                <div class="ppt-block-hdr">
                    <span class="ppt-block-title">${svg('tag')}Auto-tag on like</span>
                    <button class="ppt-icon-btn" id="btn-reload-tags" title="Reload account tags" aria-label="Reload account tags">${svg('refresh', 'ppt-i-sm')}</button>
                </div>
                <div class="ppt-acct">
                    <span>Account</span>
                    <span class="ppt-acct-id" id="ppt-acct-name">Loading…</span>
                </div>
                <div class="ppt-chips" id="ppt-chips-container">
                    <span class="ppt-empty-s" style="color:var(--ppt-text-3)">Fetching tags…</span>
                </div>
                <input type="text" id="ppt-custom-tags" class="ppt-input" placeholder="Add custom tags, comma separated" spellcheck="false" aria-label="Custom bookmark tags">
                <div class="ppt-row-between">
                    <label class="ppt-check"><input type="checkbox" id="ppt-dest-private">Private</label>
                    <span class="ppt-note" id="ppt-tag-status">No tags selected</span>
                </div>
            </div>

            <div class="ppt-block">
                <div class="ppt-btn-grid">
                    <button class="ppt-btn ppt-btn-primary" id="btn-like">${svg('heart')}Like</button>
                    <button class="ppt-btn ppt-btn-ok" id="btn-like-bm">${svg('bookmark')}Like + Bookmark</button>
                </div>
                <button class="ppt-stop" id="btn-stop-op">${svg('handStop')}Stop</button>

                <div class="ppt-prog" id="ppt-prog-wrap"><div class="ppt-prog-bar" id="ppt-prog-bar"></div></div>
                <div class="ppt-status" id="ppt-status">Ready</div>

                <div class="ppt-quota">
                    <span>Today <b id="val-daily">0</b> / <b id="val-daily-max">${config.dailyLimit}</b></span>
                    <span>Resets in <b id="val-reset">--</b></span>
                </div>
            </div>

            <div class="ppt-block">
                <div class="ppt-block-hdr">
                    <span class="ppt-block-title">${svg('arrowsSort')}Ranking</span>
                </div>
                <button class="ppt-toggle" id="btn-sort-likes" aria-pressed="false">
                    ${svg('flame')}<span>Sort by Likes</span><span class="ppt-toggle-state">OFF</span>
                </button>
                <button class="ppt-btn ppt-btn-wide ppt-btn-spaced" id="btn-sort-restore">${svg('restore')}Restore Original Order</button>
                <button class="ppt-btn ppt-btn-wide ppt-btn-spaced" id="btn-dl-selected">${svg('download')}Download Selected</button>
            </div>

            <div class="ppt-btn-grid" style="margin-top:10px">
                <button class="ppt-btn" id="btn-export">${svg('clipboard')}Export</button>
                <button class="ppt-btn" id="btn-import">${svg('upload')}Import</button>
            </div>
        </div>

        <div class="ppt-view" id="view-history">
            <div class="ppt-block-hdr">
                <span class="ppt-block-title">${svg('history')}Snapshots</span>
                <button class="ppt-text-btn" id="btn-new-snapshot">${svg('plus', 'ppt-i-sm')}Save Current</button>
            </div>
            <div class="ppt-hist" id="history-container"></div>
            <div class="ppt-btn-grid" style="margin-top:10px">
                <button class="ppt-btn" id="btn-hist-back">${svg('arrowBack')}Back</button>
                <button class="ppt-btn" id="btn-hist-clear">${svg('trash')}Clear All</button>
            </div>
        </div>

        <div class="ppt-view" id="view-settings">
            <div class="ppt-block" style="border-top:none;padding-top:0;margin-top:0">
                <div class="ppt-block-hdr"><span class="ppt-block-title">${svg('eye')}Browsing</span></div>
                <div class="ppt-set"><span class="ppt-set-label">Hover preview</span><input type="checkbox" class="ppt-set-check" id="s-hover" ${config.hoverPreview ? 'checked' : ''}></div>
                <div class="ppt-set"><span class="ppt-set-label">Hover delay (ms)</span><input type="number" class="ppt-set-input" id="s-hdelay" value="${config.hoverDelay || 200}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Infinite scroll default</span><input type="checkbox" class="ppt-set-check" id="s-infscroll" ${config.infiniteScroll ? 'checked' : ''}></div>
                <div class="ppt-set"><span class="ppt-set-label">Extra pages to load</span><input type="number" class="ppt-set-input" id="s-scrollpages" min="1" max="1000" value="${config.scrollPageLimit || 10}"></div>
            </div>

            <div class="ppt-block">
                <div class="ppt-block-hdr"><span class="ppt-block-title">${svg('arrowsSort')}Ranking</span></div>
                <div class="ppt-set"><span class="ppt-set-label">Show like counts</span><input type="checkbox" class="ppt-set-check" id="s-sortbadges" ${config.showLikeBadges ? 'checked' : ''}></div>
                <div class="ppt-set"><span class="ppt-set-label">Re-rank new pages</span><input type="checkbox" class="ppt-set-check" id="s-livesort" ${config.liveSort ? 'checked' : ''}></div>
                <div class="ppt-set"><span class="ppt-set-label">Download concurrency</span><input type="number" class="ppt-set-input" id="s-dlconc" value="${config.dlConcurrency || 2}"></div>
            </div>

            <div class="ppt-block">
                <div class="ppt-block-hdr"><span class="ppt-block-title">${svg('handStop')}Rate limits</span></div>
                <div class="ppt-set"><span class="ppt-set-label">Min delay (ms)</span><input type="number" class="ppt-set-input" id="s-dmin" value="${config.delayMin}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Max delay (ms)</span><input type="number" class="ppt-set-input" id="s-dmax" value="${config.delayMax}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Batch size</span><input type="number" class="ppt-set-input" id="s-batch" value="${config.batchSize}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Batch pause (s)</span><input type="number" class="ppt-set-input" id="s-pause" value="${Math.round(config.batchPause / 1000)}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Daily quota</span><input type="number" class="ppt-set-input" id="s-daily" value="${config.dailyLimit}"></div>
                <div class="ppt-set"><span class="ppt-set-label">Max history</span><input type="number" class="ppt-set-input" id="s-hist" value="${config.maxHistory || 30}"></div>
            </div>

            <div class="ppt-btn-grid" style="margin-top:10px">
                <button class="ppt-btn ppt-btn-primary" id="btn-save-cfg">${svg('check')}Save</button>
                <button class="ppt-btn" id="btn-reset-cfg">${svg('refresh')}Reset</button>
            </div>
        </div>

        <div class="ppt-resize ppt-resize-e" data-dir="e"></div>
        <div class="ppt-resize ppt-resize-w" data-dir="w"></div>
        <div class="ppt-resize ppt-resize-s" data-dir="s"></div>
        <div class="ppt-resize ppt-resize-se" data-dir="se"></div>
        <div class="ppt-resize ppt-resize-sw" data-dir="sw"></div>
        <div class="ppt-resize-grip"></div>
    `;
    document.body.appendChild(panel);

    const savedPos = GM_getValue(STORAGE_KEYS.pos, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
        panel.style.left = `${Math.min(window.innerWidth - 60, Math.max(0, savedPos.left))}px`;
        panel.style.top = `${Math.min(window.innerHeight - 40, Math.max(0, savedPos.top))}px`;
        panel.style.right = 'auto';
    }

    const MIN_W = 220;
    const MIN_H = 200;
    const maxW = () => Math.min(560, window.innerWidth - 20);
    const maxH = () => Math.max(MIN_H, window.innerHeight - 20);

    function clampSize(w, h) {
        return {
            w: Math.max(MIN_W, Math.min(maxW(), Math.round(w))),
            h: Math.max(MIN_H, Math.min(maxH(), Math.round(h))),
        };
    }

    function applyPanelSize(w, h) {
        const c = clampSize(w, h);
        panel.style.width = `${c.w}px`;
        panel.style.height = `${c.h}px`;
        panel.style.maxHeight = 'none';
        return c;
    }

    const savedSize = GM_getValue(STORAGE_KEYS.size, null);
    if (savedSize && typeof savedSize.w === 'number' && typeof savedSize.h === 'number') {
        applyPanelSize(savedSize.w, savedSize.h);
    }

    let isResizing = false;
    let resizeDir = '';
    let resizeStart = null;
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    panel.querySelectorAll('.ppt-resize').forEach(handle => {
        handle.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = panel.getBoundingClientRect();
            const cs = getComputedStyle(panel);

            isResizing = true;
            resizeDir = handle.dataset.dir || 'se';
            resizeStart = {
                x: e.clientX,
                y: e.clientY,
                w: rect.width,
                h: rect.height,
                left: rect.left,
                top: rect.top,
                anchorRight: window.innerWidth - rect.right,
                right: cs.right,
                leftCss: cs.left,
            };

            panel.style.maxHeight = 'none';
            if (cs.right !== 'auto') {
                panel.style.right = `${resizeStart.anchorRight}px`;
                panel.style.left = 'auto';
            }
            document.body.classList.add('ppt-resizing');
        });
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing || !resizeStart) return;
        const dx = e.clientX - resizeStart.x;
        const dy = e.clientY - resizeStart.y;
        const s = resizeStart;

        let w = s.w;
        let h = s.h;

        if (resizeDir.includes('e')) w = s.w + dx;
        if (resizeDir.includes('w')) w = s.w - dx;
        if (resizeDir.includes('s')) h = s.h + dy;

        const c = clampSize(w, h);

        panel.style.width = `${c.w}px`;
        if (resizeDir.includes('s')) panel.style.height = `${c.h}px`;

        if (resizeDir.includes('w')) {
            const newLeft = s.left + (s.w - c.w);
            panel.style.left = `${Math.max(0, newLeft)}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeStart = null;
            resizeDir = '';
            document.body.classList.remove('ppt-resizing');
            GM_setValue(STORAGE_KEYS.size, { w: panel.offsetWidth, h: panel.offsetHeight });
            return;
        }
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = '';
        GM_setValue(STORAGE_KEYS.pos, { left: panel.offsetLeft, top: panel.offsetTop });
    });

    window.addEventListener('resize', () => {
        const rect = panel.getBoundingClientRect();
        if (rect.width > maxW() || rect.height > maxH()) {
            const c = applyPanelSize(rect.width, rect.height);
            GM_setValue(STORAGE_KEYS.size, { w: c.w, h: c.h });
        }
        if (rect.right > window.innerWidth) {
            panel.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
            panel.style.right = 'auto';
        }
    });

    const panelHeader = panel.querySelector('.ppt-hdr');
    panelHeader.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        let nx = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - panel.offsetWidth));
        let ny = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - panel.offsetHeight));
        panel.style.left = `${nx}px`;
        panel.style.top = `${ny}px`;
        panel.style.right = 'auto';
    });

    function switchView(viewName) {
        document.querySelectorAll('.ppt-view').forEach(el => el.classList.remove('ppt-view-active'));
        document.querySelectorAll('.ppt-tab').forEach(btn => {
            const on = btn.id === `tab-${viewName}`;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });

        const targetView = document.getElementById(`view-${viewName}`);
        if (targetView) targetView.classList.add('ppt-view-active');

        if (viewName === 'history') {
            renderHistoryUI();
        }
    }

    document.getElementById('tab-main').addEventListener('click', () => switchView('main'));
    document.getElementById('tab-history').addEventListener('click', () => switchView('history'));
    document.getElementById('tab-settings').addEventListener('click', () => switchView('settings'));
    document.getElementById('btn-hist-back').addEventListener('click', () => switchView('main'));

    const minimizeBtn = document.getElementById('btn-minimize');
    minimizeBtn.addEventListener('click', () => {
        panel.classList.toggle('minimized');
        const isMin = panel.classList.contains('minimized');
        minimizeBtn.innerHTML = svg(isMin ? 'plus' : 'minus', 'ppt-i-sm');
        minimizeBtn.title = isMin ? 'Expand panel' : 'Collapse panel';
        minimizeBtn.setAttribute('aria-label', minimizeBtn.title);
    });

    function setStatus(msg, color = '#64748b') {
        const el = document.getElementById('ppt-status');
        if (el) {
            el.textContent = msg;
            el.style.color = color;
        }
    }

    function setProgress(pct) {
        const wrap = document.getElementById('ppt-prog-wrap');
        const bar = document.getElementById('ppt-prog-bar');
        if (wrap && bar) {
            wrap.style.display = pct >= 0 && pct <= 100 ? 'block' : 'none';
            const ratio = Math.max(0, Math.min(100, pct)) / 100;
            bar.style.transform = `scaleX(${ratio})`;
        }
    }

    function updateUI() {
        const count = selected.size;
        const countEl = document.getElementById('stat-count');
        if (countEl) countEl.textContent = count;

        const dailyCount = getDailyCount();
        const dailyValEl = document.getElementById('val-daily');
        if (dailyValEl) dailyValEl.textContent = dailyCount;

        const dailyMaxEl = document.getElementById('val-daily-max');
        if (dailyMaxEl) dailyMaxEl.textContent = config.dailyLimit;

        const resetValEl = document.getElementById('val-reset');
        if (resetValEl) resetValEl.textContent = getTimeUntilMidnight();

        const btnLike = document.getElementById('btn-like');
        const btnLikeBm = document.getElementById('btn-like-bm');
        const btnSort = document.getElementById('btn-sort-likes');
        const btnSortRestore = document.getElementById('btn-sort-restore');
        const btnDlSelected = document.getElementById('btn-dl-selected');
        const limitReached = dailyCount >= config.dailyLimit;

        if (btnLike) btnLike.disabled = count === 0 || limitReached || isRunning;
        if (btnLikeBm) btnLikeBm.disabled = count === 0 || limitReached || isRunning;
        if (btnSort) btnSort.disabled = isRunning;
        if (btnSortRestore) btnSortRestore.disabled = isRunning || _allPagesRunning;
        if (btnDlSelected) {
            btnDlSelected.disabled = count === 0 || isRunning;
            btnDlSelected.innerHTML = `${svg('download')}${count === 0 ? 'Download Selected' : `Download Selected (${count})`}`;
        }
    }

    function setOperationRunningUI(running) {
        const stopBtn = document.getElementById('btn-stop-op');
        const progWrap = document.getElementById('ppt-prog-wrap');
        const visible = running || _allPagesRunning;
        if (stopBtn) stopBtn.style.display = visible ? 'flex' : 'none';
        if (progWrap && running) progWrap.style.display = 'block';
        updateUI();
    }

    const savedTagState = GM_getValue(STORAGE_KEYS.tagSelection, { chips: [], custom: '', isPrivate: false });
    const selectedTagChips = new Set(savedTagState.chips || []);

    function getActiveBookmarkTags() {
        const tags = [...selectedTagChips];
        const customEl = document.getElementById('ppt-custom-tags');
        if (customEl && customEl.value.trim()) {
            customEl.value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean).forEach(t => {
                if (!tags.includes(t)) tags.push(t);
            });
        }
        return tags;
    }

    function getIsPrivateBookmark() {
        const chk = document.getElementById('ppt-dest-private');
        return chk ? chk.checked : false;
    }

    function updateTagStatusUI() {
        const statusEl = document.getElementById('ppt-tag-status');
        const customEl = document.getElementById('ppt-custom-tags');
        const privateChk = document.getElementById('ppt-dest-private');
        const active = getActiveBookmarkTags();

        if (statusEl) {
            if (active.length === 0) {
                statusEl.textContent = 'No tags selected';
                statusEl.style.color = '#64748b';
            } else {
                statusEl.textContent = active.map(t => `#${t}`).join(' ');
                statusEl.style.color = '#a78bfa';
            }
        }

        GM_setValue(STORAGE_KEYS.tagSelection, {
            chips: [...selectedTagChips],
            custom: customEl ? customEl.value : '',
            isPrivate: privateChk ? privateChk.checked : false
        });
    }

    function renderTagChips(tagsList) {
        const container = document.getElementById('ppt-chips-container');
        if (!container) return;
        container.innerHTML = '';

        if (!tagsList || tagsList.length === 0) {
            container.innerHTML = '<span style="color:#64748b;font-size:9.5px">No bookmark tags found</span>';
            return;
        }

        tagsList.forEach(item => {
            const chip = document.createElement('span');
            chip.className = 'ppt-chip' + (selectedTagChips.has(item.tag) ? ' active' : '');
            chip.innerHTML = `#${escHtml(item.tag)}<span class="cnt">${item.cnt}</span>`;
            chip.addEventListener('click', () => {
                if (selectedTagChips.has(item.tag)) {
                    selectedTagChips.delete(item.tag);
                    chip.classList.remove('active');
                } else {
                    selectedTagChips.add(item.tag);
                    chip.classList.add('active');
                }
                updateTagStatusUI();
            });
            container.appendChild(chip);
        });
    }

    function updateAccountUI(acc) {
        const acctEl = document.getElementById('ppt-acct-name');
        if (acctEl) {
            if (acc?.id) {
                acctEl.textContent = acc.name ? `${acc.name} (ID: ${acc.id})` : `ID: ${acc.id}`;
            } else {
                acctEl.textContent = '(click ↻ to load)';
            }
        }
    }

    async function reloadAccountAndTags(isManual = false) {
        const acctEl = document.getElementById('ppt-acct-name');
        const container = document.getElementById('ppt-chips-container');
        if (acctEl) acctEl.textContent = 'Fetching…';
        if (container) container.innerHTML = '<span style="color:#fbbf24;font-size:9.5px">Scanning tags…</span>';

        if (isManual) {
            cachedAccount = null;
            GM_setValue(STORAGE_KEYS.account, null);
        }

        const acc = await fetchMyUserDataAsync();
        updateAccountUI(acc);

        if (!acc?.id) {
            if (container) container.innerHTML = '<span style="color:#f87171;font-size:9.5px">Could not detect user ID</span>';
            return;
        }

        const tags = await fetchMyBookmarkTags(acc.id);
        renderTagChips(tags);
        updateTagStatusUI();

        if (isManual) {
            setStatus(tags.length > 0 ? `Loaded ${tags.length} bookmark tags.` : 'No bookmark tags found on account.', '#10b981');
        }
    }

    function renderHistoryUI() {
        const container = document.getElementById('history-container');
        if (!container) return;

        const list = getHistoryList();
        container.innerHTML = '';

        if (list.length === 0) {
            container.innerHTML = `
                <div class="ppt-empty">
                    ${svg('history')}
                    <div class="ppt-empty-t">No snapshots yet</div>
                    <div class="ppt-empty-s">Save your current selection to keep it around.</div>
                </div>
            `;
            return;
        }

        list.forEach(item => {
            const row = document.createElement('div');
            row.className = 'ppt-hist-item';
            row.innerHTML = `
                <div class="ppt-hist-top">
                    <span class="ppt-hist-title" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
                    <span class="ppt-hist-badge">${item.count}</span>
                </div>
                <div class="ppt-hist-time">${formatRelativeTime(item.updatedAt || item.createdAt)}</div>
                <div class="ppt-hist-acts">
                    <button class="ppt-hist-btn" data-act="restore">${svg('restore', 'ppt-i-sm')}Restore</button>
                    <button class="ppt-hist-btn" data-act="merge">${svg('plus', 'ppt-i-sm')}Merge</button>
                    <button class="ppt-hist-btn" data-act="rename">${svg('pencil', 'ppt-i-sm')}Rename</button>
                    <button class="ppt-hist-btn danger" data-act="delete" title="Delete snapshot" aria-label="Delete snapshot">${svg('trash', 'ppt-i-sm')}</button>
                </div>
            `;

            row.querySelector('[data-act="restore"]').addEventListener('click', () => {
                if (selected.size > 0 && !confirm(`Replace current selection (${selected.size}) with snapshot "${item.name}" (${item.count})?`)) {
                    return;
                }
                restoreSnapshot(item.id, 'replace');
                switchView('main');
                setStatus(`Restored "${item.name}" (${item.count} artworks).`, '#10b981');
            });

            row.querySelector('[data-act="merge"]').addEventListener('click', () => {
                restoreSnapshot(item.id, 'merge');
                switchView('main');
                setStatus(`Merged "${item.name}" into current selection.`, '#10b981');
            });

            row.querySelector('[data-act="rename"]').addEventListener('click', () => {
                const name = prompt('Rename snapshot:', item.name);
                if (name && name.trim()) {
                    renameSnapshot(item.id, name.trim());
                    renderHistoryUI();
                }
            });

            row.querySelector('[data-act="delete"]').addEventListener('click', () => {
                if (confirm(`Delete snapshot "${item.name}"?`)) {
                    deleteSnapshot(item.id);
                    renderHistoryUI();
                }
            });

            container.appendChild(row);
        });
    }

    const btnSelMode = document.getElementById('btn-sel-mode');
    btnSelMode.addEventListener('click', () => {
        selectMode = !selectMode;
        btnSelMode.classList.toggle('active', selectMode);
        btnSelMode.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
        const state = btnSelMode.querySelector('.ppt-toggle-state');
        if (state) state.textContent = selectMode ? 'ON' : 'OFF';
        document.body.classList.toggle('ppt-selecting-mode', selectMode);
        injectCheckboxes();
    });

    document.getElementById('btn-sel-visible').addEventListener('click', selectAllVisible);
    document.getElementById('btn-clr-visible').addEventListener('click', clearVisible);
    document.getElementById('btn-clear-all').addEventListener('click', clearAllSelection);
    document.getElementById('btn-export').addEventListener('click', exportSelection);
    document.getElementById('btn-import').addEventListener('click', importSelection);

    document.getElementById('btn-sort-likes').addEventListener('click', () => toggleSortMode());
    document.getElementById('btn-sort-restore').addEventListener('click', () => {
        if (sortMode) toggleSortMode(false);
        else restoreOriginalOrder();
    });
    document.getElementById('btn-dl-selected').addEventListener('click', runBulkDownload);

    const triggerSnapshotPrompt = () => {
        if (selected.size === 0) {
            setStatus('Select artworks before saving snapshot.', '#f59e0b');
            return;
        }
        const name = prompt(`Enter snapshot name (${selected.size} artworks):`, `Selection ${new Date().toLocaleDateString()}`);
        if (name !== null) {
            const snap = createSnapshot(name.trim() || undefined);
            if (snap) {
                setStatus(`Saved snapshot "${snap.name}" (${snap.count}).`, '#10b981');
                if (document.getElementById('view-history').classList.contains('ppt-view-active')) {
                    renderHistoryUI();
                }
            }
        }
    };

    document.getElementById('btn-quick-snapshot').addEventListener('click', triggerSnapshotPrompt);
    document.getElementById('btn-new-snapshot').addEventListener('click', triggerSnapshotPrompt);

    document.getElementById('btn-hist-clear').addEventListener('click', () => {
        if (confirm('Delete all saved snapshots in history?')) {
            saveHistoryList([]);
            renderHistoryUI();
            setStatus('History cleared.', '#94a3b8');
        }
    });

    const infToggleEl = document.getElementById('ppt-inf-toggle');
    if (infToggleEl) {
        infToggleEl.addEventListener('change', e => {
            if (e.target.checked) enableInfiniteScroll();
            else disableInfiniteScroll();
        });
    }

    const customTagsEl = document.getElementById('ppt-custom-tags');
    if (customTagsEl) {
        customTagsEl.value = savedTagState.custom || '';
        customTagsEl.addEventListener('input', updateTagStatusUI);
    }

    const privateChkEl = document.getElementById('ppt-dest-private');
    if (privateChkEl) {
        privateChkEl.checked = !!savedTagState.isPrivate;
        privateChkEl.addEventListener('change', updateTagStatusUI);
    }

    document.getElementById('btn-reload-tags').addEventListener('click', () => {
        reloadAccountAndTags(true);
    });

    document.getElementById('btn-like').addEventListener('click', () => runBulkOperation('like'));
    document.getElementById('btn-like-bm').addEventListener('click', () => runBulkOperation('like_and_bookmark'));
    document.getElementById('btn-stop-op').addEventListener('click', () => {
        stopRequested = true;
        dlStopRequested = true;
        if (stopLoadingAllPages()) {
            setStatus('Stopping page loading…', '#f59e0b');
            return;
        }
        setStatus('Stopping…', '#f59e0b');
    });

    document.getElementById('btn-save-cfg').addEventListener('click', () => {
        const g = id => parseInt(document.getElementById(id).value, 10) || 0;
        config.hoverPreview = document.getElementById('s-hover').checked;
        config.hoverDelay = Math.max(50, g('s-hdelay'));
        config.infiniteScroll = document.getElementById('s-infscroll').checked;
        config.delayMin = Math.max(50, g('s-dmin'));
        config.delayMax = Math.max(config.delayMin, g('s-dmax'));
        config.batchSize = Math.max(1, g('s-batch'));
        config.batchPause = Math.max(1, g('s-pause')) * 1000;
        config.dailyLimit = Math.max(1, g('s-daily'));
        config.maxHistory = Math.max(5, g('s-hist'));
        config.showLikeBadges = document.getElementById('s-sortbadges').checked;
        config.liveSort = document.getElementById('s-livesort').checked;
        config.scrollPageLimit = Math.max(1, Math.min(1000, g('s-scrollpages')));
        config.dlConcurrency = Math.max(1, Math.min(4, g('s-dlconc')));
        saveConfig(config);

        if (config.infiniteScroll) enableInfiniteScroll();
        else disableInfiniteScroll({ navigate: false });

        if (!config.showLikeBadges) clearLikeBadges();
        else if (sortMode) paintLikeBadges();

        updateUI();
        switchView('main');
        setStatus('Settings saved.', '#10b981');
    });

    document.getElementById('btn-reset-cfg').addEventListener('click', () => {
        saveConfig(DEFAULT_CONFIG);
        document.getElementById('s-hover').checked = config.hoverPreview;
        document.getElementById('s-hdelay').value = config.hoverDelay;
        document.getElementById('s-infscroll').checked = config.infiniteScroll;
        document.getElementById('s-dmin').value = config.delayMin;
        document.getElementById('s-dmax').value = config.delayMax;
        document.getElementById('s-batch').value = config.batchSize;
        document.getElementById('s-pause').value = Math.round(config.batchPause / 1000);
        document.getElementById('s-daily').value = config.dailyLimit;
        document.getElementById('s-hist').value = config.maxHistory || 30;
        document.getElementById('s-sortbadges').checked = config.showLikeBadges;
        document.getElementById('s-livesort').checked = config.liveSort;
        document.getElementById('s-scrollpages').value = config.scrollPageLimit || 10;
        document.getElementById('s-dlconc').value = config.dlConcurrency || 2;

        if (config.infiniteScroll) enableInfiniteScroll();
        else disableInfiniteScroll({ navigate: false });

        if (!config.showLikeBadges) clearLikeBadges();

        updateUI();
        setStatus('Settings reset.', '#f59e0b');
    });

    injectCheckboxes();
    updateUI();

    if (cachedAccount) updateAccountUI(cachedAccount);
    const cachedTags = GM_getValue(STORAGE_KEYS.bmtags, []);
    if (cachedTags.length > 0) renderTagChips(cachedTags);
    updateTagStatusUI();

    if (config.infiniteScroll) {
        enableInfiniteScroll();
    }

    (async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(800 + attempt * 800);
            const acc = await fetchMyUserDataAsync();
            if (acc?.id) {
                updateAccountUI(acc);
                const tags = await fetchMyBookmarkTags(acc.id);
                renderTagChips(tags);
                updateTagStatusUI();
                return;
            }
        }
        updateAccountUI(null);
    })();

    new MutationObserver(() => {
        scheduleDomSync();
        if (config.infiniteScroll) hideNativePagination();
    }).observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
        const el = document.getElementById('val-reset');
        if (el) el.textContent = getTimeUntilMidnight();
    }, 30000);

    setTimeout(getTokenAsync, 1000);
})();
