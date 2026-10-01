// ── Shorts Guardian — Dashboard v1.4 ─────────────────────────────────────────
// New in v1.4:
//   • MTRCB rating column (G / PG / SPG / Appropriate) in log table
//   • Final verdict column (Appropriate / Inappropriate)
//   • Weighted score display
//   • Age rating setting (G / PG / SPG)
//   • Email notification settings (toggle + Gmail address)
//   • Cross-device sync toggle + manual sync button
//   • KPI card for "Inappropriate today"

const KEYS = { LOGS: "sg_logs", SETTINGS: "sg_settings" };

const DEFAULT_SETTINGS = {
  pinHash: null, pinSalt: null, enabled: true,
  retentionDays: 30, captureIntervalSec: 12, sensitivity: 0.5,
  blockedCategories: ["weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying"],
  maxLogs: 4000, saveSnapshots: true, saveSnapshotsAllShorts: false,
  audioScanEnabled: true, audioClipSeconds: 6,
  // v1.4
  emailNotifyEnabled: true, parentEmail: "", ageRating: "PG", syncEnabled: true,
};

const CATEGORIES = [
  { id: "weapons",           label: "Weapons" },
  { id: "alcohol_tobacco",   label: "Alcohol / tobacco" },
  { id: "self_harm",         label: "Self-harm language" },
  { id: "violence",          label: "Violent language" },
  { id: "substances",        label: "Substances" },
  { id: "sexual_content",    label: "Sexual content" },
  { id: "romance",           label: "Kissing / romance" },
  { id: "bullying",          label: "Bullying / harassment" },
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
};

const CONCERN_IDS = new Set([
  "weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying",
]);

const MTRCB_COLORS = {
  G:           { bg: "#e8f5ee", color: "#2e7d52" },
  PG:          { bg: "#e8f0fb", color: "#1a56a0" },
  SPG:         { bg: "#fdf0eb", color: "#c8643c" },
  Appropriate: { bg: "#e8f5ee", color: "#2e7d52" },
};

// ── MTRCB age-rating derived from child's age (mirrors background.js) ────────
function ageToMtrcbCategory(age) {
  const n = parseInt(age, 10);
  if (isNaN(n) || n < 5)  return "G";
  if (n <= 7)             return "G";
  if (n <= 13)            return "PG";
  if (n <= 18)            return "SPG";
  return "SPG";
}
function mtrcbCategoryLabel(cat) {
  const labels = { G: "G — General Audience", PG: "PG — Parental Guidance", SPG: "SPG — Strong Parental Guidance" };
  return labels[cat] || cat;
}
function mtrcbAgeRange(cat) {
  const ranges = { G: "ages 5–7", PG: "ages 7–13", SPG: "ages 13–18" };
  return ranges[cat] || "";
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }
async function getLogs()     { const d = await getStorage(KEYS.LOGS);     return d[KEYS.LOGS]     || []; }
async function getSettings() { const d = await getStorage(KEYS.SETTINGS); return { ...DEFAULT_SETTINGS, ...(d[KEYS.SETTINGS] || {}) }; }

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// ── PIN gate ──────────────────────────────────────────────────────────────────
let pinBuffer = "", creatingPin = false, firstEntry = "";

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
  setTimeout(() => { el.textContent = ""; }, 1800);
}

async function handleNumpad(val) {
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
  if (hash === settings.pinHash) { unlock(); return; }
  showPinError("Incorrect PIN. Please try again.");
  pinBuffer = ""; updateDots(0);
}

function unlock() {
  document.getElementById("pinGate").classList.add("u-hidden");
  document.getElementById("app").classList.remove("u-hidden");
  loadDashboard();
}

// ── Forgot PIN → Gmail OTP verification ──────────────────────────────────────
// Instead of wiping all data on an unverified "Forgot PIN?" click, we send a
// 5-digit one-time code to the parent's connected Gmail (same Gmail API used
// for flag-alert emails) and only allow setting a new PIN once that code is
// confirmed. Logs are preserved — the wipe was only ever a stand-in for real
// identity verification.
const OTP_TTL_MS             = 5 * 60 * 1000;   // code valid for 5 minutes
const OTP_MAX_ATTEMPTS       = 5;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

