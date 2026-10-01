// ── Shorts Guardian — Parent Dashboard v2 ────────────────────────────────────
// Sidebar-nav, single-page app with four sections: Dashboard, Profile,
// Notifications, Model Performance. Reads/writes the SAME chrome.storage.local
// schema as the v1 dashboard (sg_logs, sg_settings) — background.js and
// offscreen.js are unchanged and untouched by this redesign.
//
// New storage keys introduced (additive only, nothing removed):
//   sg_profile       → { name, age, sex, parentEmail }
//   sg_notifications → [{ id, type, title, desc, ts, read }]

const KEYS = {
  LOGS: "sg_logs",
  SETTINGS: "sg_settings",
  PROFILE: "sg_profile",
  NOTIFS: "sg_notifications",
  NOTIFS_CLEARED_AT: "sg_notifications_cleared_at",
};

const DEFAULT_SETTINGS = {
  pinHash: null, pinSalt: null, enabled: true,
  retentionDays: 30, captureIntervalSec: 12, sensitivity: 0.5,
  blockedCategories: ["weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying","horror_scary","flagged_content"],
  maxLogs: 4000, anthropicApiKey: "", saveSnapshots: true, saveSnapshotsAllShorts: false,
  audioScanEnabled: true, audioClipSeconds: 6,
  emailNotifyEnabled: false, parentEmail: "", ageRating: "PG", syncEnabled: true,
};

const DEFAULT_PROFILE = { name: "", age: "", sex: "", parentEmail: "", gmail: "",
  parentName: "", parentRelationship: "" };

const CATEGORIES = [
  { id: "weapons",           label: "Weapons" },
  { id: "alcohol_tobacco",   label: "Alcohol / tobacco" },
  { id: "self_harm",         label: "Self-harm language" },
  { id: "violence",          label: "Violent language" },
  { id: "substances",        label: "Substances" },
  { id: "sexual_content",    label: "Sexual content" },
  { id: "romance",           label: "Kissing / romance" },
  { id: "bullying",          label: "Bullying / harassment" },
  { id: "horror_scary",      label: "Horror / scary content" },
  { id: "flagged_content",   label: "Flagged content" },
  { id: "vehicles_speed",    label: "Vehicles & speed" },
  { id: "animals",           label: "Animals" },
  { id: "food",              label: "Food" },
  { id: "sports",            label: "Sports" },
  { id: "music_instruments", label: "Music & instruments" },
  { id: "electronics",       label: "Electronics" },
  { id: "nature_outdoors",   label: "Nature & outdoors" },
  { id: "people_fashion",    label: "People & fashion" },
  { id: "other",             label: "Other / unclassified" },
];

const FLAG_NAMES = {
  self_harm: "Self-harm", violence: "Violence", substances: "Substances",
  sexual_content: "Sexual", romance: "Kissing/romance", bullying: "Bullying",
  weapons: "Weapons", alcohol_tobacco: "Alcohol/tobacco",
  horror_scary: "Horror/scary", flagged_content: "Flagged",
};

const CONCERN_IDS = new Set([
  "weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying",
  "horror_scary","flagged_content",
]);

const MTRCB_COLORS = {
  G:           { bg: "#e8f5ee", color: "#2e7d52" },
  PG:          { bg: "#eaf1fb", color: "#3568b0" },
  SPG:         { bg: "#fdf0eb", color: "#c8643c" },
  Appropriate: { bg: "#e8f5ee", color: "#2e7d52" },
};

// ── MTRCB age-category helpers ────────────────────────────────────────────────
// G (5–7): G only · PG (7–13): G + PG · SPG (13–18): G + PG + SPG
// Unknown / <5 defaults to G (strictest) for safety.
function ageToMtrcbCategory(age) {
  const n = parseInt(age, 10);
  if (isNaN(n) || n < 5)  return "G";
  if (n <= 7)             return "G";
  if (n <= 13)            return "PG";
  if (n <= 18)            return "SPG";
  return "SPG";
}
const MTRCB_CAT_META = {
  G:   { label: "General Audience",           range: "Ages 5–7",   allowed: "G only",          dot: "#22c55e", bg: "#e8f5ee", color: "#2e7d52" },
  PG:  { label: "Parental Guidance",          range: "Ages 7–13",  allowed: "G and PG",        dot: "#3b82f6", bg: "#eaf1fb", color: "#3568b0" },
  SPG: { label: "Strong Parental Guidance",   range: "Ages 13–18", allowed: "G, PG, and SPG",  dot: "#ef4444", bg: "#fdf0eb", color: "#c8643c" },
};

// ── Storage helpers ───────────────────────────────────────────────────────────
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }
async function getLogs()         { const d = await getStorage(KEYS.LOGS);     return d[KEYS.LOGS]     || []; }
async function getSettings()     { const d = await getStorage(KEYS.SETTINGS); return { ...DEFAULT_SETTINGS, ...(d[KEYS.SETTINGS] || {}) }; }
async function getProfile()      { const d = await getStorage(KEYS.PROFILE);  return { ...DEFAULT_PROFILE, ...(d[KEYS.PROFILE] || {}) }; }
async function getNotifs()       { const d = await getStorage(KEYS.NOTIFS);   return d[KEYS.NOTIFS]    || []; }

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function addNotification(type, title, desc) {
  const notifs = await getNotifs();
  notifs.unshift({ id: crypto.randomUUID(), type, title, desc, ts: Date.now(), read: false });
  await setStorage({ [KEYS.NOTIFS]: notifs.slice(0, 200) });
}

// ── PIN gate ──────────────────────────────────────────────────────────────────
let pinBuffer = "", creatingPin = false, firstEntry = "";
let pinAttempts = 0;
const MAX_ATTEMPTS  = 3;
const LOCKOUT_SEC   = 30;
let lockoutTimer    = null;
let lockoutEndTime  = 0;

async function initPinGate() {
  const settings = await getSettings();
  const numpad   = document.getElementById("numpad");
  const digits   = [1,2,3,4,5,6,7,8,9,"",0,"⌫"];
  digits.forEach(d => {
    const btn = document.createElement("button");
    btn.textContent = d === "" ? "" : String(d);
    btn.disabled    = d === "";
    if (d === "⌫") btn.classList.add("backspace");
    btn.addEventListener("click", () => handleNumpad(String(d)));
    numpad.appendChild(btn);
  });

  // Forgot PIN modal wiring
  document.getElementById("pinForgotBtn").addEventListener("click", () => {
    document.getElementById("forgotPinModal").classList.remove("u-hidden");
  });
  document.getElementById("forgotCancelBtn").addEventListener("click", () => {
    document.getElementById("forgotPinModal").classList.add("u-hidden");
  });
  document.getElementById("forgotConfirmBtn").addEventListener("click", resetPin);

  if (!settings.pinHash) {
    creatingPin = true;
    document.getElementById("pinPrompt").textContent = "Create a 4-digit parent PIN";
    document.getElementById("createNote").classList.remove("u-hidden");
  } else {
    document.getElementById("pinForgotBtn").classList.remove("u-hidden");
  }
}

function updateDots(n) {
  for (let i = 0; i < 4; i++) {
    document.getElementById("d" + i).className = "pin-dot" + (i < n ? " filled" : "");
  }
}

function showPinError(msg) {
  const el = document.getElementById("pinError");
  el.textContent = msg;
  el.classList.add("shake");
  setTimeout(() => { el.textContent = ""; el.classList.remove("shake"); }, 1800);
}

function setNumpadDisabled(disabled) {
  document.querySelectorAll(".numpad button:not(:disabled[style])").forEach(btn => {
    // Only toggle real digit/backspace buttons, not the invisible placeholder
    if (btn.textContent !== "") btn.disabled = disabled;
  });
}

function updateAttemptInfo() {
  const el = document.getElementById("pinAttemptInfo");
  if (pinAttempts === 0) { el.classList.add("u-hidden"); return; }
  const remaining = MAX_ATTEMPTS - pinAttempts;
  el.classList.remove("u-hidden");
  el.textContent = remaining === 1
    ? "⚠️ 1 attempt remaining before lockout"
    : `${remaining} attempts remaining`;
  el.className = "pin-attempt-info" + (remaining === 1 ? " warn" : "");
}

