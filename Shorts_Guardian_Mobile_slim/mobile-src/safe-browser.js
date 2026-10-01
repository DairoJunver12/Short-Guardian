// ── safe-browser.js ──────────────────────────────────────────────────────────
// "Safe YouTube": an in-app browser locked to YouTube domains. The unchanged
// content script is injected into every page; its messages are routed into the
// on-device pipeline, and block/skip commands are sent back.
(function () {
  "use strict";
  const START_URL = "https://m.youtube.com/shorts";
  const ALLOWED = /(^|\.)(youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com|ggpht\.com|gstatic.com|google\.com|googleapis\.com|youtube-nocookie\.com)$/i;
  let ref = null, injectCode = null;
  const meta = new Map();   // videoId → {title, channel} from oEmbed

  async function getInject() {
    if (!injectCode) injectCode = await (await fetch("mobile/inject.js")).text();
    return injectCode;
  }

  // The mobile site's DOM rarely exposes a usable title, so look it up via oEmbed.
  async function enrich(p) {
    if (!p || !p.videoId) return p;
    if (!meta.has(p.videoId)) {
      try {
        const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/shorts/" + p.videoId));
        meta.set(p.videoId, r.ok ? await r.json() : null);
      } catch (_) { meta.set(p.videoId, null); }
    }
    const m = meta.get(p.videoId);
    return m ? { ...p, title: m.title || p.title, channel: m.author_name || p.channel } : p;
  }

  async function onPageMessage(ev) {
    const msg = ev && ev.data;
    if (!msg || !msg.type) return;
    const id = msg.videoId || (msg.payload && msg.payload.videoId);
    if (id) window.SG.currentVideoId = id;
    if (msg.type === "SG_CLASSIFY_SHORT") {
      if (msg.payload && msg.payload.frame) { window.SG.frames[id] = msg.payload.frame; delete msg.payload.frame; }
      msg.payload = await enrich(msg.payload);
    }
    window.SG.dispatch(msg, { tab: { id: 1, windowId: 1 } });   // → background.js
  }

  window.SG.deliverToBrowser = (msg) => new Promise((res) => {
    if (!ref) return res();
    ref.executeScript({ code: "window.__sgDeliver&&window.__sgDeliver(" + JSON.stringify(msg) + ");" }, () => res());
  });

  async function open() {
    await window.SG.ready;
    const IAB = window.cordova && window.cordova.InAppBrowser;
    if (!IAB) { alert("In-app browser plugin is not available."); return; }
    const code = await getInject();
    ref = IAB.open(START_URL, "_blank",
      "location=no,zoom=no,hidenavigationbuttons=yes,hideurlbar=yes,beforeload=yes," +
      "closebuttoncaption=Done,toolbarposition=top,toolbarcolor=#0a1a10,closebuttoncolor=#ffffff");
    ref.addEventListener("beforeload", (ev, next) => {
      try { if (ALLOWED.test(new URL(ev.url).hostname)) next(ev.url); } catch (_) {}   // other sites are blocked
    });
    ref.addEventListener("loadstop", () => ref.executeScript({ code }));
    ref.addEventListener("message", onPageMessage);
    ref.addEventListener("exit", () => { ref = null; });
  }

  // ── Gmail sign-in (parent) ────────────────────────────────────────────────
  window.SG.gmailLogin = async () => {
    const SL = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SocialLogin;
    const id = window.SG_CONFIG && window.SG_CONFIG.googleWebClientId;
    if (!SL) throw new Error("Google sign-in plugin missing");
    if (!id) throw new Error("Set googleWebClientId in mobile-src/config.js");
    await SL.initialize({ google: { webClientId: id } });
    const r = await SL.login({ provider: "google", options: { scopes: ["email", "profile", "https://www.googleapis.com/auth/gmail.send"] } });
    const token = r && r.result && r.result.accessToken && r.result.accessToken.token;
    if (!token) throw new Error("No access token returned");
    localStorage.setItem("sg_gmail_token", JSON.stringify({ token, exp: Date.now() + 55 * 60 * 1000 }));
    return token;
  };

  // ── Launcher bar ───────────────────────────────────────────────────────────
  function mount() {
    const bar = document.createElement("div");
    bar.id = "sgMobileBar";
    bar.innerHTML = '<button id="sgOpenYT">▶ Open Safe YouTube</button><button id="sgGmail" class="alt" hidden>✉ Connect Gmail</button>';
    document.body.appendChild(bar);
    bar.querySelector("#sgOpenYT").addEventListener("click", open);
    const gmail = bar.querySelector("#sgGmail");
    gmail.addEventListener("click", () => {
      chrome.identity.getAuthToken({ interactive: true }, (t) => alert(t ? "Gmail connected ✓" : "Could not connect: " + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown error")));
    });
    // Parent-only action: show only once the PIN gate is unlocked.
    setInterval(() => { const g = document.getElementById("pinGate"); gmail.hidden = !!g && !g.classList.contains("u-hidden"); }, 600);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
