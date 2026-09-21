// ==UserScript==
// @name         Pixiv Tools
// @namespace    http://tampermonkey.net/
// @version      8.9
// @description  Fast artwork selection, full-res hover preview, multi-column infinite scroll, selection history snapshots, bulk like & bookmarking with dynamic tag detection for Pixiv
// @author       You
// @match        https://www.pixiv.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      www.pixiv.net
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

            let chk = a.querySelector('.ppt-chk');
            if (!chk) {
                a.classList.add('ppt-art-link');
                chk = document.createElement('div');
                chk.className = 'ppt-chk';
                chk.dataset.illustId = id;
                chk.title = 'Select artwork';
                a.appendChild(chk);
            }
            const isSel = selected.has(id);
            chk.classList.toggle('ppt-chk-on', isSel);
            a.classList.toggle('ppt-art-selected', isSel);
        }
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
            <img id="ppt-hover-img" src="" alt="preview">
            <div id="ppt-hover-pagenum"></div>
            <div id="ppt-hover-scroll-hint">🖱 scroll to browse pages</div>
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
        const scrollHint = document.getElementById('ppt-hover-scroll-hint');

        const isMulti = Array.isArray(data.pages) && data.pages.length > 1;
        hoverEl.classList.toggle('multipage', isMulti);

        bar.innerHTML = [
            `<span class="hb-bm">♥ ${data.bookmarks}</span>`,
            `<span class="hb-dim">${data.width}x${data.height}</span>`,
            isMulti ? `<span class="hb-pages">${data.pages.length}P</span>` : '',
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
    let _infCurrentPage = (function () {
        const p = new URLSearchParams(location.search).get('p');
        return p ? parseInt(p, 10) : 1;
    })();
    let _infSeenIds = new Set();

    const infLoaderEl = document.createElement('div');
    infLoaderEl.id = 'ppt-inf-loader';
    infLoaderEl.innerHTML = '<span class="ppt-spinner"></span> Loading page <span class="ppt-inf-page-num">2</span>…';

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
        if (body.works && Array.isArray(body.works)) return body.works;
        const candidates = [
            body.illust?.data,
            body.illustManga?.data,
            body.manga?.data,
            body.popular?.recent,
            body.popular?.permanent,
        ];
        for (const src of candidates) {
            if (Array.isArray(src) && src.length > 0) return src;
        }
        return [];
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

    async function loadNextInfinitePage() {
        if (_infScrollLoading || _infScrollDone || !config.infiniteScroll) return;
        _infScrollLoading = true;
        _infCurrentPage++;

        const url = buildNextApiUrl(_infCurrentPage);
        if (!url) {
            _infScrollDone = true;
            _infScrollLoading = false;
            return;
        }

        const pageNumEl = infLoaderEl.querySelector('.ppt-inf-page-num');
        if (pageNumEl) pageNumEl.textContent = _infCurrentPage;
        infLoaderEl.classList.add('show');

        const infStatusEl = document.getElementById('ppt-inf-status');
        if (infStatusEl) infStatusEl.textContent = `P${_infCurrentPage}…`;

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
            if (works.length === 0) {
                _infScrollDone = true;
                infLoaderEl.classList.remove('show');
                infEndEl.classList.add('show');
                if (infStatusEl) infStatusEl.textContent = `End (P${_infCurrentPage - 1})`;
                _infScrollLoading = false;
                return;
            }

            const grid = findArtworkGridContainer();
            if (grid) {
                const templateItem = getArtworkCardTemplate(grid);
                let added = 0;
                works.forEach(work => {
                    const el = createThumbCardElement(work, templateItem);
                    if (el) {
                        grid.appendChild(el);
                        added++;
                    }
                });

                injectCheckboxes();
                syncAllDomVisuals();

                updateBrowserUrlPage(_infCurrentPage);
                if (infStatusEl) infStatusEl.textContent = `P${_infCurrentPage} (+${added})`;
            }
        } catch (err) {
            console.warn('[PPT] Infinite scroll error:', err);
            _infCurrentPage--;
        } finally {
            infLoaderEl.classList.remove('show');
            _infScrollLoading = false;
        }
    }

    function onInfScroll() {
        if (!config.infiniteScroll || _infScrollLoading || _infScrollDone) return;
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;
        if (docHeight - scrollBottom < 850) {
            loadNextInfinitePage();
        }
    }

    function enableInfiniteScroll() {
        config.infiniteScroll = true;
        saveConfig(config);
        _infScrollDone = false;

        const toggle = document.getElementById('ppt-inf-toggle');
        if (toggle) toggle.checked = true;

        collectExistingArtworkIds();
        appendLoaderToDOM();
        hideNativePagination();
        window.addEventListener('scroll', onInfScroll, { passive: true });

        const infStatusEl = document.getElementById('ppt-inf-status');
        if (infStatusEl) infStatusEl.textContent = `ON (P${_infCurrentPage})`;
        onInfScroll();
    }

    function disableInfiniteScroll() {
        config.infiniteScroll = false;
        saveConfig(config);

        const toggle = document.getElementById('ppt-inf-toggle');
        if (toggle) toggle.checked = false;

        window.removeEventListener('scroll', onInfScroll);
        infLoaderEl.classList.remove('show');
        showNativePagination();

        const infStatusEl = document.getElementById('ppt-inf-status');
        if (infStatusEl) infStatusEl.textContent = 'OFF';
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        #ppt-panel {
            position: fixed;
            top: 76px;
            right: 18px;
            z-index: 99999;
            width: 260px;
            background: #0b0c14;
            border: 1px solid #1c2033;
            border-radius: 12px;
            padding: 12px 14px;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 11px;
            line-height: 1.4;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
            user-select: none;
            box-sizing: border-box;
            transition: opacity 0.2s, transform 0.15s;
        }
        #ppt-panel * { box-sizing: border-box; }
        #ppt-panel:hover { opacity: 1; }

        .ppt-hdr {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
            cursor: grab;
            padding-bottom: 8px;
            border-bottom: 1px solid #161928;
        }
        .ppt-hdr:active { cursor: grabbing; }
        .ppt-title-wrap {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 700;
            color: #f43f5e;
            font-size: 12px;
            letter-spacing: -0.2px;
            pointer-events: none;
        }
        .ppt-nav-ctrls { display: flex; align-items: center; gap: 3px; }
        .ppt-icon-btn {
            background: transparent;
            border: 1px solid transparent;
            color: #64748b;
            cursor: pointer;
            font-size: 11px;
            padding: 3px 5px;
            border-radius: 5px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.12s ease;
        }
        .ppt-icon-btn:hover { color: #f1f5f9; background: #181c2e; border-color: #242a42; }
        .ppt-icon-btn.active { color: #f43f5e; background: #22121e; border-color: #4a1529; }

        .ppt-view { display: none; }
        .ppt-view.ppt-view-active { display: block; }
        #ppt-panel.minimized .ppt-view { display: none !important; }
        #ppt-panel.minimized .ppt-hdr { margin-bottom: 0; border-bottom: none; padding-bottom: 0; }
        #ppt-panel.minimized { width: auto; padding: 6px 10px; }

        .ppt-stat-card {
            background: #111320;
            border: 1px solid #1c2035;
            border-radius: 8px;
            padding: 8px 10px;
            margin-bottom: 8px;
            display: flex;
            align-items: baseline;
            justify-content: space-between;
        }
        .ppt-stat-main { display: flex; align-items: baseline; gap: 5px; }
        .ppt-stat-num {
            font-size: 18px;
            font-weight: 800;
            color: #f1f5f9;
            font-variant-numeric: tabular-nums;
            letter-spacing: -0.5px;
        }
        .ppt-stat-sub { font-size: 10px; color: #64748b; font-weight: 500; }
        .ppt-stat-actions { display: flex; align-items: center; gap: 6px; }
        .ppt-stat-btn {
            background: transparent;
            border: none;
            color: #94a3b8;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            padding: 0;
            transition: color 0.12s;
        }
        .ppt-stat-btn:hover { color: #f43f5e; }

        .ppt-btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
        .ppt-btn {
            padding: 6px 8px;
            border: 1px solid transparent;
            border-radius: 6px;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            text-align: center;
            transition: all 0.12s ease;
            outline: none;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
        .ppt-btn:active:not(:disabled) { transform: scale(0.97); }
        .ppt-btn:disabled { opacity: 0.35; cursor: not-allowed; }

        .ppt-btn-primary { background: #e11d48; color: #fff; font-weight: 700; }
        .ppt-btn-primary:hover:not(:disabled) { background: #f43f5e; }
        .ppt-btn-success { background: #059669; color: #fff; font-weight: 700; }
        .ppt-btn-success:hover:not(:disabled) { background: #10b981; }
        .ppt-btn-subtle { background: #141624; border-color: #21253a; color: #cbd5e1; }
        .ppt-btn-subtle:hover:not(:disabled) { background: #1c2033; color: #fff; border-color: #2d334e; }
        .ppt-btn-toggle {
            width: 100%;
            background: #141624;
            border: 1px solid #21253a;
            color: #94a3b8;
            margin-bottom: 6px;
            padding: 5px 8px;
        }
        .ppt-btn-toggle.active {
            background: #2a121e;
            border-color: #e11d48;
            color: #fb7185;
        }
        .ppt-btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; width: 100%; margin-bottom: 6px; display: none; }

        .ppt-tag-card {
            background: #111322;
            border: 1px solid #1c2035;
            border-radius: 8px;
            padding: 8px 10px;
            margin-bottom: 8px;
        }
        .ppt-tag-hdr {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 3px;
        }
        .ppt-tag-hdr-title {
            font-size: 9px;
            font-weight: 700;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .ppt-acct-line {
            font-size: 9.5px;
            color: #64748b;
            margin-bottom: 6px;
        }
        .ppt-acct-name {
            color: #a78bfa;
            font-weight: 700;
            font-family: ui-monospace, monospace;
        }
        .ppt-chips-wrap {
            max-height: 86px;
            overflow-y: auto;
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 6px;
            padding-right: 2px;
        }
        .ppt-chips-wrap::-webkit-scrollbar { width: 3px; }
        .ppt-chips-wrap::-webkit-scrollbar-thumb { background: #22263d; border-radius: 3px; }
        .ppt-chip {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            background: #16182a;
            border: 1px solid #232742;
            border-radius: 12px;
            padding: 2px 7px;
            font-size: 9.5px;
            color: #94a3b8;
            cursor: pointer;
            transition: all 0.12s ease;
            user-select: none;
            white-space: nowrap;
        }
        .ppt-chip:hover { border-color: #3b4366; color: #e2e8f0; }
        .ppt-chip.active {
            background: #2a1220;
            border-color: #f43f5e;
            color: #fb7185;
        }
        .ppt-chip .cnt {
            font-size: 8.5px;
            color: #64748b;
            font-variant-numeric: tabular-nums;
        }
        .ppt-chip.active .cnt { color: #f43f5e; }
        .ppt-input {
            width: 100%;
            background: #090a12;
            border: 1px solid #22263d;
            border-radius: 5px;
            color: #f1f5f9;
            font-size: 10px;
            padding: 4px 7px;
            outline: none;
            margin-bottom: 6px;
            transition: border-color 0.12s;
        }
        .ppt-input:focus { border-color: #f43f5e; }
        .ppt-tag-meta {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 9.5px;
            color: #64748b;
        }
        .ppt-checkbox-label {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            color: #94a3b8;
        }
        .ppt-tag-status {
            color: #64748b;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 135px;
            text-align: right;
        }

        .ppt-prog-wrap { display: none; height: 4px; background: #181b2e; border-radius: 2px; overflow: hidden; margin: 4px 0 6px; }
        .ppt-prog-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #e11d48, #10b981); transition: width 0.2s; }
        .ppt-status { font-size: 10px; color: #64748b; min-height: 14px; margin-bottom: 4px; word-break: break-word; }
        .ppt-quota-row { display: flex; justify-content: space-between; font-size: 9px; color: #475569; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
        .ppt-quota-row .val { color: #fbbf24; font-weight: 700; }

        .ppt-history-wrap { max-height: 230px; overflow-y: auto; margin-bottom: 8px; padding-right: 2px; }
        .ppt-history-wrap::-webkit-scrollbar { width: 4px; }
        .ppt-history-wrap::-webkit-scrollbar-thumb { background: #21253a; border-radius: 4px; }
        .ppt-history-item {
            background: #111320;
            border: 1px solid #1b1e32;
            border-radius: 6px;
            padding: 6px 8px;
            margin-bottom: 5px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            transition: border-color 0.12s;
        }
        .ppt-history-item:hover { border-color: #2b3152; }
        .ppt-hist-top { display: flex; align-items: center; justify-content: space-between; }
        .ppt-hist-title { font-weight: 600; color: #e2e8f0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
        .ppt-hist-badge { font-size: 9px; background: #1c2035; color: #a78bfa; padding: 1px 5px; border-radius: 4px; font-weight: 700; }
        .ppt-hist-time { font-size: 9px; color: #64748b; }
        .ppt-hist-actions { display: flex; gap: 4px; margin-top: 2px; }
        .ppt-hist-btn {
            background: #161928;
            border: 1px solid #232740;
            color: #cbd5e1;
            font-size: 9px;
            font-weight: 600;
            border-radius: 4px;
            padding: 2px 6px;
            cursor: pointer;
            transition: all 0.1s;
        }
        .ppt-hist-btn:hover { background: #222740; color: #fff; }
        .ppt-hist-btn.danger:hover { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }

        .ppt-srow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; gap: 6px; }
        .ppt-srow label { font-size: 9px; color: #94a3b8; }
        .ppt-srow input {
            width: 60px;
            background: #090a12;
            border: 1px solid #22263d;
            border-radius: 4px;
            color: #f1f5f9;
            font-size: 10px;
            padding: 2px 6px;
            text-align: right;
            outline: none;
        }

        .ppt-art-link { position: relative !important; }
        .ppt-chk {
            position: absolute;
            top: 6px;
            left: 6px;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid rgba(255, 255, 255, 0.85);
            background: rgba(11, 12, 20, 0.7);
            cursor: pointer;
            z-index: 999;
            display: none;
            align-items: center;
            justify-content: center;
            transition: all 0.12s ease;
            box-sizing: border-box;
        }
        .ppt-chk::after {
            content: '✓';
            color: #fff;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            opacity: 0;
            transition: opacity 0.12s;
        }
        .ppt-chk.ppt-chk-on {
            display: flex;
            background: #e11d48;
            border-color: #e11d48;
        }
        .ppt-chk.ppt-chk-on::after { opacity: 1; }
        .ppt-art-link:hover .ppt-chk,
        body.ppt-selecting-mode .ppt-chk {
            display: flex;
        }
        a.ppt-art-selected {
            outline: 3px solid #e11d48 !important;
            border-radius: 6px;
        }
        a.ppt-art-done {
            outline: 3px solid #10b981 !important;
            border-radius: 6px;
        }

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
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.1);
            background: #090a12;
            overflow: hidden;
        }
        #ppt-hover-preview.show { display: inline-flex; }
        #ppt-hover-bar {
            width: 0;
            min-width: 100%;
            max-width: 100%;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: #090a12;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 11px;
            color: #e2e8f0;
            white-space: nowrap;
            overflow: hidden;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        #ppt-hover-bar .hb-bm { color: #fb7185; font-weight: 700; flex-shrink: 0; }
        #ppt-hover-bar .hb-dim { color: #4ade80; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        #ppt-hover-bar .hb-pages { color: #c084fc; font-weight: 700; flex-shrink: 0; }
        #ppt-hover-bar .hb-date { color: #93c5fd; flex-shrink: 0; }
        #ppt-hover-bar .hb-author { color: #a78bfa; flex-shrink: 0; font-weight: 600; }
        #ppt-hover-bar .hb-tags { color: #fbbf24; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
        #ppt-hover-img-wrap {
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            position: relative;
            width: fit-content;
            max-width: fit-content;
        }
        #ppt-hover-img {
            max-width: 75vw;
            max-height: calc(85vh - 36px);
            object-fit: contain;
            display: block;
            width: auto;
            height: auto;
            transition: opacity 0.15s;
        }
        #ppt-hover-pagenum {
            display: none;
            position: absolute;
            bottom: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px;
            font-weight: 700;
            padding: 3px 10px;
            border-radius: 12px;
            z-index: 2;
            pointer-events: none;
            font-variant-numeric: tabular-nums;
        }
        #ppt-hover-preview.multipage #ppt-hover-pagenum { display: block; }
        #ppt-hover-scroll-hint {
            display: none;
            position: absolute;
            bottom: 42px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.7);
            color: #93c5fd;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 10px;
            padding: 3px 12px;
            border-radius: 8px;
            z-index: 2;
            pointer-events: none;
            transition: opacity 0.8s;
        }
        #ppt-hover-preview.multipage #ppt-hover-scroll-hint { display: block; }

        #ppt-inf-loader {
            text-align: center;
            padding: 24px 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px;
            font-weight: 600;
            color: #94a3b8;
            display: none;
            width: 100%;
        }
        #ppt-inf-loader.show { display: block; }
        #ppt-inf-loader .ppt-spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid #1e2640;
            border-top-color: #f43f5e;
            border-radius: 50%;
            animation: ppt-spin 0.7s linear infinite;
            vertical-align: middle;
            margin-right: 6px;
        }
        @keyframes ppt-spin { to { transform: rotate(360deg); } }
        #ppt-inf-end {
            text-align: center;
            padding: 20px 0;
            font-size: 11px;
            color: #475569;
            display: none;
            width: 100%;
        }
        #ppt-inf-end.show { display: block; }
    `;
    document.head.appendChild(styleEl);

    const panel = document.createElement('div');
    panel.id = 'ppt-panel';
    panel.innerHTML = `
        <div class="ppt-hdr">
            <div class="ppt-title-wrap">
                <span>✦ Pixiv Power Tools</span>
            </div>
            <div class="ppt-nav-ctrls">
                <button class="ppt-icon-btn active" id="tab-main" title="Main Selection View">Main</button>
                <button class="ppt-icon-btn" id="tab-history" title="Selection History">History</button>
                <button class="ppt-icon-btn" id="tab-settings" title="Settings">⚙</button>
                <button class="ppt-icon-btn" id="btn-minimize" title="Minimize/Restore">−</button>
            </div>
        </div>

        <div class="ppt-view ppt-view-active" id="view-main">
            <div class="ppt-stat-card">
                <div class="ppt-stat-main">
                    <span class="ppt-stat-num" id="stat-count">0</span>
                    <span class="ppt-stat-sub">artworks selected</span>
                </div>
                <div class="ppt-stat-actions">
                    <button class="ppt-stat-btn" id="btn-quick-snapshot" title="Save snapshot to history">Save</button>
                    <button class="ppt-stat-btn" id="btn-clear-all" title="Clear active selection">Clear</button>
                </div>
            </div>

            <button class="ppt-btn ppt-btn-toggle" id="btn-sel-mode">✋ Click-to-Select: OFF</button>

            <div class="ppt-btn-grid">
                <button class="ppt-btn ppt-btn-subtle" id="btn-sel-visible">☑ Select Visible</button>
                <button class="ppt-btn ppt-btn-subtle" id="btn-clr-visible">✕ Clear Visible</button>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px">
                <label class="ppt-checkbox-label" style="font-size:10px;font-weight:600">
                    <input type="checkbox" id="ppt-inf-toggle" ${config.infiniteScroll ? 'checked' : ''}> ♾️ Infinite Scroll
                </label>
                <span id="ppt-inf-status" style="font-size:9.5px;color:#64748b">${config.infiniteScroll ? 'ON' : 'OFF'}</span>
            </div>

            <div class="ppt-tag-card">
                <div class="ppt-tag-hdr">
                    <span class="ppt-tag-hdr-title">Auto-tag on Like / Bookmark</span>
                    <button class="ppt-icon-btn" id="btn-reload-tags" title="Reload account tags">↻ Reload</button>
                </div>
                <div class="ppt-acct-line">
                    Account: <span class="ppt-acct-name" id="ppt-acct-name">Loading…</span>
                </div>
                <div class="ppt-chips-wrap" id="ppt-chips-container">
                    <span style="color:#64748b;font-size:9.5px">Fetching tags…</span>
                </div>
                <input type="text" id="ppt-custom-tags" class="ppt-input" placeholder="+ custom tags (comma separated)" spellcheck="false">
                <div class="ppt-tag-meta">
                    <label class="ppt-checkbox-label"><input type="checkbox" id="ppt-dest-private"> Private</label>
                    <span class="ppt-tag-status" id="ppt-tag-status">No tags selected</span>
                </div>
            </div>

            <div class="ppt-btn-grid" style="margin-bottom:6px">
                <button class="ppt-btn ppt-btn-primary" id="btn-like">♥ Like</button>
                <button class="ppt-btn ppt-btn-success" id="btn-like-bm">♥ Like + Bookmark</button>
            </div>
            <button class="ppt-btn ppt-btn-danger" id="btn-stop-op">⏹ Stop Operation</button>

            <div class="ppt-prog-wrap" id="ppt-prog-wrap"><div class="ppt-prog-bar" id="ppt-prog-bar"></div></div>
            <div class="ppt-status" id="ppt-status">Ready</div>

            <div class="ppt-quota-row">
                <span>Today: <span class="val" id="val-daily">0</span>/<span class="val" id="val-daily-max">${config.dailyLimit}</span></span>
                <span>Reset: <span id="val-reset">--</span></span>
            </div>

            <div class="ppt-btn-grid">
                <button class="ppt-btn ppt-btn-subtle" id="btn-export">📥 Export</button>
                <button class="ppt-btn ppt-btn-subtle" id="btn-import">📤 Import</button>
            </div>
        </div>

        <div class="ppt-view" id="view-history">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <span style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Saved Snapshots</span>
                <button class="ppt-stat-btn" id="btn-new-snapshot">+ Snapshot Current</button>
            </div>
            <div class="ppt-history-wrap" id="history-container"></div>
            <div class="ppt-btn-grid">
                <button class="ppt-btn ppt-btn-subtle" id="btn-hist-back">← Back</button>
                <button class="ppt-btn ppt-btn-subtle" id="btn-hist-clear" style="color:#f87171">Clear History</button>
            </div>
        </div>

        <div class="ppt-view" id="view-settings">
            <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Preferences</div>
            <div class="ppt-srow"><label>Hover Preview</label><input type="checkbox" id="s-hover" ${config.hoverPreview ? 'checked' : ''} style="width:auto"></div>
            <div class="ppt-srow"><label>Hover Delay (ms)</label><input type="number" id="s-hdelay" value="${config.hoverDelay || 200}"></div>
            <div class="ppt-srow"><label>Infinite Scroll Default</label><input type="checkbox" id="s-infscroll" ${config.infiniteScroll ? 'checked' : ''} style="width:auto"></div>
            <hr style="border:0;border-top:1px solid #1c2035;margin:8px 0">
            <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Rate Limiting & Safety</div>
            <div class="ppt-srow"><label>Min Delay (ms)</label><input type="number" id="s-dmin" value="${config.delayMin}"></div>
            <div class="ppt-srow"><label>Max Delay (ms)</label><input type="number" id="s-dmax" value="${config.delayMax}"></div>
            <div class="ppt-srow"><label>Batch Size</label><input type="number" id="s-batch" value="${config.batchSize}"></div>
            <div class="ppt-srow"><label>Batch Pause (s)</label><input type="number" id="s-pause" value="${Math.round(config.batchPause / 1000)}"></div>
            <div class="ppt-srow"><label>Daily Quota</label><input type="number" id="s-daily" value="${config.dailyLimit}"></div>
            <div class="ppt-srow"><label>Max History</label><input type="number" id="s-hist" value="${config.maxHistory || 30}"></div>
            <div class="ppt-btn-grid" style="margin-top:10px">
                <button class="ppt-btn ppt-btn-primary" id="btn-save-cfg">Save</button>
                <button class="ppt-btn ppt-btn-subtle" id="btn-reset-cfg">Reset</button>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    const savedPos = GM_getValue(STORAGE_KEYS.pos, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
        panel.style.left = `${Math.min(window.innerWidth - 60, Math.max(0, savedPos.left))}px`;
        panel.style.top = `${Math.min(window.innerHeight - 40, Math.max(0, savedPos.top))}px`;
        panel.style.right = 'auto';
    }

    const panelHeader = panel.querySelector('.ppt-hdr');
    let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
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

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = '';
        GM_setValue(STORAGE_KEYS.pos, { left: panel.offsetLeft, top: panel.offsetTop });
    });

    function switchView(viewName) {
        document.querySelectorAll('.ppt-view').forEach(el => el.classList.remove('ppt-view-active'));
        document.querySelectorAll('.ppt-nav-ctrls .ppt-icon-btn').forEach(btn => {
            if (btn.id !== 'btn-minimize') btn.classList.remove('active');
        });

        const targetView = document.getElementById(`view-${viewName}`);
        const targetTab = document.getElementById(`tab-${viewName}`);
        if (targetView) targetView.classList.add('ppt-view-active');
        if (targetTab) targetTab.classList.add('active');

        if (viewName === 'history') {
            renderHistoryUI();
        }
    }

    document.getElementById('tab-main').addEventListener('click', () => switchView('main'));
    document.getElementById('tab-history').addEventListener('click', () => switchView('history'));
    document.getElementById('tab-settings').addEventListener('click', () => switchView('settings'));
    document.getElementById('btn-hist-back').addEventListener('click', () => switchView('main'));

    document.getElementById('btn-minimize').addEventListener('click', () => {
        panel.classList.toggle('minimized');
        const isMin = panel.classList.contains('minimized');
        document.getElementById('btn-minimize').textContent = isMin ? '◻' : '−';
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
            bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
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
        const limitReached = dailyCount >= config.dailyLimit;

        if (btnLike) btnLike.disabled = count === 0 || limitReached || isRunning;
        if (btnLikeBm) btnLikeBm.disabled = count === 0 || limitReached || isRunning;
    }

    function setOperationRunningUI(running) {
        const stopBtn = document.getElementById('btn-stop-op');
        const progWrap = document.getElementById('ppt-prog-wrap');
        if (stopBtn) stopBtn.style.display = running ? 'block' : 'none';
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
                <div style="text-align:center;padding:20px 10px;color:#64748b">
                    <div>No snapshots saved yet.</div>
                    <div style="font-size:9px;margin-top:4px">Click "+ Snapshot Current" above to preserve your work.</div>
                </div>
            `;
            return;
        }

        list.forEach(item => {
            const row = document.createElement('div');
            row.className = 'ppt-history-item';
            row.innerHTML = `
                <div class="ppt-hist-top">
                    <span class="ppt-hist-title" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
                    <span class="ppt-hist-badge">${item.count}</span>
                </div>
                <div class="ppt-hist-time">${formatRelativeTime(item.updatedAt || item.createdAt)}</div>
                <div class="ppt-hist-actions">
                    <button class="ppt-hist-btn" data-act="restore" data-id="${item.id}">Restore</button>
                    <button class="ppt-hist-btn" data-act="merge" data-id="${item.id}">+ Merge</button>
                    <button class="ppt-hist-btn" data-act="rename" data-id="${item.id}">Rename</button>
                    <button class="ppt-hist-btn danger" data-act="delete" data-id="${item.id}">✕</button>
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
        btnSelMode.textContent = `✋ Click-to-Select: ${selectMode ? 'ON' : 'OFF'}`;
        document.body.classList.toggle('ppt-selecting-mode', selectMode);
        injectCheckboxes();
    });

    document.getElementById('btn-sel-visible').addEventListener('click', selectAllVisible);
    document.getElementById('btn-clr-visible').addEventListener('click', clearVisible);
    document.getElementById('btn-clear-all').addEventListener('click', clearAllSelection);
    document.getElementById('btn-export').addEventListener('click', exportSelection);
    document.getElementById('btn-import').addEventListener('click', importSelection);

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
        saveConfig(config);

        if (config.infiniteScroll) enableInfiniteScroll();
        else disableInfiniteScroll();

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

        if (config.infiniteScroll) enableInfiniteScroll();
        else disableInfiniteScroll();

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
