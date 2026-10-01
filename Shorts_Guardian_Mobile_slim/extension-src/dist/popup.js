(async () => {
  const KEYS = { LOGS: "sg_logs", SETTINGS: "sg_settings" };

  const { sg_logs: logs = [], sg_settings: settings = {} } =
    await chrome.storage.local.get([KEYS.LOGS, KEYS.SETTINGS]);

  // ── Monitoring toggle ──
  const enabledToggle = document.getElementById("enabledToggle");
  const pip           = document.getElementById("pip");
  const monitorText   = document.getElementById("monitorText");

  const setEnabled = (val) => {
    enabledToggle.checked = val;
    pip.className         = val ? "status-pip pip-on" : "status-pip";
    monitorText.textContent = val ? "Monitoring on" : "Monitoring off";
  };

  setEnabled(settings.enabled !== false);

  enabledToggle.addEventListener("change", async () => {
    const val = enabledToggle.checked;
    setEnabled(val);
    const s = (await chrome.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] || {};
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...s, enabled: val } });
  });

  // ── Stats ──
  const sod = new Date();
  sod.setHours(0, 0, 0, 0);
  const todayLogs = logs.filter(l => l.ts >= sod.getTime());
  const flagged   = todayLogs.filter(l => l.flagged).length;
  const flagRate  = todayLogs.length
    ? Math.round(flagged / todayLogs.length * 100)
    : 0;

  document.getElementById("statTotal").textContent   = todayLogs.length;
  document.getElementById("statFlagged").textContent = flagged;

  // Alert banner when >20% of today's Shorts were flagged
  if (flagged > 0 && flagRate >= 20) {
    const banner = document.getElementById("flagBanner");
    const text   = document.getElementById("flagBannerText");
    banner.classList.add("show");
    text.textContent = `${flagRate}% flag rate today — check the dashboard`;
  }

  // ── Model accuracy (MobileNet + DistilBERT combined) ──
  // Mirrors the same combined-accuracy calculation shown on the dashboard:
  // a video counts as "model-predicted concerning" if either model's own
  // signal fired, checked against the parent's ⚠/✓ review in the dashboard.
  const reviewed = logs.filter(l =>
    l.visionMode === "on_device" && (l.reviewVerdict === "flag" || l.reviewVerdict === "safe"));
  let correct = 0;
  reviewed.forEach(l => {
    const predicted = l.categoryTier === "concern" ||
      (l.textSentiment === "NEGATIVE" && l.textSentimentScore > 0.85 && l.sensitivity >= 0.7);
    const truth = l.reviewVerdict === "flag";
    if (predicted === truth) correct++;
  });
  const accuracyPct = reviewed.length ? Math.round(correct / reviewed.length * 100) : 0;

  const accEl    = document.getElementById("popupAccuracy");
  const accSubEl = document.getElementById("popupAccuracySub");
  accEl.textContent = `${accuracyPct}%`;
  accEl.className   = "accuracy-pct" + (reviewed.length && accuracyPct < 70 ? " low" : "");
  accSubEl.textContent = reviewed.length
    ? `Based on ${reviewed.length} review${reviewed.length===1?"":"s"}`
    : "No reviews yet";

  // ── Open dashboard ──
  document.getElementById("openDash").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