function startLockout() {
  lockoutEndTime = Date.now() + LOCKOUT_SEC * 1000;
  const lockoutEl   = document.getElementById("pinLockout");
  const dotsWrap    = document.querySelector(".pin-dots");
  const numpadEl    = document.getElementById("numpad");
  const attemptInfo = document.getElementById("pinAttemptInfo");
  const errorEl     = document.getElementById("pinError");

  lockoutEl.classList.remove("u-hidden");
  dotsWrap.style.opacity  = "0.3";
  numpadEl.style.opacity  = "0.3";
  attemptInfo.classList.add("u-hidden");
  errorEl.textContent = "";
  setNumpadDisabled(true);
  pinBuffer = ""; updateDots(0);

  const countdown = document.getElementById("lockoutCountdown");
  lockoutTimer = setInterval(() => {
    const secsLeft = Math.ceil((lockoutEndTime - Date.now()) / 1000);
    if (secsLeft <= 0) {
      clearInterval(lockoutTimer);
      lockoutTimer = null;
      pinAttempts  = 0;
      lockoutEl.classList.add("u-hidden");
      dotsWrap.style.opacity = "";
      numpadEl.style.opacity = "";
      setNumpadDisabled(false);
      updateAttemptInfo();
    } else {
      countdown.textContent = secsLeft;
    }
  }, 250);
}

async function handleNumpad(val) {
  // Block input during lockout
  if (lockoutTimer) return;

  if (val === "⌫") { pinBuffer = pinBuffer.slice(0,-1); updateDots(pinBuffer.length); return; }
  if (pinBuffer.length >= 4) return;
  pinBuffer += val;
  updateDots(pinBuffer.length);
  if (pinBuffer.length < 4) return;

  const settings = await getSettings();

  if (creatingPin) {
    if (!firstEntry) {
      firstEntry = pinBuffer; pinBuffer = ""; updateDots(0);
      document.getElementById("pinPrompt").textContent = "Confirm your PIN";
      return;
    }
    if (pinBuffer !== firstEntry) {
      showPinError("PINs don't match. Please try again.");
      pinBuffer = ""; firstEntry = ""; updateDots(0);
      document.getElementById("pinPrompt").textContent = "Create a 4-digit parent PIN";
      return;
    }
    const salt = crypto.randomUUID(), hash = await sha256(pinBuffer + salt);
    await setStorage({ [KEYS.SETTINGS]: { ...settings, pinHash: hash, pinSalt: salt } });
    unlock(); return;
  }

  const hash = await sha256(pinBuffer + settings.pinSalt);
  if (hash === settings.pinHash) {
    pinAttempts = 0;
    updateAttemptInfo();
    unlock();
    return;
  }

  // Wrong PIN
  pinAttempts++;
  pinBuffer = ""; updateDots(0);

  if (pinAttempts >= MAX_ATTEMPTS) {
    startLockout();
  } else {
    showPinError("Incorrect PIN. Please try again.");
    updateAttemptInfo();
  }
}

function unlock() {
  document.getElementById("pinGate").classList.add("u-hidden");
  document.getElementById("app").classList.remove("u-hidden");
  loadApp();
}

function lockDashboard() {
  pinBuffer = ""; firstEntry = ""; creatingPin = false;
  pinAttempts = 0;
  if (lockoutTimer) { clearInterval(lockoutTimer); lockoutTimer = null; }
  document.getElementById("pinLockout").classList.add("u-hidden");
  document.getElementById("pinAttemptInfo").classList.add("u-hidden");
  document.getElementById("pinError").textContent = "";
  document.querySelector(".pin-dots").style.opacity = "";
  document.getElementById("numpad").style.opacity = "";
  setNumpadDisabled(false);
  updateDots(0);
  document.getElementById("pinPrompt").textContent = "Enter your PIN to continue";
  document.getElementById("app").classList.add("u-hidden");
  document.getElementById("pinGate").classList.remove("u-hidden");
}

async function resetPin() {
  document.getElementById("forgotPinModal").classList.add("u-hidden");
  const settings = await getSettings();
  await setStorage({ [KEYS.SETTINGS]: { ...settings, pinHash: null, pinSalt: null }, [KEYS.LOGS]: [] });
  location.reload();
}

// ── Sidebar routing ───────────────────────────────────────────────────────────
function setupRouting() {
  document.querySelectorAll(".nav-item[data-page]").forEach(btn => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.page));
  });
}
async function navigateTo(pageId) {
  document.querySelectorAll(".nav-item[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === pageId));
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${pageId}`));
  if (pageId === "notifications") await markNotificationsRead();
}

// ── App state ─────────────────────────────────────────────────────────────────
let allLogs = [], settings = {}, profile = {}, notifs = [], page = 0;
const PAGE_SIZE = 25;

async function loadApp() {
  [allLogs, settings, profile, notifs] = await Promise.all([getLogs(), getSettings(), getProfile(), getNotifs()]);
  setupRouting();
  setupSidebarToggle();
  renderDashboardPage();
  renderProfilePage();
  renderNotificationsPage();
  renderPerformancePage();
  wireGlobalEvents();
}

function dayStart(ts) { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function todayStart() { const d = new Date();    d.setHours(0,0,0,0); return d.getTime(); }

// ════════════════════════════════════════════════════════════════════════
// DASHBOARD PAGE
// ════════════════════════════════════════════════════════════════════════
function renderDashboardPage() {
  renderStats();
  renderCategoryBars();
  renderDonut();
  renderTimeline();
  renderTable();
  renderPrefsSummary();
  const summaryPanel = document.getElementById("dashSummaryPanel");
  if (summaryPanel && !summaryPanel.classList.contains("u-hidden")) renderScanSummary();
}

function renderStats() {
  const today     = todayStart();
  const todayLogs = allLogs.filter(l => l.ts >= today);
  const flagged   = todayLogs.filter(l => l.flagged).length;
  const inappropriate = todayLogs.filter(l => l.finalVerdict === "Inappropriate").length;

  document.getElementById("kpiToday").textContent        = todayLogs.length;
  document.getElementById("kpiFlagged").textContent      = flagged;
  document.getElementById("kpiInappropriate").textContent = inappropriate;
  document.getElementById("kpiFlagRate").textContent     =
    todayLogs.length ? `${Math.round(flagged / todayLogs.length * 100)}% of today's videos` : "";
  document.getElementById("kpiTotal").textContent        = allLogs.length;
}

function renderCategoryBars() {
  const counts = {};
  allLogs.forEach(l => { counts[l.category] = (counts[l.category]||0) + 1; });
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,8);
  const max    = sorted[0]?.[1] || 1;
  const container = document.getElementById("categoryBars");
  container.innerHTML = sorted.map(([id,n]) => {
    const cat = CATEGORIES.find(c => c.id === id) || { label: id };
    const pct = Math.round(n / max * 100);
    const cls = CONCERN_IDS.has(id) ? "concern" : "";
    return `<div class="bar-row">
      <span class="bar-label" title="${cat.label}">${cat.label}</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="bar-count">${n}</span>
    </div>`;
  }).join("") || '<div style="color:var(--muted);font-size:14px;padding:8px 0">No videos checked yet</div>';
}

function renderDonut() {
  const flagged = allLogs.filter(l => l.flagged).length;
  const safe    = allLogs.length - flagged;
  const canvas  = document.getElementById("donut");
  const ctx     = canvas.getContext("2d");
  const size = canvas.width;
  const [cx,cy,r,ri] = [size/2, size/2, size*0.385, size*0.27];
  ctx.clearRect(0,0,size,size);
  const slices = [
    { val: flagged, color: "#c8643c", label: "Flagged" },
    { val: safe,    color: "#2f6f62", label: "Safe" },
    { val: allLogs.length ? 0 : 1, color: "#e0e6e3", label: "No data" },
  ].filter(s => s.val > 0);
  const total = slices.reduce((s,x) => s + x.val, 0);
  let angle = -Math.PI / 2;
  slices.forEach(s => {
    const sweep = (s.val / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,angle,angle+sweep); ctx.closePath();
    ctx.fillStyle = s.color; ctx.fill(); angle += sweep;
  });
  ctx.beginPath(); ctx.arc(cx,cy,ri,0,2*Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.fillStyle = "#182620"; ctx.font = "bold 30px 'Sora','Segoe UI',system-ui";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(allLogs.length, cx, cy-10);
  ctx.font = "14px 'Segoe UI',system-ui"; ctx.fillStyle = "#647A72";
  ctx.fillText("total checked", cx, cy+18);
  document.getElementById("donutLegend").innerHTML =
    slices.filter(s => s.label !== "No data").map(s =>
      `<div class="legend-row"><span class="legend-dot" style="background:${s.color}"></span>${s.label}: <strong>${s.val}</strong></div>`
    ).join("");
}

function renderTimeline() {
  const container = document.getElementById("dayBars");
  const days = 30, buckets = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
    buckets[d.getTime()] = { total: 0, flagged: 0 };
  }
  allLogs.forEach(l => {
    const key = dayStart(l.ts);
    if (buckets[key]) { buckets[key].total++; if (l.flagged) buckets[key].flagged++; }
  });
  const keys = Object.keys(buckets).map(Number).sort((a,b) => a-b);
  const maxTotal = Math.max(...keys.map(k => buckets[k].total), 1);
  container.innerHTML = keys.map(k => {
    const b = buckets[k], d = new Date(k);
    const label  = `${d.getMonth()+1}/${d.getDate()}`;
    const totalH = Math.round(b.total   / maxTotal * 100);
    const flagH  = Math.round(b.flagged / maxTotal * 100);
    const safeH  = totalH - flagH;
    return `<div class="day-bar-wrap" title="${label}: ${b.total} seen, ${b.flagged} flagged">
      ${flagH  > 0 ? `<div class="day-bar-seg" style="background:var(--amber);height:${flagH}px"></div>` : ""}
      ${safeH  > 0 ? `<div class="day-bar-seg" style="background:var(--teal);height:${safeH}px"></div>` : ""}
      ${totalH === 0 ? `<div class="day-bar-seg" style="background:var(--border);height:2px"></div>` : ""}
      <div class="day-bar-date">${label}</div>
    </div>`;
  }).join("");
}