let otpState = { code: null, expiry: 0, attempts: 0, email: "" };
let otpResendTimer = null;

function genOtp() {
  return String(Math.floor(10000 + Math.random() * 90000)); // 5-digit: 10000–99999
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!user || !domain) return email;
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function getGmailToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (t) => {
      if (chrome.runtime.lastError || !t) reject(new Error(chrome.runtime.lastError?.message || "No Gmail token"));
      else resolve(t);
    });
  });
}

function removeCachedToken(token) {
  return new Promise(res => chrome.identity.removeCachedAuthToken({ token }, res));
}

async function sendOtpEmail(parentEmail, code) {
  const token = await getGmailToken(true); // interactive OK — this runs from a user click
  const subject = "[Shorts Guardian] Your PIN reset code";
  const bodyText = `Your Shorts Guardian PIN reset code is: ${code}\n\nThis code expires in 5 minutes. If you didn't request this, you can ignore this email.`;
  const bodyHtml = `
<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1b2b24;max-width:480px;margin:0 auto">
<div style="background:#1e4a40;padding:20px 24px;border-radius:10px 10px 0 0">
  <h1 style="color:white;font-size:18px;margin:0">Shorts Guardian — PIN Reset</h1>
</div>
<div style="background:#fff;border:1px solid #d0dbd7;border-top:none;padding:24px;border-radius:0 0 10px 10px;text-align:center">
  <p style="color:#5a7068;font-size:13px;margin:0 0 12px">Your verification code is</p>
  <p style="font-size:32px;font-weight:800;letter-spacing:8px;color:#1e4a40;margin:0 0 12px">${code}</p>
  <p style="color:#9aada7;font-size:12px;margin:0">This code expires in 5 minutes. If you didn't request a PIN reset, you can ignore this email.</p>
</div>
</body></html>`;

  const boundary = "sg_otp_boundary_" + Date.now();
  const rawEmail = [
    `To: ${parentEmail}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    bodyText,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    bodyHtml,
    "",
    `--${boundary}--`,
  ].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });

  if (res.status === 401) {
    // Stale/wrong-account token (e.g. left over after switching Gmail accounts).
    // Clear it and force a fresh interactive pick, then retry once.
    await removeCachedToken(token);
    const freshToken = await getGmailToken(true);
    const retryRes = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${freshToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encoded }),
    });
    if (!retryRes.ok) {
      const errBody = await retryRes.text();
      throw new Error(`Gmail send failed after reauth: ${retryRes.status} ${errBody}`);
    }
    return;
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gmail send failed: ${res.status} ${errBody}`);
  }
}

function showOtpError(msg) {
  document.getElementById("otpError").textContent = msg;
}

function clearOtpDigits() {
  document.querySelectorAll(".otp-digit").forEach(inp => (inp.value = ""));
  document.querySelector('.otp-digit[data-i="0"]').focus();
}

function setOtpBusy(sending) {
  document.getElementById("btnVerifyOtp").disabled = sending;
  document.getElementById("btnResendOtp").disabled = sending;
}

