// Headless test: shim + the real background.js, with a stub classifier and stub browser.
require("fake-indexeddb/auto");
const vm = require("vm"), fs = require("fs"), path = require("path");
const W = path.join(__dirname, "..", "www");
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, indexedDB, IDBKeyRange,
  URL, Headers, Response, Blob, FileReader: class {}, crypto: require("crypto").webcrypto,
  atob, btoa, TextEncoder, TextDecoder, structuredClone, fetch: async () => ({ ok: false }),
  location: { href: "https://localhost/" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { addEventListener() {}, hidden: false }, OffscreenCanvas: undefined, createImageBitmap: undefined,
};
sandbox.window = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
const run = (f) => vm.runInContext(fs.readFileSync(path.join(W, f), "utf8"), sandbox, { filename: f });

run("mobile/chrome-shim.js");
const delivered = [];
sandbox.SG.deliverToBrowser = async (m) => { delivered.push(m); };
// Stub for the on-device classifier (offscreen.js needs a real browser + TF.js)
sandbox.chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SG_CLASSIFY_SHORT" && msg.payload && msg.payload.requestId)
    sandbox.chrome.runtime.sendMessage({ type: "SG_CLASSIFY_RESULT", payload: { requestId: msg.payload.requestId,
      imageLabel: "person", imageConfidence: 0.4, category: "other", categoryTier: "neutral", textSentiment: "NEGATIVE", textScore: 0.6 } });
});
run("mobile/background.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  await sandbox.SG.ready; await sleep(100);
  const st = await sandbox.chrome.storage.local.get("sg_settings");
  ok(st.sg_settings && st.sg_settings.enabled === true, "defaults written on first run (onInstalled)");

  const tab = { tab: { id: 1, windowId: 1 } };
  await sandbox.SG.dispatch({ type: "SG_CLASSIFY_SHORT", payload: { videoId: "BAD1", title: "gun fight compilation", channel: "x", url: "u" } }, tab);
  await sleep(1200);
  const logs = (await sandbox.chrome.storage.local.get("sg_logs")).sg_logs || [];
  ok(logs.length === 1 && logs[0].flagged === true, "bad Short is logged and flagged");
  ok(delivered.some((m) => m.type === "SG_BLOCK_SHORT" && m.videoId === "BAD1"), "block overlay command sent to browser");
  ok(delivered.some((m) => m.type === "SG_SKIP_SHORT"), "auto-skip command sent to browser");
  const blocked = (await sandbox.chrome.storage.local.get("sg_blocked_ids")).sg_blocked_ids || {};
  ok(!!blocked.BAD1, "blocked ID persisted for revisit");

  delivered.length = 0;
  await sandbox.SG.dispatch({ type: "SG_CHECK_BLOCKED", videoId: "BAD1" }, tab); await sleep(300);
  ok(delivered.some((m) => m.type === "SG_CHECK_BLOCKED_RESULT" && m.blocked), "revisit is re-blocked instantly");

  await sandbox.SG.dispatch({ type: "SG_CLASSIFY_SHORT", payload: { videoId: "OK1", title: "cute puppy learns to sit", channel: "pets", url: "u" } }, tab);
  await sleep(1200);
  const logs2 = (await sandbox.chrome.storage.local.get("sg_logs")).sg_logs || [];
  const good = logs2.find((l) => l.videoId === "OK1");
  ok(good && good.flagged === false, "safe Short is logged and NOT flagged");
  sandbox.SG.currentVideoId = "LIVE1"; sandbox.SG.frames.LIVE1 = "data:image/jpeg;base64,LIVEFRAME";
  const got = await sandbox.chrome.tabs.captureVisibleTab(1, { format: "jpeg" });
  ok(got === "data:image/jpeg;base64,LIVEFRAME" && !sandbox.SG.frames.LIVE1, "live video frame is preferred over thumbnail");
  process.exit(process.exitCode || 0);
})();