function mtrcbBadge(rating) {
  const c = MTRCB_COLORS[rating] || { bg: "#f0f4f1", color: "#647A72" };
  return `<span class="mtrcb-badge" style="background:${c.bg};color:${c.color}">${rating||"—"}</span>`;
}
function scorePill(score) {
  if (score == null) return "—";
  const pct  = Math.round(score * 100);
  const color = pct >= 50 ? "#c8643c" : pct >= 25 ? "#c8a03c" : "#2f6f62";
  return `<div class="score-bar-wrap" title="Concern score: ${pct}%">
    <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="score-bar-label" style="color:${color}">${pct}%</span>
  </div>`;
}

// "G" and "Appropriate" are the same safety tier from a parent's point of
// view — deriveMtrcbRating() (background.js) only stamps a video "G" when a
// specific G-tier flag fires (e.g. vehicles_speed); everything else with no
// concerning findings is stored as "Appropriate". This mirrors the app's own
// MTRCB_ALLOWED hierarchy (a "G" viewer is allowed both "G" and "Appropriate"
// videos), so the rating filter treats them as one group instead of two
// disjoint buckets — otherwise "G only" hides nearly all genuinely safe
// Shorts, and "Appropriate only" misses the ones that happened to trigger a
// G-tier flag.
const RATING_FILTER_GROUPS = {
  G:           new Set(["G", "Appropriate"]),
  Appropriate: new Set(["G", "Appropriate"]),
  PG:          new Set(["PG"]),
  SPG:         new Set(["SPG"]),
};

function getFilteredLogs() {
  const q        = (document.getElementById("logSearch")?.value || "").toLowerCase();
  const filter   = document.getElementById("logFilter")?.value  || "all";
  const daysBack = parseInt(document.getElementById("dateFilter")?.value || "30", 10);
  const rating   = document.getElementById("ratingFilter")?.value || "all";
  const cutoff   = daysBack > 0 ? Date.now() - daysBack * 86_400_000 : 0;
  return allLogs.filter(l => {
    if (l.ts < cutoff) return false;
    if (filter === "flagged"       && !l.flagged) return false;
    if (filter === "safe"          &&  l.flagged) return false;
    if (filter === "inappropriate" && l.finalVerdict !== "Inappropriate") return false;
    if (rating !== "all") {
      const allowed = RATING_FILTER_GROUPS[rating] || new Set([rating]);
      if (!allowed.has(l.mtrcbRating)) return false;
    }
    if (q && !((l.title  ||"").toLowerCase().includes(q) ||
               (l.channel||"").toLowerCase().includes(q))) return false;
    return true;
  }).slice().reverse();
}