async function startOtpFlow() {
  const settings = await getSettings();
  document.getElementById("pinEntryCard").classList.add("u-hidden");
  document.getElementById("otpCard").classList.remove("u-hidden");
  showOtpError("");

  if (!settings.parentEmail) {
    // No recovery Gmail connected — can't verify identity, so we can't allow a reset.
    document.getElementById("otpNoEmail").classList.remove("u-hidden");
    document.getElementById("otpEmailHint").classList.add("u-hidden");
    document.getElementById("otpInputs").classList.add("u-hidden");
    document.getElementById("btnVerifyOtp").classList.add("u-hidden");
    document.getElementById("btnResendOtp").classList.add("u-hidden");
    return;
  }

  document.getElementById("otpNoEmail").classList.add("u-hidden");
  document.getElementById("otpEmailHint").classList.remove("u-hidden");
  document.getElementById("otpInputs").classList.remove("u-hidden");
  document.getElementById("btnVerifyOtp").classList.remove("u-hidden");
  document.getElementById("btnResendOtp").classList.remove("u-hidden");
  document.getElementById("otpEmailHint").textContent = `Code sent to ${maskEmail(settings.parentEmail)}`;

  otpState = { code: genOtp(), expiry: Date.now() + OTP_TTL_MS, attempts: 0, email: settings.parentEmail };
  clearOtpDigits();

  try {
    setOtpBusy(true);
    await sendOtpEmail(settings.parentEmail, otpState.code);
    setOtpBusy(false);
    startResendCooldown();
  } catch (err) {
    setOtpBusy(false);
    showOtpError("Couldn't send the code. Check that Gmail is connected in Settings, then try again.");
    console.warn("[SG] OTP send failed:", err.message);
  }
}

function startResendCooldown() {
  const btn = document.getElementById("btnResendOtp");
  let remaining = OTP_RESEND_COOLDOWN_MS / 1000;
  btn.disabled = true;
  btn.textContent = `Resend code (${remaining}s)`;
  clearInterval(otpResendTimer);
  otpResendTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(otpResendTimer);
      btn.disabled = false;
      btn.textContent = "Resend code";
    } else {
      btn.textContent = `Resend code (${remaining}s)`;
    }
  }, 1000);
}

async function resendOtp() {
  if (!otpState.email) return;
  showOtpError("");
  otpState.code    = genOtp();
  otpState.expiry  = Date.now() + OTP_TTL_MS;
  otpState.attempts = 0;
  clearOtpDigits();
  try {
    setOtpBusy(true);
    await sendOtpEmail(otpState.email, otpState.code);
    setOtpBusy(false);
    startResendCooldown();
  } catch (err) {
    setOtpBusy(false);
    showOtpError("Couldn't resend the code. Try again in a moment.");
    console.warn("[SG] OTP resend failed:", err.message);
  }
}

async function verifyOtp() {
  const digits = Array.from(document.querySelectorAll(".otp-digit")).map(i => i.value.trim());
  const entered = digits.join("");

  if (entered.length !== 5 || digits.some(d => !d)) {
    showOtpError("Enter all 5 digits.");
    return;
  }
  if (!otpState.code) {
    showOtpError("Request a new code first.");
    return;
  }
  if (Date.now() > otpState.expiry) {
    showOtpError("That code expired — click Resend code.");
    return;
  }
  if (otpState.attempts >= OTP_MAX_ATTEMPTS) {
    showOtpError("Too many incorrect attempts. Click Resend code to get a new one.");
    return;
  }
  if (entered !== otpState.code) {
    otpState.attempts += 1;
    showOtpError(`Incorrect code (${OTP_MAX_ATTEMPTS - otpState.attempts} attempts left).`);
    clearOtpDigits();
    return;
  }

  // Verified — clear the PIN only (logs are kept) and let the normal
  // "no PIN set" flow prompt for a fresh 4-digit PIN on reload.
  const settings = await getSettings();
  await setStorage({ [KEYS.SETTINGS]: { ...settings, pinHash: null, pinSalt: null } });
  clearInterval(otpResendTimer);
  otpState = { code: null, expiry: 0, attempts: 0, email: "" };
  location.reload();
}

function backToPinEntry() {
  clearInterval(otpResendTimer);
  otpState = { code: null, expiry: 0, attempts: 0, email: "" };
  document.getElementById("otpCard").classList.add("u-hidden");
  document.getElementById("pinEntryCard").classList.remove("u-hidden");
  showOtpError("");
}

