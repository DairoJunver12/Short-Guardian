// ── Shorts Guardian — Content Script v1.5 ────────────────────────────────────
// v1.4: Added SG_BLOCK_SHORT handler — instant overlay blocker.
// v1.5: Persistent block — revisiting a previously blocked Short re-blocks
//       immediately by checking chrome.storage via SG_CHECK_BLOCKED.
(function () {
  "use strict";

  let lastVideoId = null;

  function getVideoId() {
    const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get("v");
  }

  function getMetadata() {
    // Title — try Shorts-specific selectors first, fall back to page title
    const titleSelectors = [
      "h2.title",
      '[class*="ShortsVideoTitle"]',
      "yt-formatted-string.title",
      "#shorts-player h2",
      "ytd-shorts h2",
      "h2",
    ];
    let title = "";
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        title = el.textContent.trim();
        break;
      }
    }
    if (!title) title = document.title.replace(" - YouTube", "").trim();

    const channelSelectors = [
      "ytd-channel-name a",
      '[class*="channelName"] a',
      ".yt-spec-button-view-model a",
      "a.yt-simple-endpoint[href^='/@']",
    ];
    let channel = "";
    for (const sel of channelSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        channel = el.textContent.trim();
        break;
      }
    }

    return { title, channel };
  }

  function tryNotify() {
    if (!location.pathname.includes("/shorts/")) return;

    const videoId = getVideoId();
    if (!videoId || videoId === lastVideoId) return;

    setTimeout(() => {
      if (getVideoId() !== videoId) return;
      if (videoId === lastVideoId) return;
      lastVideoId = videoId;

      // Remove any existing block overlay from the previous Short
      removeBlockOverlay();

      // ── Persistent block check ──────────────────────────────────────────
      // Ask background if this videoId was previously blocked. If so, show
      // the overlay immediately — no need to re-run the full pipeline.
      // The result comes back via SG_CHECK_BLOCKED_RESULT in the listener below.
      chrome.runtime.sendMessage({
        type:    "SG_CHECK_BLOCKED",
        videoId: videoId,
      }).catch(() => {
        // If check fails (e.g. background not ready), fall through to classify
        sendToClassify(videoId);
      });
    }, 350);
  }

  // Separated out so both the blocked-check fallback and the non-blocked path
  // can call it without duplicating the sendMessage payload.
  function sendToClassify(videoId) {
    const { title, channel } = getMetadata();
    chrome.runtime.sendMessage({
      type: "SG_CLASSIFY_SHORT",
      payload: { videoId, title, channel, url: location.href },
    }).catch(() => {});
  }

  // ── Block overlay ─────────────────────────────────────────────────────────
  // Injected CSS lives in the page's own <style> tag so it survives
  // YouTube's SPA navigations without needing a content script stylesheet.
  const OVERLAY_ID  = "sg-block-overlay";
  const STYLE_ID    = "sg-block-style";

  const REASON_LABELS = {
    weapons:         "Weapons content",
    violence:        "Violent content",
    self_harm:       "Self-harm content",
    sexual_content:  "Sexual content",
    substances:      "Drug / substance content",
    alcohol_tobacco: "Alcohol / tobacco content",
    romance:         "Kissing / romance content",
    bullying:        "Bullying / harassment",
    other:           "Flagged content",
  };

  // ── MTRCB badge colours ─────────────────────────────────────────────────────
  // G=green, PG=blue, SPG=red — matches the spec icons (🟢/🔵/🔴)
  const MTRCB_BADGE_STYLE = {
    G:   { bg: "rgba(34,197,94,0.18)",  border: "#22c55e", color: "#22c55e",  dot: "#22c55e" },
    PG:  { bg: "rgba(59,130,246,0.18)", border: "#3b82f6", color: "#3b82f6",  dot: "#3b82f6" },
    SPG: { bg: "rgba(239,68,68,0.18)",  border: "#ef4444", color: "#ef4444",  dot: "#ef4444" },
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: #0a1a10;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding: 24px;
        animation: sg-fade-in 0.18s ease;
      }
      @keyframes sg-fade-in {
        from { opacity: 0; transform: scale(0.97); }
        to   { opacity: 1; transform: scale(1); }
      }

      /* Shield icon */
      #${OVERLAY_ID} .sg-shield {
        width: 62px;
        height: 62px;
        border-radius: 50%;
        background: rgba(239,68,68,0.15);
        border: 2px solid rgba(239,68,68,0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 2px;
      }
      #${OVERLAY_ID} .sg-shield svg {
        width: 30px;
        height: 30px;
        color: #ef4444;
      }

      /* Main title */
      #${OVERLAY_ID} .sg-title {
        font-family: 'Roboto', system-ui, sans-serif;
        font-size: 17px;
        font-weight: 800;
        color: #ffffff;
        margin: 0;
        letter-spacing: -0.01em;
        text-align: center;
      }

      /* Block message body */
      #${OVERLAY_ID} .sg-message {
        font-family: 'Roboto', system-ui, sans-serif;
        font-size: 13px;
        color: rgba(255,255,255,0.62);
        margin: 0;
        text-align: center;
        max-width: 360px;
        line-height: 1.6;
      }

      /* Rating comparison row */
      #${OVERLAY_ID} .sg-rating-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 4px 0;
      }
      #${OVERLAY_ID} .sg-rating-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      #${OVERLAY_ID} .sg-rating-label {
        font-family: 'Roboto', system-ui, sans-serif;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.38);
      }
      #${OVERLAY_ID} .sg-rating-badge {
        font-family: 'Roboto', system-ui, sans-serif;
        font-size: 12px;
        font-weight: 800;
        padding: 5px 16px;
        border-radius: 20px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        border: 1.5px solid;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${OVERLAY_ID} .sg-rating-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      #${OVERLAY_ID} .sg-arrow {
        font-size: 18px;
        color: rgba(255,255,255,0.28);
        flex-shrink: 0;
      }

      /* Skip note */
      #${OVERLAY_ID} .sg-skip-msg {
        font-family: 'Roboto', system-ui, sans-serif;
        font-size: 11px;
        color: rgba(255,255,255,0.25);
        margin-top: 2px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showBlockOverlay({ reason, rating, userCategory }) {
    injectStyles();
    removeBlockOverlay(); // clear any stale one first

    // Determine badge styles for both the video rating and user category
    const videoRating   = (rating && rating !== "Appropriate") ? rating : "G";
    const userCat       = userCategory || "PG";
    const videoStyle    = MTRCB_BADGE_STYLE[videoRating]  || MTRCB_BADGE_STYLE.SPG;
    const userStyle     = MTRCB_BADGE_STYLE[userCat]      || MTRCB_BADGE_STYLE.PG;

    // Spec block message — filled with the child's category
    const blockMessage =
      `This video is restricted based on your age classification. ` +
      `Your account is classified as <strong style="color:#fff">${userCat}</strong>, ` +
      `while this video requires a higher rating. ` +
      `Access has been blocked to comply with the MTRCB age restrictions.`;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="sg-shield">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
      </div>
      <p class="sg-title">Video Blocked</p>
      <p class="sg-message">${blockMessage}</p>

      <div class="sg-rating-row">
        <div class="sg-rating-item">
          <span class="sg-rating-label">Your category</span>
          <span class="sg-rating-badge"
                style="background:${userStyle.bg};border-color:${userStyle.border};color:${userStyle.color}">
            <span class="sg-rating-dot" style="background:${userStyle.dot}"></span>
            ${userCat}
          </span>
        </div>
        <span class="sg-arrow">→</span>
        <div class="sg-rating-item">
          <span class="sg-rating-label">Video rating</span>
          <span class="sg-rating-badge"
                style="background:${videoStyle.bg};border-color:${videoStyle.border};color:${videoStyle.color}">
            <span class="sg-rating-dot" style="background:${videoStyle.dot}"></span>
            ${videoRating}
          </span>
        </div>
      </div>

      <p class="sg-skip-msg">Skipping to next video…</p>
    `;

    document.documentElement.appendChild(overlay);
  }

  function removeBlockOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  // ── Auto-skip ─────────────────────────────────────────────────────────────
  // Simulates pressing the down-arrow key — YouTube's own Shorts navigation.
  // Reliable across desktop and mobile web layouts.
  function skipToNext() {
    // Method 1: keyboard event (works on desktop YouTube)
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", code: "ArrowDown", keyCode: 40,
      bubbles: true, cancelable: true,
    }));

    // Method 2: click the next-video button as a fallback
    setTimeout(() => {
      const nextBtn =
        document.querySelector('button[aria-label*="next" i]') ||
        document.querySelector('.navigation-button[aria-label*="next" i]') ||
        document.querySelector('#navigation-button-down button');
      if (nextBtn) nextBtn.click();
    }, 100);

    // Method 3: if YouTube SPA nav hasn't fired after 1.5s (rare edge case
    // where ArrowDown and the button both fail), force a URL push to the
    // Shorts feed root so the child isn't stuck on a blocked video.
    setTimeout(() => {
      if (document.getElementById(OVERLAY_ID)) {
        // Overlay still up — skip didn't work, redirect to Shorts feed
        console.warn("[SG] Skip methods failed — redirecting to Shorts feed");
        location.href = "https://www.youtube.com/shorts/";
      }
    }, 1500);
  }

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    // ── Persistent block revisit result ──────────────────────────────────
    if (msg?.type === "SG_CHECK_BLOCKED_RESULT" && msg.videoId === lastVideoId) {
      if (msg.blocked) {
        // Already in the blocked list — show overlay and skip immediately.
        // No need to wait for classification; the decision was already made.
        showBlockOverlay({ reason: msg.reason, rating: msg.rating, userCategory: msg.userCategory });
        setTimeout(() => {
          skipToNext();
          setTimeout(removeBlockOverlay, 800);
        }, 300);
      } else {
        // Not previously blocked — send to the full classification pipeline
        sendToClassify(msg.videoId);
      }
    }

    // ── Live block: fires immediately when background confirms a new flag ──
    if (msg?.type === "SG_BLOCK_SHORT" && msg.videoId === lastVideoId) {
      showBlockOverlay({ reason: msg.reason, rating: msg.rating, userCategory: msg.userCategory });
    }

    // ── Skip: fires ~300ms after the block overlay ─────────────────────────
    if (msg?.type === "SG_SKIP_SHORT" && msg.videoId === lastVideoId) {
      skipToNext();
      // Remove overlay after navigation completes (yt-navigate-finish handles
      // this too, but belt-and-suspenders for slow transitions)
      setTimeout(removeBlockOverlay, 800);
    }
  });

  // Clean up overlay on every SPA navigation (covers the normal skip path)
  window.addEventListener("yt-navigate-finish", removeBlockOverlay);

  // Fire immediately and on YouTube's SPA navigation events
  tryNotify();
  window.addEventListener("yt-navigate-finish", tryNotify);

  // Fallback: watch for URL changes that don't fire the native event.
  let _lastUrl = location.href;
  let _mutationTimer = null;
  new MutationObserver(() => {
    if (location.href === _lastUrl) return;
    _lastUrl = location.href;
    clearTimeout(_mutationTimer);
    _mutationTimer = setTimeout(tryNotify, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
