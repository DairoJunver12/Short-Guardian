// ── chrome-shim.js ───────────────────────────────────────────────────────────
// Emulates the subset of chrome.* used by Shorts Guardian so the ORIGINAL
// background.js / offscreen.js / app.js run unchanged inside the mobile app.
(function () {
  "use strict";
  const DB = "sg-store", STORE = "kv";
  const areas = { local: {}, sync: {} };       // sync = device-local on mobile
  const changeListeners = [], msgListeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  // ── Persistence (IndexedDB — no 5 MB localStorage cap for logs/snapshots) ──
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbGet = async (k) => { const db = await idb(); return new Promise((res, rej) => {
    const q = db.transaction(STORE).objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const idbPut = async (k, v) => { const db = await idb(); return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); };

  const ready = (async () => {
    try { for (const n of Object.keys(areas)) { const v = await idbGet(n); if (v) areas[n] = v; } }
    catch (e) { console.warn("[SG shim] storage load failed", e); }
  })();

  const timers = {};
  const persist = (n) => { clearTimeout(timers[n]); timers[n] = setTimeout(() => idbPut(n, areas[n]).catch(console.warn), 250); };
  const flush = () => Object.keys(areas).forEach((n) => { clearTimeout(timers[n]); idbPut(n, areas[n]).catch(() => {}); });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  const fire = (changes, name) => changeListeners.forEach((fn) => { try { fn(changes, name); } catch (e) { console.error(e); } });
  const finish = (p, cb) => { if (typeof cb === "function") { p.then((v) => cb(v)); return undefined; } return p; };

  function makeArea(name) {
    return {
      get(keys, cb) {
        return finish(ready.then(() => {
          const s = areas[name]; let out = {};
          if (keys == null) out = clone(s);
          else if (typeof keys === "string") { if (keys in s) out[keys] = clone(s[keys]); }
          else if (Array.isArray(keys)) keys.forEach((k) => { if (k in s) out[k] = clone(s[k]); });
          else Object.keys(keys).forEach((k) => { out[k] = k in s ? clone(s[k]) : keys[k]; });
          return out;
        }), cb);
      },
      set(items, cb) {
        return finish(ready.then(() => {
          const s = areas[name], changes = {};
          for (const k of Object.keys(items)) { changes[k] = { oldValue: s[k], newValue: clone(items[k]) }; s[k] = changes[k].newValue; }
          persist(name); fire(changes, name);
        }), cb);
      },
      remove(keys, cb) {
        return finish(ready.then(() => {
          const s = areas[name], changes = {};
          [].concat(keys).forEach((k) => { if (k in s) { changes[k] = { oldValue: s[k] }; delete s[k]; } });
          persist(name); fire(changes, name);
        }), cb);
      },
      clear(cb) { return finish(ready.then(() => { areas[name] = {}; persist(name); }), cb); },
    };
  }

  // ── In-process message bus (replaces extension messaging) ──────────────────
  // sender = {tab:{...}} for messages coming from the Safe YouTube browser,
  // {} for messages between the engine modules (background ↔ classifier).
  function dispatch(msg, sender) {
    return new Promise((resolve) => setTimeout(() => {
      let responded = false, asyncResp = false;
      const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
      for (const fn of msgListeners.slice()) {
        try { if (fn(clone(msg), sender || {}, sendResponse) === true) asyncResp = true; }
        catch (e) { console.error("[SG shim] listener error", e); }
      }
      if (!asyncResp && !responded) resolve(undefined);
    }, 0));
  }

  // ── Thumbnails stand in for chrome.tabs.captureVisibleTab ──────────────────
  const blobToDataUrl = (b) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  async function thumbDataUrl(id) {
    if (!id) return null;
    for (const name of ["hq2", "oar2", "hqdefault"]) {
      try {
        const r = await window.fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
        if (!r.ok) continue;
        const b = await r.blob();
        if (b.size > 1500) return await blobToDataUrl(b);
      } catch (_) { /* try next */ }
    }
    return null;
  }

  // ── Native HTTP for hosts that block browser CORS ─────────────────────────
  const NATIVE_HOSTS = ["api.anthropic.com", "www.googleapis.com", "i.ytimg.com", "www.youtube.com"];
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    const Http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    let u; try { u = new URL(typeof input === "string" ? input : input.url, location.href); } catch (_) {}
    if (!Http || !u || !NATIVE_HOSTS.includes(u.hostname)) return origFetch(input, init);
    init = init || {};
    const isImg = /\.(jpe?g|png|webp)$/i.test(u.pathname);
    const headers = {}; new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    let data = init.body;
    if (typeof data === "string" && /json/i.test(headers["content-type"] || "")) { try { data = JSON.parse(data); } catch (_) {} }
    const res = await Http.request({ url: u.href, method: (init.method || "GET").toUpperCase(), headers, data, responseType: isImg ? "blob" : "text" });
    let body = res.data;
    if (isImg) { const bin = atob(body); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); body = new Blob([arr], { type: "image/jpeg" }); }
    else if (typeof body !== "string") body = JSON.stringify(body);
    return new Response([204, 304].includes(res.status) ? null : body, { status: res.status, headers: isImg ? { "content-type": "image/jpeg" } : res.headers });
  };

  // ── The chrome object ───────────────────────────────────────────────────────
  const withLastError = (msg, cb) => { chrome.runtime.lastError = msg ? { message: msg } : undefined; try { cb && cb(); } finally { chrome.runtime.lastError = undefined; } };
  const GMAIL_KEY = "sg_gmail_token";

  window.SG = {
    ready, dispatch, flush,
    currentVideoId: null,
    frames: {},                                  // videoId → live frame (data URL) from Safe YouTube
    deliverToBrowser: () => Promise.resolve(),   // replaced by safe-browser.js
    gmailLogin: () => Promise.reject(new Error("Gmail sign-in not available")),
  };

  window.chrome = {
    storage: {
      local: makeArea("local"), sync: makeArea("sync"),
      onChanged: { addListener: (fn) => changeListeners.push(fn), removeListener: (fn) => { const i = changeListeners.indexOf(fn); if (i > -1) changeListeners.splice(i, 1); } },
    },
    runtime: {
      id: "sg-mobile", lastError: undefined,
      onMessage: { addListener: (fn) => msgListeners.push(fn), removeListener: (fn) => { const i = msgListeners.indexOf(fn); if (i > -1) msgListeners.splice(i, 1); } },
      onInstalled: { addListener: (fn) => { ready.then(() => fn({ reason: "install" })); } },
      sendMessage: (msg) => dispatch(msg, {}),
      getURL: (p) => "shortsguardian://" + p,
      getContexts: async () => [{}],             // "offscreen document" always exists
      openOptionsPage: () => {},
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    tabs: {
      sendMessage: (_tabId, msg) => window.SG.deliverToBrowser(msg),
      captureVisibleTab: (_w, _o, cb) => { const id = window.SG.currentVideoId; const live = window.SG.frames[id]; delete window.SG.frames[id]; const p = live ? Promise.resolve(live) : thumbDataUrl(id); if (typeof _o === "function") cb = _o; if (typeof cb === "function") { p.then(cb); return undefined; } return p; },
    },
    tabCapture: { getMediaStreamId: (_o, cb) => withLastError("Audio capture is not available on mobile", () => cb && cb(undefined)) },
    identity: {
      getAuthToken(opts, cb) {
        let cached = null; try { cached = JSON.parse(localStorage.getItem(GMAIL_KEY) || "null"); } catch (_) {}
        if (cached && cached.exp > Date.now()) return withLastError(null, () => cb(cached.token));
        if (!(opts && opts.interactive)) return withLastError("Gmail not connected", () => cb(undefined));
        window.SG.gmailLogin().then((t) => withLastError(null, () => cb(t)), (e) => withLastError(String(e.message || e), () => cb(undefined)));
      },
      removeCachedAuthToken(_o, cb) { try { localStorage.removeItem(GMAIL_KEY); } catch (_) {} cb && cb(); },
    },
  };
})();