function initOtpInputs() {
  const inputs = Array.from(document.querySelectorAll(".otp-digit"));
  inputs.forEach((inp, idx) => {
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/\D/g, "").slice(0, 1);
      if (inp.value && idx < inputs.length - 1) inputs[idx + 1].focus();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !inp.value && idx > 0) inputs[idx - 1].focus();
      if (e.key === "Enter") verifyOtp();
    });
    inp.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "");
      if (!text) return;
      e.preventDefault();
      text.slice(0, inputs.length).split("").forEach((ch, i) => { if (inputs[i]) inputs[i].value = ch; });
      inputs[Math.min(text.length, inputs.length - 1)].focus();
    });
  });
  document.getElementById("btnVerifyOtp").addEventListener("click", verifyOtp);
  document.getElementById("btnResendOtp").addEventListener("click", resendOtp);
  document.getElementById("btnBackToPin").addEventListener("click", backToPinEntry);
}

async function resetPin() {
  await startOtpFlow();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
let allLogs = [], settings = {}, page = 0;
const PAGE_SIZE = 25;

async function loadDashboard() {
  [allLogs, settings] = await Promise.all([getLogs(), getSettings()]);
  renderStats();
  renderCategoryBars();
  renderDonut();
  renderTimeline();
  renderTable();
  renderSettings();
  setupTopbarToggle();
  renderVisionStatus();
}

function dayStart(ts) { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function todayStart() { const d = new Date();    d.setHours(0,0,0,0); return d.getTime(); }

// ── KPI cards ─────────────────────────────────────────────────────────────────
function renderStats() {
  const today     = todayStart();
  const todayLogs = allLogs.filter(l => l.ts >= today);
  const flagged   = todayLogs.filter(l => l.flagged).length;
  const inappropriate = todayLogs.filter(l => l.finalVerdict === "Inappropriate").length;
  const days      = new Set(allLogs.map(l => dayStart(l.ts))).size;

  document.getElementById("kpiToday").textContent        = todayLogs.length;
  document.getElementById("kpiFlagged").textContent      = flagged;
  document.getElementById("kpiInappropriate").textContent = inappropriate;
  document.getElementById("kpiFlagRate").textContent     =
    todayLogs.length ? `${Math.round(flagged / todayLogs.length * 100)}% of today's Shorts` : "";
  document.getElementById("kpiTotal").textContent        = allLogs.length;
  document.getElementById("kpiDays").textContent         = days;
}

// ── Category bars ─────────────────────────────────────────────────────────────
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
  }).join("") || '<div style="color:var(--muted);font-size:12px;padding:8px 0">No data yet</div>';
}

// ── Donut ─────────────────────────────────────────────────────────────────────
function renderDonut() {
  const flagged = allLogs.filter(l => l.flagged).length;
  const safe    = allLogs.length - flagged;
  const canvas  = document.getElementById("donut");
  const ctx     = canvas.getContext("2d");
  const [cx,cy,r,ri] = [78,78,60,42];
  ctx.clearRect(0,0,156,156);
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
  ctx.fillStyle = "#1b2b24"; ctx.font = "bold 20px 'Segoe UI',system-ui";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(allLogs.length, cx, cy-7);
  ctx.font = "11px 'Segoe UI',system-ui"; ctx.fillStyle = "#5a7068";
  ctx.fillText("total", cx, cy+11);
  document.getElementById("donutLegend").innerHTML =
    slices.filter(s => s.label !== "No data").map(s =>
      `<div class="legend-row"><span class="legend-dot" style="background:${s.color}"></span>${s.label}: <strong>${s.val}</strong></div>`
    ).join("");
}

// ── Timeline ──────────────────────────────────────────────────────────────────
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
    const totalH = Math.round(b.total   / maxTotal * 60);
    const flagH  = Math.round(b.flagged / maxTotal * 60);
    const safeH  = totalH - flagH;
    return `<div class="day-bar-wrap" title="${label}: ${b.total} seen, ${b.flagged} flagged">
      ${flagH  > 0 ? `<div class="day-bar-seg" style="background:var(--amber);height:${flagH}px"></div>` : ""}
      ${safeH  > 0 ? `<div class="day-bar-seg" style="background:var(--teal);height:${safeH}px"></div>` : ""}
      ${totalH === 0 ? `<div class="day-bar-seg" style="background:var(--border);height:2px"></div>` : ""}
      <div class="day-bar-date">${label}</div>
    </div>`;
  }).join("");
}