function renderTable() {
  const filtered   = getFilteredLogs();
  const body       = document.getElementById("logBody");
  const emptyState = document.getElementById("emptyState");
  const start      = page * PAGE_SIZE;
  const slice      = filtered.slice(start, start + PAGE_SIZE);

  // Total videos detected, live — allLogs is append-only (oldest first), so
  // its length is a running count of every Short ever checked.
  const totalEl = document.getElementById("totalDetectedCount");
  if (totalEl) totalEl.textContent = allLogs.length;
  const totalLabelEl = document.getElementById("totalDetectedLabel");
  if (totalLabelEl) totalLabelEl.textContent = allLogs.length === 1 ? "video" : "videos";

  // Detection number = this entry's absolute position in the full history
  // (oldest = #1, counting up), independent of the current filter/sort/page —
  // a stable "video #N" tag rather than a row index that shifts around.
  const detectionNoByLog = new Map();
  allLogs.forEach((l, i) => detectionNoByLog.set(l, i + 1));

  if (filtered.length === 0) {
    body.innerHTML = ""; emptyState.classList.remove("u-hidden");
  } else {
    emptyState.classList.add("u-hidden");
    body.innerHTML = slice.map(l => {
      const d    = new Date(l.ts);
      const time = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}`;
      const cat  = CATEGORIES.find(c => c.id === l.category) || { label: l.category || "—" };
      const flags = [...(l.textFlags||[]), ...(l.audioFlags||[])]
        .filter((f,i,arr) => arr.indexOf(f) === i)
        .map(f => `<span class="pill concern">${FLAG_NAMES[f]||f}</span>`).join("");
      const catCls = CONCERN_IDS.has(l.category) ? "concern" : "";
      const snapCell = l.snapshot
        ? `<img class="snap-thumb" src="${l.snapshot}" alt="Snapshot" data-full="${l.snapshot}" />`
        : `<div class="snap-placeholder"></div>`;
      const checks = l.checksRun || { title: true, image: l.visionMode && l.visionMode !== "none", audio: false };
      const imgModeLabel = l.visionMode === "claude" ? "Cloud picture checker" : l.visionMode === "on_device" ? "on-device picture checker" : "didn't run";
      const audModeLabel = l.audioMode === "on_device" ? "on-device speech checker" : l.audioMode === "unavailable" ? "attempted, no speech found" : "didn't run";
      const checkBadges = `
        <span class="scan-badge ${checks.title?"ran":""}" title="Words checked: ran">T</span>
        <span class="scan-badge ${checks.image?"ran":""}" title="Pictures checked: ${imgModeLabel}">I</span>
        <span class="scan-badge ${checks.audio?"ran":""}" title="Speech checked: ${audModeLabel}${l.transcript?' — "'+l.transcript.slice(0,120)+(l.transcript.length>120?'…':'')+'"':''}">A</span>`;
      const verdictCls = l.finalVerdict === "Inappropriate" ? "verdict-bad" : "verdict-ok";
      const detectionNo = detectionNoByLog.get(l) || "—";
      return `<tr class="${l.flagged?"flagged-row":""}">
        <td class="detect-no">${detectionNo}</td>
        <td>${snapCell}</td>
        <td style="white-space:nowrap;font-size:12.5px;color:var(--muted)">${time}</td>
        <td class="title-cell">
          <a href="${l.url}" target="_blank" rel="noopener">${l.title||"(no title)"}</a>
          <div class="channel-text">${l.channel||""}</div>
        </td>
        <td><span class="pill ${catCls}">${cat.label}</span></td>
        <td>${flags||"—"}</td>
        <td>${checkBadges}</td>
        <td>${mtrcbBadge(l.mtrcbRating)}</td>
        <td>${scorePill(l.weightedScore)}</td>
        <td><span class="flag-badge ${verdictCls}">${l.finalVerdict||(l.flagged?"Inappropriate":"Appropriate")}</span></td>
        <td><span class="flag-badge ${l.flagged?"flag":"ok"}">${l.flagged?"⚑ Flagged":"✓ Safe"}</span></td>
      </tr>`;
    }).join("");
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pg = document.getElementById("pagination");
  if (totalPages <= 1) { pg.innerHTML = ""; return; }
  const btns = [];
  btns.push(`<button class="pg-btn" data-page="${page-1}" ${page===0?"disabled":""}>‹</button>`);
  for (let i = 0; i < totalPages; i++) {
    if (totalPages > 7 && Math.abs(i-page) > 2 && i !== 0 && i !== totalPages-1) {
      if (i === 1 || i === totalPages-2) btns.push(`<button class="pg-btn" disabled>…</button>`);
      continue;
    }
    btns.push(`<button class="pg-btn ${i===page?"active":""}" data-page="${i}">${i+1}</button>`);
  }
  btns.push(`<button class="pg-btn" data-page="${page+1}" ${page===totalPages-1?"disabled":""}>›</button>`);
  pg.innerHTML = btns.join("");
}

function sensitivityLabel(v) {
  const val = parseFloat(v);
  if (val <= 0.3) return "Low — only the most obvious content";
  if (val <= 0.6) return "Medium — recommended for most families";
  return "High — flags broadly, even mild references";
}

function renderPrefsSummary() {
  document.getElementById("prefAgeRating").textContent  = settings.ageRating || "PG";
  document.getElementById("prefSensitivity").textContent = sensitivityLabel(settings.sensitivity ?? 0.5);
  document.getElementById("prefInterval").textContent    = `Every ${settings.captureIntervalSec || 12} seconds`;
  document.getElementById("prefAudio").textContent       = settings.audioScanEnabled !== false ? "On" : "Off";
  document.getElementById("prefSnapshots").textContent   =
    settings.saveSnapshotsAllShorts ? "All videos" : (settings.saveSnapshots !== false ? "Flagged videos only" : "Off");
  document.getElementById("prefEmail").textContent       = settings.emailNotifyEnabled ? "On" : "Off";

  const blocked = settings.blockedCategories || [];
  const container = document.getElementById("flaggedCategoriesList");
  container.innerHTML = blocked.length
    ? blocked.map(id => {
        const cat = CATEGORIES.find(c => c.id === id) || { label: id };
        return `<span class="cat-flag-chip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.6 17.5a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/></svg>
          ${cat.label}
        </span>`;
      }).join("")
    : `<span style="color:var(--muted);font-size:13.5px">No categories selected — open Profile to update your child's age rating.</span>`;
}

// ════════════════════════════════════════════════════════════════════════
// PROFILE PAGE
// ════════════════════════════════════════════════════════════════════════
function renderProfilePage() {
  // Child summary card
  const initial = (profile.name || "?").trim().charAt(0).toUpperCase() || "?";
  document.getElementById("profileAvatarInitial").textContent = initial;
  document.getElementById("profileDisplayName").textContent   = profile.name || "Add your child's name";
  document.getElementById("profileDisplayAge").textContent    = profile.age || "—";
  document.getElementById("profileDisplaySex").textContent    = profile.sex || "—";
  document.getElementById("profileDisplayEmail").textContent  = profile.gmail || profile.parentEmail || "Not set";

  // Child fields
  document.getElementById("childName").value  = profile.name  || "";
  document.getElementById("childAge").value   = profile.age   || "";
  document.getElementById("childSex").value   = profile.sex   || "";

  // Parent summary card
  const pInitial = (profile.parentName || "P").trim().charAt(0).toUpperCase();
  document.getElementById("parentAvatarInitial").textContent  = pInitial;
  document.getElementById("parentDisplayName").textContent    = profile.parentName || "Add parent name";
  document.getElementById("parentDisplayRelationship").textContent = profile.parentRelationship || "";

  // Parent fields
  document.getElementById("parentName").value         = profile.parentName         || "";
  document.getElementById("parentRelationship").value = profile.parentRelationship || "";
  document.getElementById("childParentEmail").value   = profile.parentEmail || settings.parentEmail || "";

  // Age-based MTRCB badge in child info form
  updateAgeMtrcbBadge(profile.age);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Inline field-error helpers ──────────────────────────────────────────────
function setFieldError(fieldId, msg) {
  const input = document.getElementById(fieldId);
  const err   = document.getElementById("err-" + fieldId);
  if (input) input.classList.add("invalid");
  if (err)   { err.textContent = msg; err.classList.add("show"); }
}
function clearFieldError(fieldId) {
  const input = document.getElementById(fieldId);
  const err   = document.getElementById("err-" + fieldId);
  if (input) input.classList.remove("invalid");
  if (err)   { err.textContent = ""; err.classList.remove("show"); }
}
function clearFieldErrors(fieldIds) { fieldIds.forEach(clearFieldError); }

async function saveProfile() {
  // Saves parent/guardian info + email — name, relationship, and email are
  // all required so alert emails always have somewhere to go.
  const parentName         = document.getElementById("parentName").value.trim();
  const parentRelationship = document.getElementById("parentRelationship").value;
  const parentEmail        = document.getElementById("childParentEmail").value.trim();

  clearFieldErrors(["parentName", "parentRelationship", "childParentEmail"]);
  let hasError = false;

  if (!parentName) {
    setFieldError("parentName", "Parent/Guardian name is required.");
    hasError = true;
  }
  if (!parentRelationship) {
    setFieldError("parentRelationship", "Please select your relationship to the child");
    hasError = true;
  }
  if (!parentEmail) {
    setFieldError("childParentEmail", "Email address is required");
    hasError = true;
  } else if (!EMAIL_RE.test(parentEmail)) {
    setFieldError("childParentEmail", "Please enter a valid email address");
    hasError = true;
  }

  if (hasError) {
    showFeedback("profileMsg", "Please complete all required fields", true);
    return;
  }

  const updated = {
    ...profile,
    parentName:         parentName,
    parentRelationship: parentRelationship,
    parentEmail:        parentEmail,
    gmail:              parentEmail,
  };
  await setStorage({ [KEYS.PROFILE]: updated });
  // Keep settings.parentEmail in sync so background.js email alerts use the same address
  const updatedSettings = { ...settings, parentEmail: updated.parentEmail };
  await setStorage({ [KEYS.SETTINGS]: updatedSettings });
  settings = updatedSettings;
  profile  = updated;
  renderProfilePage();
  renderPrefsSummary();
  showFeedback("profileMsg", "Parent info saved ✓");
}

async function saveChild() {
  const name = document.getElementById("childName").value.trim();
  const age  = document.getElementById("childAge").value;
  const sex  = document.getElementById("childSex").value;

  clearFieldErrors(["childName", "childAge"]);
  let hasError = false;

  if (!name) {
    setFieldError("childName", "Child's full name is required");
    hasError = true;
  }
  if (!age) {
    setFieldError("childAge", "Child's age is required");
    hasError = true;
  }

  if (hasError) {
    showFeedback("childMsg", "Please complete all required fields", true);
    return;
  }

  const updated = { ...profile, name: name, age: age, sex: sex };
  await setStorage({ [KEYS.PROFILE]: updated });
  profile = updated;
  renderProfilePage();
  showFeedback("childMsg", "Child info saved ✓");
}

async function changePin() {
  const oldVal     = document.getElementById("oldPin").value;
  const newVal     = document.getElementById("newPin").value;
  const confirmVal = document.getElementById("confirmPin").value;

  clearFieldErrors(["oldPin", "newPin", "confirmPin"]);
  let hasError = false;

  if (!oldVal)     { setFieldError("oldPin",     "Current PIN is required"); hasError = true; }
  if (!newVal)     { setFieldError("newPin",     "New PIN is required");     hasError = true; }
  if (!confirmVal) { setFieldError("confirmPin", "Please confirm the new PIN"); hasError = true; }

  if (hasError) {
    showFeedback("pinChangeMsg", "Please complete all required fields", true);
    return;
  }

  if (newVal.length !== 4 || !/^\d{4}$/.test(newVal)) {
    setFieldError("newPin", "PIN must be exactly 4 digits");
    showFeedback("pinChangeMsg", "PIN must be exactly 4 digits", true); return;
  }
  if (newVal !== confirmVal) {
    setFieldError("confirmPin", "New PINs don't match");
    showFeedback("pinChangeMsg", "New PINs don't match", true); return;
  }
  const oldHash = await sha256(oldVal + settings.pinSalt);
  if (oldHash !== settings.pinHash) {
    setFieldError("oldPin", "Current PIN is incorrect");
    showFeedback("pinChangeMsg", "Current PIN is incorrect", true); return;
  }
  const salt = crypto.randomUUID(), hash = await sha256(newVal + salt);
  await setStorage({ [KEYS.SETTINGS]: { ...settings, pinHash: hash, pinSalt: salt } });
  settings = { ...settings, pinHash: hash, pinSalt: salt };
  ["oldPin","newPin","confirmPin"].forEach(id => { document.getElementById(id).value = ""; });
  clearFieldErrors(["oldPin", "newPin", "confirmPin"]);
  showFeedback("pinChangeMsg", "PIN updated ✓");
  await addNotification("pin", "Dashboard PIN changed", "The parent dashboard PIN was updated successfully.");
  notifs = await getNotifs();
  renderNotificationsPage();
}

function showFeedback(id, text, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = "feedback" + (isError ? " err" : "");
  setTimeout(() => { el.textContent = ""; }, 2500);
}

// ════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS PAGE
// ════════════════════════════════════════════════════════════════════════
const NOTIF_ICONS = {
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.6 17.5a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/></svg>`,
  pin:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  safe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6 9 17l-5-5"/></svg>`,
};

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000), hr = Math.floor(diff / 3600000), day = Math.floor(diff / 86400000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24)  return `${hr}h ago`;
  if (day < 7)  return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function buildFlaggedNotifications() {
  // Surface the most recent flagged logs as notifications, merged with any
  // stored notifications (PIN changes etc.), de-duplicated by videoId.
  const flaggedLogs = allLogs.filter(l => l.flagged).slice(-30).reverse();
  const fromLogs = flaggedLogs.map(l => ({
    id: `log-${l.videoId}-${l.ts}`,
    type: "flag",
    title: `Flagged: "${(l.title || "Untitled").slice(0,60)}"`,
    desc: `Rated ${l.mtrcbRating || "—"} · ${[...(l.textFlags||[]), ...(l.audioFlags||[])].map(f=>FLAG_NAMES[f]||f).join(", ") || l.category} · on ${l.channel || "unknown channel"}`,
    ts: l.ts,
    read: true,
  }));
  const stored = await getNotifs();
  // "Clear all" stamps a cutoff timestamp — flagged-log notifications are
  // re-derived from allLogs on every render, so without this cutoff they'd
  // reappear immediately after being cleared, making the button look broken.
  const clearedAtData = await getStorage(KEYS.NOTIFS_CLEARED_AT);
  const clearedAt = clearedAtData[KEYS.NOTIFS_CLEARED_AT] || 0;
  const merged = [...stored, ...fromLogs]
    .filter((n,i,arr) => arr.findIndex(x => x.id === n.id) === i)
    .filter(n => n.ts > clearedAt)
    .sort((a,b) => b.ts - a.ts);
  return merged;
}

async function renderNotificationsPage() {
  const merged = await buildFlaggedNotifications();
  notifs = merged;
  const unreadCount = merged.filter(n => !n.read).length;
  const badge = document.getElementById("navNotifBadge");
  if (unreadCount > 0) { badge.classList.remove("u-hidden"); badge.classList.add("u-inline-block"); badge.textContent = unreadCount > 99 ? "99+" : unreadCount; }
  else { badge.classList.add("u-hidden"); badge.classList.remove("u-inline-block"); }

  const list  = document.getElementById("notifList");
  const empty = document.getElementById("notifEmptyState");
  if (merged.length === 0) {
    list.innerHTML = ""; empty.classList.remove("u-hidden"); return;
  }
  empty.classList.add("u-hidden");
  list.innerHTML = merged.slice(0, 100).map(n => `
    <div class="notif-item ${n.read ? "" : "unread"}">
      <div class="notif-icon ${n.type}">${NOTIF_ICONS[n.type] || NOTIF_ICONS.safe}</div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-desc">${n.desc}</div>
      </div>
      <div class="notif-time">${timeAgo(n.ts)}</div>
    </div>
  `).join("");
}

function toggleDashSummary() {
  const panel = document.getElementById("dashSummaryPanel");
  const btn   = document.getElementById("btnDashSummary");
  const willShow = panel.classList.contains("u-hidden");
  panel.classList.toggle("u-hidden");
  btn.textContent = willShow ? "Hide summary" : "Summary information";
  if (willShow) renderScanSummary();
}

function renderScanSummary() {
  const total = allLogs.length;
  const flagged = allLogs.filter(l => l.flagged).length;
  const inappropriate = allLogs.filter(l => l.finalVerdict === "Inappropriate").length;
  const safe = total - flagged;
  const pct = (n) => total ? Math.round(n / total * 100) : 0;

  // ── KPI row: scanned totals + percentages ──────────────────────────────
  const kpiRow = document.getElementById("summaryKpiRow");
  kpiRow.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-accent"></div>
      <div class="kpi-num">${total}</div>
      <div class="kpi-label">Total Shorts scanned</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-accent"></div>
      <div class="kpi-num">${pct(safe)}%</div>
      <div class="kpi-label">Safe (${safe} of ${total})</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-accent"></div>
      <div class="kpi-num">${pct(flagged)}%</div>
      <div class="kpi-label">Flagged for review (${flagged})</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-accent"></div>
      <div class="kpi-num">${pct(inappropriate)}%</div>
      <div class="kpi-label">Marked inappropriate (${inappropriate})</div>
    </div>`;

  // ── MTRCB rating breakdown ──────────────────────────────────────────────
  const ratingCounts = {};
  allLogs.forEach(l => { const r = l.mtrcbRating || "Unrated"; ratingCounts[r] = (ratingCounts[r]||0) + 1; });
  const ratingSorted = Object.entries(ratingCounts).sort((a,b) => b[1]-a[1]);
  const ratingMax = ratingSorted[0]?.[1] || 1;
  document.getElementById("summaryRatingBars").innerHTML = ratingSorted.map(([rating,n]) => {
    const barPct = Math.round(n / ratingMax * 100);
    const sharePct = pct(n);
    return `<div class="bar-row">
      <span class="bar-label" title="${rating}">${rating}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${barPct}%"></div></div>
      <span class="bar-count">${n} (${sharePct}%)</span>
    </div>`;
  }).join("") || '<div style="color:var(--muted);font-size:14px;padding:8px 0">No videos checked yet</div>';

  // ── Detected / classified content breakdown ─────────────────────────────
  // l.category is the AI's classification of the Short's subject matter;
  // CONCERN_IDS marks which of those classifications are things a parent
  // would want flagged (weapons, violence, sexual content, etc.).
  const catCounts = {};
  allLogs.forEach(l => { const c = l.category || "other"; catCounts[c] = (catCounts[c]||0) + 1; });
  const catSorted = Object.entries(catCounts).sort((a,b) => b[1]-a[1]);
  const catMax = catSorted[0]?.[1] || 1;
  document.getElementById("summaryCategoryBars").innerHTML = catSorted.map(([id,n]) => {
    const cat = CATEGORIES.find(c => c.id === id) || { label: id };
    const barPct = Math.round(n / catMax * 100);
    const sharePct = pct(n);
    const cls = CONCERN_IDS.has(id) ? "concern" : "";
    return `<div class="bar-row">
      <span class="bar-label" title="${cat.label}">${cat.label}</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${barPct}%"></div></div>
      <span class="bar-count">${n} (${sharePct}%)</span>
    </div>`;
  }).join("") || '<div style="color:var(--muted);font-size:14px;padding:8px 0">No videos checked yet</div>';
}

async function markNotificationsRead() {
  const stored = await getNotifs();
  const updated = stored.map(n => ({ ...n, read: true }));
  await setStorage({ [KEYS.NOTIFS]: updated });
  document.getElementById("navNotifBadge").classList.add("u-hidden");
}

function openClearNotifsModal() {
  document.getElementById("clearNotifsModal")?.classList.remove("u-hidden");
}
function closeClearNotifsModal() {
  document.getElementById("clearNotifsModal")?.classList.add("u-hidden");
}

async function clearAllNotifications() {
  // Wipes stored notifications and stamps a "cleared at" cutoff so that
  // flagged-video notifications (which are re-derived from allLogs on every
  // render — see buildFlaggedNotifications) don't instantly reappear.
  await setStorage({ [KEYS.NOTIFS]: [], [KEYS.NOTIFS_CLEARED_AT]: Date.now() });
  notifs = [];
  closeClearNotifsModal();
  await renderNotificationsPage();
}

// ── Clear Activity History ──────────────────────────────────────────────────
function openClearHistoryModal() {
  document.getElementById("clearHistoryModal")?.classList.remove("u-hidden");
}
function closeClearHistoryModal() {
  document.getElementById("clearHistoryModal")?.classList.add("u-hidden");
}
async function clearActivityHistory() {
  await setStorage({ [KEYS.LOGS]: [] });
  allLogs = [];
  page = 0;
  closeClearHistoryModal();
  renderTable();
  renderAlgorithmComparison();
  renderPerformancePage();
}

// ════════════════════════════════════════════════════════════════════════
// MODEL PERFORMANCE PAGE
// ════════════════════════════════════════════════════════════════════════

// ── Confusion-matrix metrics — fully automatic, no manual labeling ─────────
// "Ground truth" here is the system's own combined verdict (finalVerdict),
// which background.js already derives automatically from every signal it
// has — title/channel keywords, audio transcript keywords, image category
// tier, and the weighted score. No parent has to tag anything: MobileNet and
// DistilBERT's own outputs are simply checked against what the full pipeline
// (title + image + audio + score, working together) already decided.
// predictFn(l) returns whether THIS model's own signal alone called it
// concerning for that entry. Everything is derived live from allLogs.
function confusionMetrics(logs, predictFn, truthFn) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  logs.forEach(l => {
    const pred  = predictFn(l);
    const truth = truthFn(l);
    if (pred && truth)        tp++;
    else if (pred && !truth)  fp++;
    else if (!pred && truth)  fn++;
    else                      tn++;
  });
  const n = tp + fp + fn + tn;
  // Accuracy = (TP + TN) / (TP + TN + FP + FN) × 100
  const accuracy  = n ? (tp + tn) / n : null;
  const precision = (tp + fp) ? tp / (tp + fp) : null;
  const recall    = (tp + fn) ? tp / (tp + fn) : null;
  const f1        = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall) : null;
  return { tp, fp, fn, tn, n, accuracy, precision, recall, f1 };
}

function renderAlgoCard(prefix, m, responseMs) {
  const pctOrDash = (n) => n == null || isNaN(n) ? "—" : `${Math.round(n * 100)}%`;
  const accEl = document.getElementById(`algo${prefix}Accuracy`);
  if (!accEl) return;
  accEl.textContent = m.n ? pctOrDash(m.accuracy) : "—";
  accEl.classList.toggle("low", m.n > 0 && m.accuracy != null && m.accuracy < 0.7);
  // Error Rate = 100% − Accuracy = (FP + FN) / (TP + TN + FP + FN) × 100
  const errorRate = m.n ? 1 - m.accuracy : null;
  document.getElementById(`algo${prefix}Response`).textContent  = responseMs == null ? "—" : `${Math.round(responseMs)} ms`;
  document.getElementById(`algo${prefix}ErrorRate`).textContent = pctOrDash(errorRate);
  document.getElementById(`algo${prefix}Samples`).textContent   = m.n;
  document.getElementById(`algo${prefix}TP`).textContent = `TP ${m.tp}`;
  document.getElementById(`algo${prefix}FP`).textContent = `FP ${m.fp}`;
  document.getElementById(`algo${prefix}FN`).textContent = `FN ${m.fn}`;
  document.getElementById(`algo${prefix}TN`).textContent = `TN ${m.tn}`;
}

// Average of a numeric field across logs where it was actually measured
// (performance.now() timings recorded in offscreen.js at classification
// time) — never estimated or hardcoded.
function avgMs(logs, field) {
  const vals = logs.map(l => l[field]).filter(v => typeof v === "number" && !isNaN(v));
  return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
}

// The predicate rules below mirror the exact escalation logic handleClassify()
// applies in background.js, so "predicted concerning" reflects what each
// model actually contributed to a real flag decision — not a re-guess.
// "systemTruth" is finalVerdict, which itself is 100% automatic (title +
// image + audio + weighted score) — no ⚠/✓ button, no manual step, anywhere.
function renderAlgorithmComparison() {
  const onDeviceLogs = allLogs.filter(l => l.visionMode === "on_device");

  const systemTruth = l => l.finalVerdict === "Inappropriate";
  const mnPredict    = l => l.categoryTier === "concern";
  const dbPredict    = l => l.textSentiment === "NEGATIVE" && l.textSentimentScore > 0.85 && l.sensitivity >= 0.7;
  const combPredict  = l => mnPredict(l) || dbPredict(l);

  // Response time is a pure performance measurement, averaged across every
  // on-device run that recorded a timing.
  const mnResponseMs   = avgMs(onDeviceLogs, "imageInferenceMs");
  const dbResponseMs   = avgMs(onDeviceLogs, "textInferenceMs");
  const bothTimed      = onDeviceLogs.filter(l =>
    typeof l.imageInferenceMs === "number" && typeof l.textInferenceMs === "number");
  const combResponseMs = bothTimed.length
    ? bothTimed.reduce((a,l) => a + l.imageInferenceMs + l.textInferenceMs, 0) / bothTimed.length
    : null;

  renderAlgoCard("Mn",   confusionMetrics(onDeviceLogs, mnPredict,   systemTruth), mnResponseMs);
  renderAlgoCard("Db",   confusionMetrics(onDeviceLogs, dbPredict,   systemTruth), dbResponseMs);
  renderAlgoCard("Comb", confusionMetrics(onDeviceLogs, combPredict, systemTruth), combResponseMs);
}

function drawRing(canvasId, pct, color) {
  const canvas = document.getElementById(canvasId);
  const ctx    = canvas.getContext("2d");
  const size   = canvas.width;
  const [cx,cy,r] = [size/2, size/2, size*0.42];
  const lineW  = size * 0.11;
  ctx.clearRect(0,0,size,size);

  ctx.beginPath(); ctx.arc(cx,cy,r,0,2*Math.PI);
  ctx.strokeStyle = "#eef2f0"; ctx.lineWidth = lineW; ctx.stroke();

  const sweep = (pct/100) * 2 * Math.PI;
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+sweep);
  ctx.strokeStyle = color; ctx.lineWidth = lineW; ctx.lineCap = "round"; ctx.stroke();

  ctx.fillStyle = "#182620"; ctx.font = `900 ${Math.round(size*0.2)}px 'Sora','Segoe UI',system-ui`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(`${pct}%`, cx, cy);
}

function renderPerformancePage() {
  renderAlgorithmComparison();

  const withImage = allLogs.filter(l => l.checksRun?.image || (l.visionMode && l.visionMode !== "none"));
  const imageFlagged = withImage.filter(l => l.categoryTier === "concern");
  const visualPct = withImage.length ? Math.round(imageFlagged.length / withImage.length * 100) : 0;

  drawRing("ringVisual", visualPct, "#2f6f62");
  document.getElementById("ringVisualLabel").textContent =
    `${visualPct}% of ${withImage.length} checked video${withImage.length===1?"":"s"} had a picture concern`;

  const visualCatCounts = {};
  imageFlagged.forEach(l => { visualCatCounts[l.category] = (visualCatCounts[l.category]||0)+1; });
  const visualSorted = Object.entries(visualCatCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const visualMax = visualSorted[0]?.[1] || 1;
  document.getElementById("visualCategoryBars").innerHTML = visualSorted.length
    ? visualSorted.map(([id,n]) => {
        const cat = CATEGORIES.find(c => c.id === id) || { label: id };
        const pct = Math.round(n/visualMax*100);
        return `<div class="sub-bar-row">
          <div class="sub-bar-label-row"><span>${cat.label}</span><span>${n}</span></div>
          <div class="sub-bar-track"><div class="sub-bar-fill" style="width:${pct}%;background:var(--teal)"></div></div>
        </div>`;
      }).join("")
    : `<div style="color:var(--muted);font-size:14px">No picture concerns found yet — that's good news.</div>`;

  // ── Text/speech checker ──
  const withText  = allLogs.filter(l => l.checksRun?.title !== false);
  const textFlagged = withText.filter(l => (l.textFlags||[]).length > 0 || (l.audioFlags||[]).length > 0);
  const textPct = withText.length ? Math.round(textFlagged.length / withText.length * 100) : 0;

  drawRing("ringText", textPct, "#3568b0");
  document.getElementById("ringTextLabel").textContent =
    `${textPct}% of ${withText.length} checked video${withText.length===1?"":"s"} had a word concern`;

  const titleFlags = allLogs.reduce((n,l) => n + (l.textFlags||[]).length, 0);
  const audioFlags = allLogs.reduce((n,l) => n + (l.audioFlags||[]).length, 0);
  const audioChecked = allLogs.filter(l => l.audioMode === "on_device").length;
  const sources = [
    { label: "Title & channel name", count: titleFlags },
    { label: "Spoken words (from audio)", count: audioFlags },
  ];
  const srcMax = Math.max(...sources.map(s=>s.count), 1);
  document.getElementById("textSourceBars").innerHTML = sources.map(s => {
    const pct = Math.round(s.count/srcMax*100);
    return `<div class="sub-bar-row">
      <div class="sub-bar-label-row"><span>${s.label}</span><span>${s.count} flag${s.count===1?"":"s"}</span></div>
      <div class="sub-bar-track"><div class="sub-bar-fill" style="width:${pct}%;background:var(--blue)"></div></div>
    </div>`;
  }).join("") + `<div style="font-size:12.5px;color:var(--muted);margin-top:4px">Speech was checked on ${audioChecked} video${audioChecked===1?"":"s"} so far.</div>`;

  // ── Weekly 30-day stacked bars ──
  const weeks = [];
  for (let i = 3; i >= 0; i--) {
    const end = new Date(); end.setDate(end.getDate() - i*7); end.setHours(23,59,59,999);
    const start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0,0,0,0);
    weeks.push({ start: start.getTime(), end: end.getTime(), label: `${start.getMonth()+1}/${start.getDate()}` });
  }
  const weeklyData = weeks.map(w => {
    const inWeek = allLogs.filter(l => l.ts >= w.start && l.ts <= w.end);
    return { ...w, total: inWeek.length, flagged: inWeek.filter(l=>l.flagged).length };
  });
  const maxWeekly = Math.max(...weeklyData.map(w=>w.total), 1);
  document.getElementById("weeklyBars").innerHTML = weeklyData.map(w => {
    const totalH = Math.round(w.total/maxWeekly*170);
    const flagH  = w.total ? Math.round(w.flagged/w.total*totalH) : 0;
    const safeH  = totalH - flagH;
    return `<div class="weekly-bar-col">
      <div style="font-size:12px;font-weight:800;color:var(--ink-soft)">${w.total}</div>
      <div class="weekly-bar-stack" style="height:${Math.max(totalH,2)}px">
        ${flagH>0?`<div class="weekly-bar-seg" style="height:${flagH}px;background:var(--amber)"></div>`:""}
        ${safeH>0?`<div class="weekly-bar-seg" style="height:${safeH}px;background:var(--teal)"></div>`:""}
        ${totalH===0?`<div class="weekly-bar-seg" style="height:2px;background:var(--border)"></div>`:""}
      </div>
      <div class="weekly-bar-date">Wk of ${w.label}</div>
    </div>`;
  }).join("");
}

// ════════════════════════════════════════════════════════════════════════
// PDF REPORT EXPORT
// ════════════════════════════════════════════════════════════════════════
function pctOf(n, total) { return total ? Math.round((n / total) * 100) : 0; }

function describeActiveLogFilters() {
  const q        = document.getElementById("logSearch")?.value || "";
  const filter   = document.getElementById("logFilter")?.value  || "all";
  const rating   = document.getElementById("ratingFilter")?.value || "all";
  const daysBack = document.getElementById("dateFilter")?.value || "30";
  const parts = [
    filter === "all" ? "all statuses" : filter === "flagged" ? "flagged only" : filter === "safe" ? "safe only" : "inappropriate only",
    rating === "all" ? "all ratings" : `${rating} rating only`,
    daysBack === "0" ? "all time" : `last ${daysBack} days`,
  ];
  if (q) parts.push(`search "${q}"`);
  return `Filters applied: ${parts.join(" · ")}`;
}

async function exportPdfReport() {
  const btn = document.getElementById("btnExportPdf");
  const msg = document.getElementById("pdfExportMsg");
  const setMsg = (text, isErr) => { if (msg) { msg.textContent = text; msg.className = "feedback" + (isErr ? " err" : ""); } };

  if (!window.jspdf || !window.jspdf.jsPDF) {
    setMsg("The PDF library failed to load.", true);
    return;
  }

  if (btn) btn.disabled = true;
  setMsg("Generating PDF report…", false);

  try {
    const { jsPDF } = window.jspdf;
    if (typeof window.applyPlugin === "function") window.applyPlugin(jsPDF);

    const doc    = new jsPDF({ unit: "pt", format: "a4" });
    const pageW  = doc.internal.pageSize.getWidth();
    const pageH  = doc.internal.pageSize.getHeight();
    const marginX = 40;
    let y = 0;

    const TEAL  = [26, 138, 110];
    const INK   = [14, 27, 21];
    const MUTED = [100, 120, 110];

    function checkPage(need) {
      if (y + need > pageH - 44) { doc.addPage(); y = 40; }
    }
    function addBandHeader(subtitle) {
      doc.setFillColor(...TEAL);
      doc.rect(0, 0, pageW, 64, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold"); doc.setFontSize(16);
      doc.text("Shorts Guardian — Parent Report", marginX, 30);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      doc.text(subtitle, marginX, 48);
      doc.setTextColor(...INK);
      y = 90;
    }
    function sectionTitle(t) {
      checkPage(34);
      doc.setFont("helvetica", "bold"); doc.setFontSize(13);
      doc.setTextColor(...TEAL);
      doc.text(t, marginX, y);
      doc.setDrawColor(...TEAL); doc.setLineWidth(1);
      doc.line(marginX, y + 4, pageW - marginX, y + 4);
      y += 20;
      doc.setTextColor(...INK);
    }
    function kv(label, value) {
      checkPage(18);
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...MUTED);
      doc.text(label, marginX, y);
      doc.setFont("helvetica", "normal"); doc.setTextColor(...INK);
      doc.text(String(value ?? "—"), marginX + 170, y);
      y += 16;
    }
    function paragraph(text) {
      checkPage(16);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text(text, marginX, y);
      doc.setTextColor(...INK);
      y += 16;
    }
    function noDataLine(text) {
      checkPage(16);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
      doc.text(text, marginX, y);
      doc.setTextColor(...INK);
      y += 16;
    }
    function table(head, body, colStyles) {
      checkPage(40);
      doc.autoTable({
        startY: y,
        head: [head],
        body,
        margin: { left: marginX, right: marginX },
        theme: "striped",
        headStyles: { fillColor: TEAL, textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8.5, textColor: INK },
        alternateRowStyles: { fillColor: [243, 248, 246] },
        columnStyles: colStyles || {},
      });
      y = doc.lastAutoTable.finalY + 18;
    }

    // ── Cover / header ──────────────────────────────────────────────────
    addBandHeader(`Generated ${new Date().toLocaleString()}`);

    // ── Child information ────────────────────────────────────────────────
    sectionTitle("Child Information");
    kv("Full name", profile.name || "Not set");
    kv("Age", profile.age || "Not set");
    kv("Sex", profile.sex || "Not set");
    kv("MTRCB category by age", profile.age ? ageToMtrcbCategory(profile.age) : "—");
    y += 4;

    // ── Parent / guardian information ────────────────────────────────────
    sectionTitle("Parent / Guardian Information");
    kv("Full name", profile.parentName || "Not set");
    kv("Relationship to child", profile.parentRelationship || "Not set");
    kv("Alert email", profile.parentEmail || profile.gmail || "Not set");
    y += 4;

    // ── Today's activity summary ─────────────────────────────────────────
    const todayTs      = todayStart();
    const todayLogs     = allLogs.filter(l => l.ts >= todayTs);
    const todayFlagged  = todayLogs.filter(l => l.flagged).length;
    const todayInapprop = todayLogs.filter(l => l.finalVerdict === "Inappropriate").length;
    sectionTitle("Today's Activity Summary");
    kv("Videos watched today", todayLogs.length);
    kv("Flagged for review today", `${todayFlagged} (${pctOf(todayFlagged, todayLogs.length)}%)`);
    kv("Marked inappropriate today", todayInapprop);
    kv("Total checked, all time", allLogs.length);
    y += 4;

    // ── Content breakdown ────────────────────────────────────────────────
    sectionTitle("Content Breakdown");
    const catCounts = {};
    allLogs.forEach(l => { catCounts[l.category] = (catCounts[l.category] || 0) + 1; });
    const catSorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    if (catSorted.length) {
      table(["Category", "Count", "Share"], catSorted.map(([id, n]) => {
        const cat = CATEGORIES.find(c => c.id === id) || { label: id };
        return [cat.label, String(n), `${pctOf(n, allLogs.length)}%`];
      }));
    } else {
      noDataLine("No videos checked yet.");
    }

    // ── Flagged vs safe ───────────────────────────────────────────────────
    sectionTitle("Flagged vs. Safe (All-Time)");
    const flaggedAll = allLogs.filter(l => l.flagged).length;
    const safeAll    = allLogs.length - flaggedAll;
    kv("Safe", `${safeAll} (${pctOf(safeAll, allLogs.length)}%)`);
    kv("Flagged", `${flaggedAll} (${pctOf(flaggedAll, allLogs.length)}%)`);
    y += 4;

    // ── MTRCB rating breakdown (G / PG / SPG) ───────────────────────────
    sectionTitle("MTRCB Rating Breakdown — G / PG / SPG");
    const ratingCounts = { G: 0, PG: 0, SPG: 0 };
    allLogs.forEach(l => {
      const r = l.mtrcbRating === "Appropriate" ? "G" : l.mtrcbRating;
      if (ratingCounts[r] !== undefined) ratingCounts[r]++;
    });
    table(["Rating", "Meaning", "Count", "Share"], [
      ["G",   "General Audience (0–6)",         String(ratingCounts.G),   `${pctOf(ratingCounts.G, allLogs.length)}%`],
      ["PG",  "Parental Guidance (7–13)",        String(ratingCounts.PG),  `${pctOf(ratingCounts.PG, allLogs.length)}%`],
      ["SPG", "Strong Parental Guidance (14+)",  String(ratingCounts.SPG), `${pctOf(ratingCounts.SPG, allLogs.length)}%`],
    ]);

    // ── Last 30 days ──────────────────────────────────────────────────────
    sectionTitle("Last 30 Days");
    const days30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      days30.push(d.getTime());
    }
    const dayCounts = {};
    days30.forEach(k => { dayCounts[k] = { total: 0, flagged: 0 }; });
    allLogs.forEach(l => {
      const key = dayStart(l.ts);
      if (dayCounts[key]) { dayCounts[key].total++; if (l.flagged) dayCounts[key].flagged++; }
    });
    table(["Date", "Checked", "Flagged", "Safe"], days30.map(k => {
      const d = new Date(k), c = dayCounts[k];
      return [`${d.getMonth() + 1}/${d.getDate()}`, String(c.total), String(c.flagged), String(c.total - c.flagged)];
    }), { 0: { cellWidth: 70 } });

    // ── Picture Checker performance ─────────────────────────────────────
    sectionTitle("Picture Checker");
    const withImage     = allLogs.filter(l => l.checksRun?.image || (l.visionMode && l.visionMode !== "none"));
    const imageFlagged  = withImage.filter(l => l.categoryTier === "concern");
    kv("Videos checked", withImage.length);
    kv("Picture concerns found", `${imageFlagged.length} (${pctOf(imageFlagged.length, withImage.length)}%)`);
    paragraph("Samples frames from each Short — like glancing at a thumbnail — to detect weapons, alcohol, or other scenes that may not be suitable.");
    y += 2;

    // ── Word & Speech Checker performance ───────────────────────────────
    sectionTitle("Word & Speech Checker");
    const withText    = allLogs.filter(l => l.checksRun?.title !== false);
    const textFlagged = withText.filter(l => (l.textFlags || []).length > 0 || (l.audioFlags || []).length > 0);
    const titleFlagN  = allLogs.reduce((n, l) => n + (l.textFlags || []).length, 0);
    const audioFlagN  = allLogs.reduce((n, l) => n + (l.audioFlags || []).length, 0);
    kv("Videos checked", withText.length);
    kv("Word/speech concerns found", `${textFlagged.length} (${pctOf(textFlagged.length, withText.length)}%)`);
    kv("Flags from title / channel text", titleFlagN);
    kv("Flags from spoken audio", audioFlagN);
    paragraph("Reads titles, hashtags, and transcribed speech to scan for language patterns that suggest content may not be age-appropriate.");

    // ── Filtered activity log ───────────────────────────────────────────
    doc.addPage(); y = 40;
    sectionTitle("Activity Log");
    paragraph(describeActiveLogFilters());
    const filteredLogs = getFilteredLogs();
    const MAX_ROWS = 300;
    if (filteredLogs.length) {
      const rows = filteredLogs.slice(0, MAX_ROWS).map(l => {
        const d   = new Date(l.ts);
        const cat = CATEGORIES.find(c => c.id === l.category) || { label: l.category || "—" };
        return [
          `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          (l.title || "(no title)").slice(0, 42),
          cat.label,
          l.mtrcbRating || "—",
          l.finalVerdict || (l.flagged ? "Inappropriate" : "Appropriate"),
          l.flagged ? "Flagged" : "Safe",
        ];
      });
      table(["Time", "Title", "Category", "Rating", "Verdict", "Status"], rows, { 1: { cellWidth: 170 } });
      if (filteredLogs.length > MAX_ROWS) {
        noDataLine(`Showing first ${MAX_ROWS} of ${filteredLogs.length} matching entries. Refine filters on the dashboard to narrow this down.`);
      }
    } else {
      noDataLine("No entries match the current Activity Log filters.");
    }

    // ── Footer page numbers ─────────────────────────────────────────────
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.text(`Shorts Guardian · Confidential parent report · Page ${i} of ${pageCount}`, marginX, pageH - 20);
    }

    const nameSafe = (profile.name || "child").replace(/[^a-z0-9]+/gi, "_");
    const dateSafe = new Date().toISOString().slice(0, 10);
    doc.save(`ShortsGuardian_Report_${nameSafe}_${dateSafe}.pdf`);

    setMsg("PDF downloaded ✓", false);
  } catch (err) {
    console.error("PDF export failed:", err);
    setMsg("Could not generate the PDF. Please try again.", true);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setMsg("", false), 4000);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Global wiring
// ════════════════════════════════════════════════════════════════════════
function setupSidebarToggle() {
  const toggle = document.getElementById("masterToggle");
  const label  = document.getElementById("monitorLabel");
  const dot    = document.getElementById("monitorDot");
  const update = (on) => {
    toggle.checked = on;
    label.textContent = on ? "Monitoring on" : "Monitoring off";
    dot.className  = on ? "monitor-dot" : "monitor-dot off";
  };
  update(settings.enabled !== false);
  toggle.addEventListener("change", async () => {
    update(toggle.checked);
    await setStorage({ [KEYS.SETTINGS]: { ...settings, enabled: toggle.checked } });
    settings.enabled = toggle.checked;
  });
}

// ── Age-input MTRCB badge helper ─────────────────────────────────────────────
// Updates the live badge preview shown below the Age field in the child form.
function updateAgeMtrcbBadge(age) {
  const preview = document.getElementById("ageMtrcbPreview");
  const badgeEl = document.getElementById("ageMtrcbBadge");
  const descEl  = document.getElementById("ageMtrcbDesc");
  if (!preview) return;
  const n = parseInt(age, 10);
  if (!age || isNaN(n) || n < 1) {
    preview.classList.add("u-hidden");
    return;
  }
  const cat  = ageToMtrcbCategory(age);
  const meta = MTRCB_CAT_META[cat];
  badgeEl.textContent = cat;
  badgeEl.style.background = meta.bg;
  badgeEl.style.color      = meta.color;
  badgeEl.dataset.cat      = cat;
  descEl.textContent = `${meta.label} · ${meta.range} · Can watch: ${meta.allowed}`;
  preview.classList.remove("u-hidden");
}

function wireGlobalEvents() {
  document.getElementById("btnLockTop")    ?.addEventListener("click", lockDashboard);
  document.getElementById("btnLockSidebar")?.addEventListener("click", lockDashboard);
  document.getElementById("btnSaveProfile")?.addEventListener("click", saveProfile);
  document.getElementById("btnSaveChild")  ?.addEventListener("click", saveChild);
  document.getElementById("childAge")?.addEventListener("input", e => updateAgeMtrcbBadge(e.target.value));
  document.getElementById("btnChangePin")  ?.addEventListener("click", changePin);
  document.getElementById("btnClearNotifs")?.addEventListener("click", openClearNotifsModal);
  document.getElementById("clearNotifsCancelBtn") ?.addEventListener("click", closeClearNotifsModal);
  document.getElementById("clearNotifsConfirmBtn")?.addEventListener("click", clearAllNotifications);
  document.getElementById("btnClearHistory")?.addEventListener("click", openClearHistoryModal);
  document.getElementById("clearHistoryCancelBtn") ?.addEventListener("click", closeClearHistoryModal);
  document.getElementById("clearHistoryConfirmBtn")?.addEventListener("click", clearActivityHistory);
  document.getElementById("btnDashSummary")?.addEventListener("click", toggleDashSummary);
  document.getElementById("btnExportPdf")  ?.addEventListener("click", exportPdfReport);

  document.addEventListener("change", e => {
    if (["logFilter","dateFilter","ratingFilter"].includes(e.target.id)) { page = 0; renderTable(); }
  });
  document.addEventListener("input", e => {
    if (e.target.id === "logSearch") { page = 0; renderTable(); }
  });
  document.addEventListener("click", e => {
    const btn = e.target.closest(".pg-btn[data-page]");
    if (btn && !btn.disabled) { page = parseInt(btn.dataset.page, 10); renderTable(); }
  });
  document.addEventListener("click", e => {
    const thumb = e.target.closest(".snap-thumb");
    if (thumb) {
      document.getElementById("snapLightboxImg").src = thumb.dataset.full;
      document.getElementById("snapLightbox").classList.add("open");
      return;
    }
    if (e.target.id === "snapLightbox") document.getElementById("snapLightbox").classList.remove("open");
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") document.getElementById("snapLightbox")?.classList.remove("open");
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initPinGate();
