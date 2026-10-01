// Runs INSIDE the Safe YouTube browser, before content.js. Gives the unchanged
// content script a chrome.runtime that talks to the app through the in-app
// browser's message bridge.
(function () {
  if (window.__sgBoot) return; window.__sgBoot = true;
  var post = function (o) {
    var s = JSON.stringify(o);
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cordova_iab) window.webkit.messageHandlers.cordova_iab.postMessage(s);
      else if (window._cordova_iab) window._cordova_iab.postMessage(s);
    } catch (e) {}
  };
  var listeners = [];
  window.__sgDeliver = function (m) { listeners.forEach(function (f) { try { f(m, {}, function () {}); } catch (e) {} }); };
  window.chrome = window.chrome || {};
  // Pick the <video> most visible on screen (Shorts keeps prefetched videos in the DOM)
  function pickVideo() {
    var best = null, bestArea = 0;
    document.querySelectorAll("video").forEach(function (v) {
      var r = v.getBoundingClientRect();
      var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea && v.videoWidth > 0) { best = v; bestArea = w * h; }
    });
    return best;
  }
  // Returns a small JPEG data URL of the current frame, or null (DRM/tainted/not ready)
  function grabFrame() {
    try {
      var v = pickVideo();
      if (!v || v.readyState < 2) return null;
      var k = 320 / Math.max(v.videoWidth, v.videoHeight);
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.6);
    } catch (e) { return null; }
  }
  function sendClassify(m) {
    var tries = 0;
    (function attempt() {
      var f = grabFrame();
      if (f || ++tries >= 8) { if (f) m.payload.frame = f; post(m); }
      else setTimeout(attempt, 250);        // wait up to ~2 s for the first frame
    })();
  }
  window.chrome.runtime = {
    id: "sg-page",
    sendMessage: function (m) {
      if (m && m.type === "SG_CLASSIFY_SHORT" && m.payload) sendClassify(m); else post(m);
      return Promise.resolve();
    },
    onMessage: { addListener: function (f) { listeners.push(f); } }
  };
})();