// ── MTRCB badge helper ────────────────────────────────────────────────────────
function mtrcbBadge(rating) {
  const c = MTRCB_COLORS[rating] || { bg: "#f0f4f1", color: "#5a7068" };
  return `<span class="mtrcb-badge" style="background:${c.bg};color:${c.color}">${rating||"—"}</span>`;
}

// ── Weighted score bar ────────────────────────────────────────────────────────
function scorePill(score) {
  if (score == null) return "—";
  const pct  = Math.round(score * 100);
  const color = pct >= 50 ? "#c8643c" : pct >= 25 ? "#c8a03c" : "#2f6f62";
  return `<div class="score-bar-wrap" title="Inappropriateness score: ${pct}%">
    <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="score-bar-label" style="color:${color}">${pct}%</span>
  </div>`;
}

// ── Log table ─────────────────────────────────────────────────────────────────
// "G" and "Appropriate" are the same safety tier from a parent's point of
// view — deriveMtrcbRating() (background.js) only stamps a video "G" when a
// specific G-tier flag fires (e.g. vehicles_speed); everything else with no
// concerning findings is stored as "Appropriate". This mirrors the app's own
// MTRCB_ALLOWED hierarchy, so the rating filter treats them as one group
// instead of two disjoint buckets.
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
    if (filter === "flagged"      && !l.flagged) return false;
    if (filter === "safe"         &&  l.flagged) return false;
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
  const totalEl = document.getElementById("dashTotalDetected");
  if (totalEl) totalEl.textContent = `— ${allLogs.length} video${allLogs.length===1?"":"s"} detected in total`;

  // Detection number = this entry's absolute position in the full history
  // (oldest = #1, counting up), independent of the current filter/sort/page.
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
        : `<div class="snap-placeholder">—</div>`;
      const checks = l.checksRun || { title: true, image: l.visionMode && l.visionMode !== "none", audio: false };
      const imgModeLabel = l.visionMode === "claude" ? "Claude Vision" : l.visionMode === "on_device" ? "on-device" : "didn't run";
      const audModeLabel = l.audioMode === "on_device" ? "on-device Whisper" : l.audioMode === "unavailable" ? "attempted, unavailable" : "didn't run";
      const checkBadges = `
        <span class="scan-badge ${checks.title?"ran":""}" title="Title/channel keyword scan: ran">T</span>
        <span class="scan-badge ${checks.image?"ran":""}" title="Image analysis: ${imgModeLabel}">I</span>
        <span class="scan-badge ${checks.audio?"ran":""}" title="Audio analysis: ${audModeLabel}${l.transcript?' — "'+l.transcript.slice(0,120)+(l.transcript.length>120?'…':'')+'"':''}">A</span>`;
      const verdictCls = l.finalVerdict === "Inappropriate" ? "verdict-bad" : "verdict-ok";
      const detectionNo = detectionNoByLog.get(l) || "—";
      return `<tr class="${l.flagged?"flagged-row":""}">
        <td class="detect-no">${detectionNo}</td>
        <td class="snap-cell">${snapCell}</td>
        <td style="white-space:nowrap;font-size:11px;color:var(--muted)">${time}</td>
        <td class="title-cell">
          <a class="log-link" href="${l.url}" target="_blank" rel="noopener">${l.title||"(no title)"}</a>
          <div class="channel-text">${l.channel||""}</div>
        </td>
        <td><span class="pill ${catCls}">${cat.label}</span></td>
        <td>${flags||"—"}</td>
        <td class="checks-cell">${checkBadges}</td>
        <td>${mtrcbBadge(l.mtrcbRating)}</td>
        <td>${scorePill(l.weightedScore)}</td>
        <td><span class="flag-badge ${verdictCls}">${l.finalVerdict||( l.flagged?"Inappropriate":"Appropriate")}</span></td>
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

// ── Settings panel ────────────────────────────────────────────────────────────
async function renderSettings() {
  document.getElementById("retentionDays").value   = settings.retentionDays;
  document.getElementById("captureInterval").value = settings.captureIntervalSec;
  const sens = document.getElementById("sensitivity");
  sens.value = settings.sensitivity;
  updateSensLabel(settings.sensitivity);
  sens.addEventListener("input", () => updateSensLabel(sens.value));

  // Age rating — derived automatically from profile.age, not manually set
  const profileResult  = await getStorage("sg_profile");
  const childAge       = profileResult?.sg_profile?.age ?? null;
  const derivedCat     = ageToMtrcbCategory(childAge);
  const badgeEl  = document.getElementById("ageRatingBadge");
  const descEl   = document.getElementById("ageRatingDesc");
  if (badgeEl) { badgeEl.textContent = derivedCat; badgeEl.dataset.cat = derivedCat; }
  if (descEl)  descEl.textContent  = mtrcbCategoryLabel(derivedCat).replace(/^[A-Z]+ — /, "") + " (" + mtrcbAgeRange(derivedCat) + ")";

  const container = document.getElementById("categoryChecks");
  container.innerHTML = CATEGORIES.slice(0,9).map(c =>
    `<label class="check-item">
      <input type="checkbox" value="${c.id}" ${settings.blockedCategories.includes(c.id)?"checked":""} />
      ${c.label}
    </label>`
  ).join("");

  document.getElementById("saveSnapshots").checked          = settings.saveSnapshots !== false;
  document.getElementById("saveSnapshotsAllShorts").checked = !!settings.saveSnapshotsAllShorts;
  document.getElementById("audioScanEnabled").checked       = settings.audioScanEnabled !== false;
  document.getElementById("audioClipSeconds").value         = settings.audioClipSeconds || 6;

  // Email notifications
  const emailToggle = document.getElementById("emailNotifyEnabled");
  const emailInput  = document.getElementById("parentEmail");
  if (emailToggle) emailToggle.checked  = !!settings.emailNotifyEnabled;
  if (emailInput)  emailInput.value     = settings.parentEmail || "";

  // Gmail auth status — check if a token is already cached on this device
  const gmailStatusEl = document.getElementById("gmailAuthStatus");
  if (gmailStatusEl) {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        gmailStatusEl.textContent = "✓ Gmail connected — emails will send on this device";
        gmailStatusEl.className   = "status-line ok";
      } else {
        gmailStatusEl.textContent = "Not connected — click \"Connect Gmail account\" below to authorize";
        gmailStatusEl.className   = "status-line";
      }
    });
  }

  // Sync
  const syncToggle = document.getElementById("syncEnabled");
  if (syncToggle) syncToggle.checked = settings.syncEnabled !== false;

  renderSyncStatus();
}

function renderSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  if (settings.syncEnabled !== false) {
    el.textContent = "✓ Settings sync active — changes apply across signed-in devices";
    el.className   = "status-line ok";
  } else {
    el.textContent = "Sync disabled — settings stored on this device only";
    el.className   = "status-line";
  }
}

function updateSensLabel(v) {
  const val = parseFloat(v);
  let label, hint;
  if (val <= 0.3) {
    label = "Low";
    hint  = "Only flags the most explicit content — visible guns, direct self-harm language, hard drug references.";
  } else if (val <= 0.6) {
    label = "Medium";
    hint  = "Flags clearly concerning content and moderately suspicious terms. Good default for most families.";
  } else {
    label = "High";
    hint  = "Flags broadly — any weapon (even toy guns), background alcohol, rough-housing, indirect references.";
  }
  document.getElementById("sensVal").textContent = label;
  const hintEl = document.getElementById("sensHint");
  if (hintEl) hintEl.textContent = hint;
}

function showFeedback(id, text, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = "feedback" + (isError ? " err" : "");
  setTimeout(() => { el.textContent = ""; }, 2500);
}

async function saveSettings(feedbackId = "settingsMsg") {
  const blocked = [...document.querySelectorAll("#categoryChecks input:checked")].map(el => el.value);
  const updated = {
    ...settings,
    retentionDays:          parseInt(document.getElementById("retentionDays").value, 10) || 30,
    captureIntervalSec:     parseInt(document.getElementById("captureInterval").value, 10) || 12,
    sensitivity:            parseFloat(document.getElementById("sensitivity").value),
    blockedCategories:      blocked,
    saveSnapshots:          document.getElementById("saveSnapshots").checked,
    saveSnapshotsAllShorts: document.getElementById("saveSnapshotsAllShorts").checked,
    audioScanEnabled:       document.getElementById("audioScanEnabled").checked,
    audioClipSeconds:       parseInt(document.getElementById("audioClipSeconds").value, 10) || 6,
    // ageRating is derived from profile.age (not manually set here)
    emailNotifyEnabled:     !!document.getElementById("emailNotifyEnabled")?.checked,
    parentEmail:            document.getElementById("parentEmail")?.value?.trim() || "",
    syncEnabled:            !!document.getElementById("syncEnabled")?.checked,
  };
  await setStorage({ [KEYS.SETTINGS]: updated });
  settings = updated;

  // Trigger sync in background
  chrome.runtime.sendMessage({ type: "SG_SYNC_SETTINGS" }).catch(() => {});
  renderSyncStatus();
  showFeedback(feedbackId, "Saved ✓");
}

function setupTopbarToggle() {
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

async function saveApiKey() {
  const key     = document.getElementById("apiKeyInput").value.trim();
  const updated = { ...settings, anthropicApiKey: key };
  await setStorage({ [KEYS.SETTINGS]: updated });
  settings = updated;
  renderVisionStatus();
  showFeedback("apiKeyMsg", key ? "API key saved ✓" : "API key cleared");
}

function renderVisionStatus() {
  const el  = document.getElementById("visionStatus");
  const inp = document.getElementById("apiKeyInput");
  if (!el) return;
  if (settings.anthropicApiKey) {
    el.textContent = "✓ Vision AI active (Claude Haiku)";
    el.className   = "status-line ok";
    inp.placeholder = "sk-ant-… (key saved)";
  } else {
    el.textContent = "On-device AI active (MobileNet + DistilBERT) — add a key for Claude Vision";
    el.className   = "status-line";
  }
}

async function changePin() {
  const oldVal  = document.getElementById("oldPin").value;
  const newVal  = document.getElementById("newPin").value;
  const confirm = document.getElementById("confirmPin").value;
  if (newVal.length !== 4 || !/^\d{4}$/.test(newVal)) {
    showFeedback("pinChangeMsg", "PIN must be exactly 4 digits", true); return;
  }
  if (newVal !== confirm) { showFeedback("pinChangeMsg", "New PINs don't match", true); return; }
  const oldHash = await sha256(oldVal + settings.pinSalt);
  if (oldHash !== settings.pinHash) { showFeedback("pinChangeMsg", "Current PIN is incorrect", true); return; }
  const salt = crypto.randomUUID(), hash = await sha256(newVal + salt);
  await setStorage({ [KEYS.SETTINGS]: { ...settings, pinHash: hash, pinSalt: salt } });
  settings = { ...settings, pinHash: hash, pinSalt: salt };
  ["oldPin","newPin","confirmPin"].forEach(id => { document.getElementById(id).value = ""; });
  showFeedback("pinChangeMsg", "PIN updated ✓");
}

function csvEscape(val) {
  const s = String(val ?? "");
  return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g,'""')}"` : s;
}

function exportCSV() {
  const headers = [
    "Timestamp","VideoID","Title","Channel","Category","MTRCB Rating",
    "Weighted Score","Final Verdict","Flagged","TextFlags","ImageLabel",
    "Transcript","AudioFlags","TTS Classification","URL",
  ];
  const rows = allLogs.map(l => [
    new Date(l.ts).toISOString(),
    l.videoId  || "",
    (l.title   || "").replace(/,/g,";"),
    (l.channel || "").replace(/,/g,";"),
    l.category || "",
    l.mtrcbRating    || "—",
    l.weightedScore  != null ? Math.round(l.weightedScore * 100) + "%" : "—",
    l.finalVerdict   || (l.flagged ? "Inappropriate" : "Appropriate"),
    l.flagged  ? "YES" : "NO",
    (l.textFlags  || []).join("|"),
    l.imageLabel  || "",
    csvEscape(l.transcript || ""),
    (l.audioFlags || []).join("|"),
    l.ttsClassification || (l.audioMode === "on_device" ? ((l.audioFlags||[]).length > 0 ? "Inappropriate" : "Appropriate") : "N/A"),
    l.url || "",
  ]);
  const csv  = [headers, ...rows].map(r => r.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `shorts_guardian_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

async function confirmClear() {
  if (!confirm("Delete all activity logs? This can't be undone.")) return;
  await setStorage({ [KEYS.LOGS]: [] });
  allLogs = [];
  renderStats(); renderCategoryBars(); renderDonut(); renderTimeline(); renderTable();
}

// ── Clear Activity History (toolbar button + modal, Activity Log section) ──
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
  renderStats(); renderCategoryBars(); renderDonut(); renderTimeline(); renderTable();
}

// ── Event wiring ──────────────────────────────────────────────────────────────
initPinGate();

document.addEventListener("DOMContentLoaded", () => {
  initOtpInputs();
  document.getElementById("btnExport")?.addEventListener("click", exportCSV);
  document.getElementById("btnClear") ?.addEventListener("click", confirmClear);
  document.getElementById("btnClearHistory")?.addEventListener("click", openClearHistoryModal);
  document.getElementById("clearHistoryCancelBtn") ?.addEventListener("click", closeClearHistoryModal);
  document.getElementById("clearHistoryConfirmBtn")?.addEventListener("click", clearActivityHistory);
  document.getElementById("btnSavePrefs") ?.addEventListener("click", () => saveSettings("settingsMsg"));
  document.getElementById("btnSaveCats")  ?.addEventListener("click", () => saveSettings("settingsMsg"));
  document.getElementById("btnChangePin") ?.addEventListener("click", changePin);
  document.getElementById("btnSaveApiKey")?.addEventListener("click", saveApiKey);
  document.getElementById("pinForgotBtn") ?.addEventListener("click", resetPin);
  document.getElementById("btnSaveNotify")?.addEventListener("click", () => saveSettings("notifyMsg"));
  document.getElementById("btnAuthGmail")?.addEventListener("click", () => {
    const statusEl = document.getElementById("gmailAuthStatus");
    if (statusEl) { statusEl.textContent = "Connecting…"; statusEl.className = "status-line"; }
    chrome.runtime.sendMessage({ type: "SG_AUTH_GMAIL" });
    // Listen for the result sent back by background.js
    const handler = (msg) => {
      if (msg?.type !== "SG_AUTH_GMAIL_RESULT") return;
      chrome.runtime.onMessage.removeListener(handler);
      if (!statusEl) return;
      if (msg.success) {
        statusEl.textContent = "✓ Gmail connected — emails will send on this device";
        statusEl.className   = "status-line ok";
      } else {
        statusEl.textContent = "✗ Authorization failed: " + (msg.error || "unknown error");
        statusEl.className   = "status-line err";
      }
    };
    chrome.runtime.onMessage.addListener(handler);
  });
  document.getElementById("btnSaveSync")  ?.addEventListener("click", () => saveSettings("syncMsg"));
  document.getElementById("btnManualSync")?.addEventListener("click", async () => {
    chrome.runtime.sendMessage({ type: "SG_SYNC_SETTINGS" }).catch(() => {});
    showFeedback("syncMsg", "Synced ✓");
  });
});

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
