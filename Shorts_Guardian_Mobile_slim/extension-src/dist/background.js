// ── Shorts Guardian — Background Service Worker v1.4 ─────────────────────────
// NEW in v1.4:
//   • MTRCB age ratings: G / PG / SPG per video
//   • Weighted final score (Visual 40% + Text 30% + Audio 30%)
//   • Final verdict: Appropriate | Inappropriate
//   • Gmail email notification when a Short is flagged (opt-in)
//   • Cross-device sync via chrome.storage.sync for settings
//   • Auto-skip on flag (existing, preserved)
//   • All existing features preserved without breakage

const STORAGE_KEYS = { LOGS: "sg_logs", SETTINGS: "sg_settings", BLOCKED: "sg_blocked_ids" };

const DEFAULT_SETTINGS = {
  pinHash: null,
  pinSalt: null,
  enabled: true,
  retentionDays: 30,
  captureIntervalSec: 12,
  sensitivity: 0.5,
  blockedCategories: ["weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying","horror_scary","flagged_content"],
  maxLogs: 4000,
  anthropicApiKey: "",
  saveSnapshots: true,
  saveSnapshotsAllShorts: false,
  audioScanEnabled: true,
  audioClipSeconds: 6,
  // ── v1.4 additions ──
  emailNotifyEnabled: true,
  parentEmail: "",          // Gmail address to send alerts to
  ageRating: "PG",          // Default child age rating: G | PG | SPG
  syncEnabled: true,        // Cross-device sync of settings via chrome.storage.sync
};

// ── MTRCB Age Rating definitions ──────────────────────────────────────────────
// Age → user category (derived from child profile age):
//   5–7   → G   (may only watch G-rated videos)
//   7–13  → PG  (may watch G and PG videos)
//   13–18 → SPG (may watch G, PG, and SPG videos)
//
// Allowed video ratings per user category:
//   G   → G only
//   PG  → G, PG
//   SPG → G, PG, SPG
const MTRCB_ALLOWED = {
  G:   new Set(["G", "Appropriate"]),
  PG:  new Set(["G", "PG", "Appropriate"]),
  SPG: new Set(["G", "PG", "SPG", "Appropriate"]),
};

// Category-level blocked content flags (used for flagging log entries and email)
const MTRCB_BLOCKED = {
  G:   ["weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying","vehicles_speed","horror_scary","flagged_content"],
  PG:  ["weapons","alcohol_tobacco","self_harm","violence","substances","sexual_content","romance","bullying","horror_scary","flagged_content"],
  SPG: ["weapons","self_harm","substances","sexual_content","bullying","horror_scary","flagged_content"],
};

// ── Derive user MTRCB category from child's age ───────────────────────────────
// Returns "G" | "PG" | "SPG" — the category the child belongs to.
// This is the child's ACCESS LEVEL, not the video's rating.
function ageToMtrcbCategory(age) {
  const n = parseInt(age, 10);
  if (isNaN(n) || n < 5)  return "G";   // Unknown / very young → strictest
  if (n <= 7)             return "G";   // 5–7 → G
  if (n <= 13)            return "PG";  // 7–13 → PG
  if (n <= 18)            return "SPG"; // 13–18 → SPG
  return "SPG";                         // 18+ → SPG (most permissive)
}

// ── MTRCB rating derivation ───────────────────────────────────────────────────
// Returns the VIDEO's content rating: "G" | "PG" | "SPG" | "Appropriate"
// based on detected flags and image analysis.
function deriveMtrcbRating(category, textFlags, audioFlags, imageResult) {
  const allFlags = new Set([...(textFlags || []), ...(audioFlags || [])]);
  if (imageResult?.tier === "concern") allFlags.add(imageResult.category || "other");

  const spgOnly  = new Set(["sexual_content", "self_harm", "substances"]);
  const pgUp     = new Set(["weapons","alcohol_tobacco","violence","bullying","romance","horror_scary","flagged_content"]);
  const gUp      = new Set(["vehicles_speed"]);

  // Choose most restrictive
  if ([...allFlags].some(f => spgOnly.has(f))) return "SPG";
  if ([...allFlags].some(f => pgUp.has(f)))    return "PG";
  if ([...allFlags].some(f => gUp.has(f)))     return "G";
  return "Appropriate"; // no concerns → safe for all ages
}

// ── Check if a video is accessible to a user of the given category ────────────
// Returns true if the video's rating is within the user's allowed set.
function isVideoAllowedForCategory(videoRating, userCategory) {
  const allowed = MTRCB_ALLOWED[userCategory] || MTRCB_ALLOWED.PG;
  return allowed.has(videoRating);
}

// ── Weighted classification score ─────────────────────────────────────────────
// Visual 40% + Text 30% + Audio 30% → 0.0–1.0 inappropriateness score
// score >= 0.5 → Inappropriate; < 0.5 → Appropriate
function computeWeightedScore({ imageResult, textFlags, audioFlags, textScore }) {
  // Visual sub-score
  // Full weight when tier=concern. Partial weight (0.35) when the on-device
  // model matched a concern category but couldn't confirm tier — MobileNet
  // often returns tier "neutral" for violence/weapons because it classifies
  // objects, not actions. A category match alone is still a meaningful signal.
  let visualScore = 0;
  if (imageResult?.tier === "concern") {
    visualScore = Math.min(1, (imageResult.confidence ?? 0.7));
  } else if (["weapons","violence","self_harm","sexual_content","substances","romance"].includes(imageResult?.category)) {
    visualScore = 0.35; // partial credit — category flagged but confidence low
  }

  // Text sub-score: proportion of possible flag categories triggered, + sentiment boost
  const textFlagScore = Math.min(1, (textFlags?.length || 0) / 3);
  const sentimentBoost = (textScore > 0.85) ? 0.15 : 0;
  const textSubScore = Math.min(1, textFlagScore + sentimentBoost);

  // Audio sub-score
  const audioSubScore = Math.min(1, (audioFlags?.length || 0) / 2);

  const weighted = (visualScore * 0.40) + (textSubScore * 0.30) + (audioSubScore * 0.30);
  return Math.round(weighted * 100) / 100; // round to 2dp
}

// ── Thumbnail helper ──────────────────────────────────────────────────────────
const THUMB_MAX_DIM = 160;
const THUMB_QUALITY  = 0.55;

async function makeThumbnail(dataUrl) {
  if (!dataUrl) return null;
  try {
    const blob   = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale  = Math.min(1, THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width  * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const thumbBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: THUMB_QUALITY });
    const buf  = await thumbBlob.arrayBuffer();
    const b64  = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return `data:image/jpeg;base64,${b64}`;
  } catch (err) {
    console.warn("[SG] Thumbnail generation failed:", err.message);
    return null;
  }
}

const MIN_GAP_MS = 8_000;
const lastSentByVideoId = new Map();

// ── Offscreen on-device classifier ───────────────────────────────────────────
const OFFSCREEN_PATH     = "offscreen.html";
const MSG_CLASSIFY_SHORT  = "SG_CLASSIFY_SHORT";
const MSG_CLASSIFY_RESULT = "SG_CLASSIFY_RESULT";
const OFFSCREEN_TIMEOUT_MS = 20_000;

const pendingOffscreenRequests = new Map();

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS", "USER_MEDIA"],
    justification: "Run on-device MobileNet/DistilBERT/Whisper models to classify Shorts thumbnails, titles, and audio without sending data off-device.",
  });
}

function classifyWithOffscreen({ dataUrl, title }) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingOffscreenRequests.delete(requestId);
      resolve(null);
    }, OFFSCREEN_TIMEOUT_MS);
    pendingOffscreenRequests.set(requestId, {
      resolve: (payload) => { clearTimeout(timer); resolve(payload); },
    });
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: MSG_CLASSIFY_SHORT, payload: { requestId, dataUrl, title } }))
      .catch(() => { clearTimeout(timer); pendingOffscreenRequests.delete(requestId); resolve(null); });
  });
}

// ── Audio transcription ───────────────────────────────────────────────────────
const MSG_TRANSCRIBE_AUDIO  = "SG_TRANSCRIBE_AUDIO";
const MSG_TRANSCRIBE_RESULT = "SG_TRANSCRIBE_RESULT";
const AUDIO_TIMEOUT_MS = 25_000;

const pendingAudioRequests = new Map();

function transcribeWithOffscreen({ streamId, clipMs }) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAudioRequests.delete(requestId);
      resolve(null);
    }, AUDIO_TIMEOUT_MS);
    pendingAudioRequests.set(requestId, {
      resolve: (payload) => { clearTimeout(timer); resolve(payload); },
    });
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: MSG_TRANSCRIBE_AUDIO, payload: { requestId, streamId, clipMs } }))
      .catch(() => { clearTimeout(timer); pendingAudioRequests.delete(requestId); resolve(null); });
  });
}

function getTabAudioStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(chrome.runtime.lastError?.message || "no streamId"));
      } else {
        resolve(streamId);
      }
    });
  });
}

async function captureAndTranscribeAudio(tab, clipSeconds) {
  try {
    await ensureOffscreenDocument();
    let streamId = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { streamId = await getTabAudioStreamId(tab.id); break; }
      catch (err) { if (attempt === 2) throw err; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
    }
    return await transcribeWithOffscreen({ streamId, clipMs: clipSeconds * 1000 });
  } catch (err) {
    console.warn("[SG] Audio capture failed:", err.message);
    return null;
  }
}

// ── Install / update ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!existing[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  // Sync initial settings to chrome.storage.sync if syncEnabled
  const s = existing[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
  if (s.syncEnabled !== false) {
    await syncSettingsToCloud(s);
  }
});

async function getSettings() {
  // Try to pull in synced settings first (non-sensitive fields only)
  const local  = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...(local[STORAGE_KEYS.SETTINGS] || {}) };

  if (merged.syncEnabled !== false) {
    try {
      const synced = await chrome.storage.sync.get("sg_sync_settings");
      if (synced.sg_sync_settings) {
        const nonSensitive = synced.sg_sync_settings;
        // SAFETY: never let a synced empty/missing blockedCategories
        // wipe out the local value — it would silently disable all flagging.
        if (!nonSensitive.blockedCategories || nonSensitive.blockedCategories.length === 0) {
          delete nonSensitive.blockedCategories;
        }
        Object.assign(merged, nonSensitive);
      }
    } catch (_) { /* sync unavailable — use local */ }
  }

  // Final safety net: ensure blockedCategories is always a non-empty array.
  if (!merged.blockedCategories || merged.blockedCategories.length === 0) {
    merged.blockedCategories = DEFAULT_SETTINGS.blockedCategories;
  }

  return merged;
}

// Only sync non-sensitive settings (never API keys or PIN hashes)
async function syncSettingsToCloud(settings) {
  try {
    const { pinHash, pinSalt, anthropicApiKey, ...syncable } = settings;
    await chrome.storage.sync.set({ sg_sync_settings: syncable });
  } catch (err) {
    console.warn("[SG] Sync to cloud failed:", err.message);
  }
}

// ── Tiered keyword library ────────────────────────────────────────────────────
function maxTier(sensitivity) {
  if (sensitivity >= 0.7) return 3;
  if (sensitivity >= 0.4) return 2;
  return 1;
}

const TIERED_FLAGS = {
  self_harm: [
    { kw: "suicide",        tier: 1 }, { kw: "kill myself",    tier: 1 },
    { kw: "end my life",    tier: 1 }, { kw: "cutting myself", tier: 1 },
    { kw: "self-harm",      tier: 1 }, { kw: "self harm",      tier: 1 },
    { kw: "want to die",    tier: 2 }, { kw: "hurt myself",    tier: 2 },
    { kw: "not worth living", tier: 2 }, { kw: "overdose",     tier: 3 },
    { kw: "razor",          tier: 3 }, { kw: "depressed",      tier: 3 },
  ],
  violence: [
    { kw: "shooting",       tier: 1 }, { kw: "gun fight",      tier: 1 },
    { kw: "knife attack",   tier: 1 }, { kw: "stabbed",        tier: 1 },
    { kw: "murder",         tier: 1 }, { kw: "massacre",       tier: 1 },
    { kw: "fight compilation", tier: 2 }, { kw: "beat up",     tier: 2 },
    { kw: "knocked out",    tier: 2 }, { kw: "kill",           tier: 2 },
    { kw: "blood",          tier: 2 }, { kw: "brawl",          tier: 3 },
    { kw: "punch",          tier: 3 }, { kw: "slap",           tier: 3 },
    { kw: "fight",          tier: 3 }, { kw: "wrestling",      tier: 3 },
    { kw: "revenge",        tier: 3 }, { kw: "I will kill you", tier: 3 },
    { kw: "ufc",            tier: 3 }, { kw: "I hate you",     tier: 3 },
    { kw: "Boxing",         tier: 3 }, { kw: "punch your face", tier: 3 },
    { kw: "kill shot",      tier: 3 }, { kw: "robbery ",       tier: 3 }, 
    { kw: "Rape",           tier: 3 }, { kw: "Battle",         tier: 3 },
    { kw: "Killed",         tier: 3 }, { kw: "Assasins",       tier: 3 }, 
    { kw: "War",            tier: 3 }, { kw: "Brutal",          tier: 3 },
    { kw: "Gunsmith",       tier: 3 }, { kw: "Assinate",       tier: 3 },
    { kw: "Deadly",         tier: 3 }, { kw: "army",           tier: 3 },
    { kw: "Died",           tier: 1 }, { kw: "Dead",           tier: 1 },  
    { kw: "Fight",          tier: 2 }, { kw: "Soldier",        tier: 3 },
    { kw: "WW2",            tier: 3 }, { kw: "ww2",            tier: 3 },
    { kw: "mma",            tier: 3 },  { kw: "Terrorist",      tier: 3 },
    { kw: "Kung Fu",        tier: 3 },  { kw: "kung fu",        tier: 3 },
    { kw: "War",            tier: 3 },  { kw: "mma",            tier: 3 },
    { kw: "Enemies",        tier: 3 },  { kw: "martial arts",   tier: 3 },
    { kw: "vs",             tier: 3 },  { kw: "stabbing",       tier: 3 },
    { kw: "Revenge",        tier: 3 },  { kw: "Bullying",       tier: 3 },
    { kw: "bully",          tier: 3 },  { kw: "Risk",           tier: 2 },
    { kw: "Uppercut",       tier: 3 },  { kw: "Modern warfare", tier: 3 },
    { kw: "Enemies",        tier: 3 },  { kw: "Us Army",        tier: 3 },
  ],
  weapons: [
    { kw: "gun",            tier: 2 }, { kw: "Rifle",          tier: 3 },
    { kw: "pistol",         tier: 3 }, { kw: "firearm",        tier: 3 },
    { kw: "ak-47",          tier: 1 }, { kw: "loaded weapon",  tier: 1 },
    { kw: "knife",          tier: 3 }, { kw: "sword",          tier: 3 },
    { kw: "weapon",         tier: 2 }, { kw: "ammo",           tier: 2 },
    { kw: "shooting range", tier: 3 }, { kw: "airsoft",        tier: 3 },
    { kw: "bb gun",         tier: 3 }, { kw: "sniper",         tier: 3 },
    { kw: "best shot",      tier: 3 }, { kw: "hunting",        tier: 3 },
    { kw: "missle",         tier: 3},  { kw: "hitman",         tier: 3 },
    { kw: "gattling gun",   tier: 3},  { kw: "Blade",          tier: 3 },
    { kw: "Chainsaw",       tier: 3},  { kw: "Tank",           tier: 3 },
    { kw: "Spear",          tier: 3},  { kw: "Plane Jet",      tier: 3 },
    { kw: "Fire works",     tier: 3},  { kw: "bomb",           tier: 3 },
    { kw: "Grenade",        tier: 3},  { kw: "Sniper",         tier: 3 },
    { kw: "Shooting",       tier: 3},  { kw: "Air Gun",        tier: 3 },
    { kw: "Bullet",         tier: 3},  { kw: "Shotgun",        tier: 3 },
    { kw: "Enemy ",         tier: 3},  { kw: "Uzi",            tier: 3 },
    { kw: "Revolver",       tier: 3},  { kw: "Shotgun",        tier: 3 },
    { kw: "Reload",         tier: 3},  { kw: "Smg",            tier: 3 },
    { kw: "Arms",           tier: 2},  { kw: "DESERT EAGLE",   tier: 3 },
    { kw: "NGSW",           tier: 3},  { kw: "Assault Rifle",  tier: 3 },
    { kw: "Machine Gun",    tier: 3},  { kw: "Bullet",         tier: 3 },
    { kw: "Pellet Gun",     tier: 3}, 
  ],
  substances: [
    { kw: "vaping",         tier: 1 }, { kw: "vape",           tier: 1 },
    { kw: "marijuana",      tier: 1 }, { kw: "weed",           tier: 1 },
    { kw: "cocaine",        tier: 1 }, { kw: "meth",           tier: 1 },
    { kw: "heroin",         tier: 1 }, { kw: "get high",       tier: 1 },
    { kw: "drunk challenge", tier: 2 }, { kw: "drug",          tier: 2 },
    { kw: "blunt",          tier: 2 }, { kw: "edible",         tier: 3 },
    { kw: "buzzed",         tier: 3 }, { kw: "hangover",       tier: 3 },
    { kw: "Explosive",      tier: 3 }, 
  ],
  alcohol_tobacco: [
    // Direct, unambiguous substance names — always caught, regardless of
    // sensitivity, same as marijuana/cocaine/meth/heroin under `substances`.
    // These used to sit at tier 3 (only caught at HIGH sensitivity), which
    // meant a title with the literal word "alcohol" or "beer" was invisible
    // at the default (MEDIUM) sensitivity setting.
    { kw: "beer bong",      tier: 3 }, { kw: "shots challenge", tier: 1 },
    { kw: "alcohol",        tier: 3 }, { kw: "beer",           tier: 3 },
    { kw: "wine",           tier: 3 }, { kw: "vodka",          tier: 3 },
    { kw: "whiskey",        tier: 3 }, { kw: "tequila",        tier: 3 },
    { kw: "rum",            tier: 3 }, { kw: "cigarette",      tier: 3 },
    { kw: "smoking",        tier: 1 }, { kw: "vaping",         tier: 1 },
    { kw: "red horse",      tier: 3 }, 
    // Slang / behavioral phrases — still fairly clear, medium sensitivity.
    { kw: "drinking game",  tier: 2 }, { kw: "getting drunk",  tier: 2 },
    { kw: "smoking weed",   tier: 2 }, { kw: "cigar",          tier: 2 },
    // More ambiguous / context-dependent — could appear in unrelated
    // contexts (e.g. a recipe video), so gated behind HIGH sensitivity.
    { kw: "champagne",      tier: 3 }, { kw: "cocktail",       tier: 3 },
    { kw: "Nicotine",       tier: 3},  { kw: "tobacco",        tier: 3 },
    { kw: "Liquor",         tier: 3},  { kw: "LIQUOR",         tier: 3},
  ],
  sexual_content: [
    { kw: "onlyfans",       tier: 1 }, { kw: "nsfw",           tier: 1 },
    { kw: "nude",           tier: 1 }, { kw: "sex tape",       tier: 1 },
    { kw: "naked",          tier: 1 }, { kw: "18+",            tier: 1 },
    { kw: "explicit",       tier: 2 }, { kw: "sexual",         tier: 2 },
    { kw: "seductive",      tier: 3 }, { kw: "thirst trap",    tier: 3 },
    { kw: "Fuck You!",      tier: 3 }, { kw: "kiss",           tier: 3 },
    { kw: "Clinggy",        tier: 3 },   
  ],
  bullying: [
    { kw: "kys",            tier: 1 }, { kw: "kill yourself",  tier: 1 },
    { kw: "you're worthless", tier: 1 }, { kw: "hate you",     tier: 2 },
    { kw: "ugly loser",     tier: 2 }, { kw: "roast me",       tier: 3 },
    { kw: "ratio",          tier: 3 }, { kw: "Punch",          tier: 3 },
  ],
  // Romance/kissing — title-based detection for when no API key is present
  romance: [
    { kw: "kissing",        tier: 3 }, { kw: "making out",     tier: 3 },
    { kw: "hook up",        tier: 3 }, { kw: "hookup",         tier: 3 },
    { kw: "kiss prank",     tier: 3 }, { kw: "couple prank",   tier: 3 },
    { kw: "first kiss",     tier: 3 }, { kw: "bf gf",          tier: 3 },
    { kw: "boyfriend",      tier: 3 }, { kw: "girlfriend",     tier: 3 },
    { kw: "romantic",       tier: 3 }, { kw: "couple",         tier: 3 },
    { kw: "kissing scene",  tier: 3 }, { kw: "ROMANTIC SCENE", tier: 3 },
    { kw: "darkromance",    tier: 3 }, { kw: "Romantic moments", tier: 3 },
    { kw: "cdrama",         tier: 3 }, { kw: "Couple kiss",    tier: 3 },
    { kw: "KISSING",        tier: 3 },
  ],
  // Horror / scary content
  horror_scary: [
    { kw: "horror",         tier: 3 }, { kw: "jumpscare",      tier: 3 },
    { kw: "jump scare",     tier: 3 }, { kw: "scary movie",    tier: 3 },
    { kw: "terrifying",     tier: 3 }, { kw: "demon",          tier: 3 },
    { kw: "possessed",      tier: 3 }, { kw: "haunted",        tier: 3 },
    { kw: "ghost",          tier: 3 }, { kw: "creepy",         tier: 3 },
    { kw: "disturbing",     tier: 2 }, { kw: "nightmare",      tier: 3 },
    { kw: "skull",          tier: 3 }, { kw: "zombie",         tier: 3 },
    { kw: "monster",        tier: 3 }, { kw: "scary",          tier: 3 },
    { kw: "Demon",          tier: 3 }, { kw: "Grim Reaper",    tier: 3 },
    { kw: "Switch",         tier: 3 }, { kw: "Penny Wise",     tier: 3 },
    { kw: "Demon",          tier: 3 },
  ],
  // Explicitly flagged / mature content markers
  flagged_content: [
    { kw: "graphic content", tier: 1 }, { kw: "viewer discretion", tier: 1 },
    { kw: "not for kids",    tier: 1 }, { kw: "18 and up",         tier: 1 },
    { kw: "mature content",  tier: 1 }, { kw: "trigger warning",   tier: 2 },
    { kw: "sensitive content", tier: 2 }, { kw: "parental advisory", tier: 2 },
    { kw: "age restricted",  tier: 2 }, { kw: "explicit content",  tier: 1 },
  ],
};


function scanFlags(text, sensitivity) {
  const lower     = (text || "").toLowerCase();
  const tierLimit = maxTier(sensitivity);
  return Object.entries(TIERED_FLAGS)
    .filter(([, entries]) => entries.some(e => e.tier <= tierLimit && lower.includes(e.kw)))
    .map(([category]) => category);
}

// ── Claude Vision API ─────────────────────────────────────────────────────────
function visionSystemPrompt(sensitivity) {
  const tier = maxTier(sensitivity);
  const tierNote =
    tier === 1
      ? "Beyond the ALWAYS-FLAG list below, only mark tier as \"concern\" for other clearly explicit content: graphic violence, non-romantic sexual content, drug use in progress, or self-harm depictions."
      : tier === 2
      ? "Beyond the ALWAYS-FLAG list below, also mark tier as \"concern\" for moderately concerning content: weapons shown casually, alcohol/tobacco featured prominently, fighting, drug paraphernalia, suggestive content."
      : "Beyond the ALWAYS-FLAG list below, mark tier as \"concern\" broadly: any weapon-like object (even toys or games), any alcohol visible, rough-housing, anything a cautious parent might want to review.";
  return `You are a content classifier for a parental monitoring tool. Given a screenshot from a YouTube Short, look carefully at the entire frame, including background and partially-obscured details.\n\nALWAYS mark tier as "concern" — regardless of sensitivity level — if ANY of these are visible:\n  • A gun or firearm of any kind is visible anywhere in the frame, even holstered or in the background. category="weapons".\n  • Someone is depicted being killed, a dead body is shown, or the scene depicts fatal violence. category="violence".\n  • People are kissing, making out, or in clear romantic/intimate physical contact. category="romance".\n\nFor anything else, apply this sensitivity guidance: ${tierNote}\n\nRespond ONLY with a JSON object, no other text:\n{"category":"<one of: weapons, alcohol_tobacco, violence, sexual_content, romance, substances, horror_scary, flagged_content, gaming, animals, food, sports, music, education, comedy, other>","tier":"<concern or neutral>","label":"<3-5 word description of exactly what's shown>","confidence":<0.0-1.0>}\n\nSensitivity level: ${tier === 1 ? "LOW" : tier === 2 ? "MEDIUM" : "HIGH"}`;
}

async function analyzeImageWithClaude(dataUrl, title, apiKey, sensitivity) {
  if (!apiKey || !dataUrl) return { category: "other", tier: "neutral", label: "no_api_key", confidence: 0 };
  const base64 = dataUrl.split(",")[1];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 140,
        system: visionSystemPrompt(sensitivity),
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text",  text: `Video title: "${title || "unknown"}"` },
        ]}],
      }),
    });
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    const data   = await res.json();
    const text   = data.content?.[0]?.text || "{}";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    const ALWAYS_FLAG = new Set(["weapons", "violence", "romance"]);
    const isAlwaysFlag = ALWAYS_FLAG.has(parsed.category);
    const confidenceThreshold = isAlwaysFlag ? 0.35 : (sensitivity >= 0.7 ? 0.5 : 0.75);
    const effectiveTier = parsed.tier === "concern" && (parsed.confidence ?? 1) >= confidenceThreshold ? "concern" : "neutral";
    return { category: parsed.category || "other", tier: effectiveTier, label: parsed.label || "unknown", confidence: parsed.confidence ?? null };
  } catch (err) {
    console.warn("[SG] Vision API error:", err.message);
    return { category: "other", tier: "neutral", label: "api_error", confidence: null };
  }
}

// ── Gmail Email Notification ──────────────────────────────────────────────────
// Uses Gmail API via chrome.identity OAuth (no server required).
// Parent must have enabled email notifications and provided their Gmail address.
// We request an access token silently first; only prompt if strictly necessary.

async function sendEmailNotification(settings, logEntry) {
  if (!settings.emailNotifyEnabled || !settings.parentEmail) return;

  try {
    // Get OAuth token for Gmail API (non-interactive — uses cached token only).
    // The parent must have clicked "Connect Gmail" in the dashboard first,
    // which is where the interactive consent flow runs (user gesture required).
    let token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      });
    });

    const sendOnce = (bearer) => {
      const { title, channel, url, category, mtrcbRating, finalVerdict, weightedScore,
              textFlags, audioFlags, imageLabel, transcript, ts } = logEntry;

      const timestamp = new Date(ts).toLocaleString();
      const flagList  = [...new Set([...(textFlags||[]), ...(audioFlags||[])])].join(", ") || "none";
      const reasonsHtml = `
        <li><strong>Category detected:</strong> ${category}</li>
        <li><strong>MTRCB Rating:</strong> ${mtrcbRating}</li>
        <li><strong>Inappropriateness score:</strong> ${Math.round((weightedScore||0)*100)}%</li>
        <li><strong>Keyword flags:</strong> ${flagList}</li>
        ${imageLabel ? `<li><strong>Visual analysis:</strong> ${imageLabel}</li>` : ""}
        ${transcript ? `<li><strong>Audio transcript excerpt:</strong> "${transcript.slice(0,200)}"</li>` : ""}
      `;

    const emailHtml = `
<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1b2b24;max-width:600px;margin:0 auto">
<div style="background:#1e4a40;padding:20px 24px;border-radius:10px 10px 0 0">
  <h1 style="color:white;font-size:18px;margin:0">⚑ Shorts Guardian Alert</h1>
  <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:13px">A YouTube Short was flagged as <strong style="color:#ffb38a">${finalVerdict}</strong></p>
</div>
<div style="background:#fff;border:1px solid #d0dbd7;border-top:none;padding:24px;border-radius:0 0 10px 10px">
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eef1ef;color:#5a7068;font-size:12px;width:140px">Video title</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef1ef;font-weight:600">${title || "(no title)"}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eef1ef;color:#5a7068;font-size:12px">Channel</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef1ef">${channel || "—"}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eef1ef;color:#5a7068;font-size:12px">Detected at</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef1ef">${timestamp}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eef1ef;color:#5a7068;font-size:12px">MTRCB Rating</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef1ef">
          <span style="background:#fdf0eb;color:#c8643c;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">${mtrcbRating}</span>
        </td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eef1ef;color:#5a7068;font-size:12px">Reasons flagged</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef1ef"><ul style="margin:0;padding-left:16px;font-size:13px">${reasonsHtml}</ul></td></tr>
  </table>
  <div style="margin-top:20px">
    <a href="${url}" style="display:inline-block;background:#2f6f62;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View video →</a>
    <a href="${chrome.runtime.getURL('app.html')}" style="display:inline-block;margin-left:10px;background:#f0f4f1;color:#1e4a40;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Open Dashboard →</a>
  </div>
  <p style="font-size:11px;color:#9aada7;margin-top:20px">
    Shorts Guardian — on-device content monitor. The video was automatically skipped.<br>
    To disable these emails, open the dashboard → Settings → Email Notifications.
  </p>
</div>
</body></html>`;

      const subject  = `[Shorts Guardian] ⚑ Flagged: "${(title||"Untitled").slice(0,60)}"`;
      const boundary = "sg_boundary_" + Date.now();

      const rawEmail = [
        `To: ${settings.parentEmail}`,
        `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Shorts Guardian Alert\n\nA YouTube Short was flagged: "${title}"\nChannel: ${channel}\nRating: ${mtrcbRating}\nAt: ${timestamp}\n\nView: ${url}`,
        "",
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        emailHtml,
        "",
        `--${boundary}--`,
      ].join("\r\n");

      const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      return fetch(
        "https://www.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: encoded }),
        }
      );
    };

    let gmailRes = await sendOnce(token);

    // A cached token can go stale — expired, revoked, or left over from a
    // Gmail account the parent has since switched away from. Gmail returns
    // 401 for that. Instead of failing silently forever, drop the bad token
    // and retry once with whatever token is available.
    if (gmailRes.status === 401) {
      console.warn("[SG] Gmail token rejected (401) — clearing cached token and retrying once.");
      await new Promise(res => chrome.identity.removeCachedAuthToken({ token }, res));
      try {
        token = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: false }, (t) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(t);
          });
        });
        gmailRes = await sendOnce(token);
      } catch (retryErr) {
        console.warn("[SG] Retry after 401 failed — Gmail needs to be reconnected in Settings:", retryErr.message);
        return;
      }
    }

    if (!gmailRes.ok) {
      const errBody = await gmailRes.text();
      console.warn("[SG] Gmail send failed:", gmailRes.status, errBody);
    } else {
      console.log("[SG] Email notification sent to", settings.parentEmail);
    }
  } catch (err) {
    // Token not available silently (user never granted) — skip without crashing
    console.warn("[SG] Email notification skipped:", err.message);
  }
}

// ── Persist result + update badge ─────────────────────────────────────────────
async function saveResult(result) {
  const settings = await getSettings();
  const stored   = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  let logs       = stored[STORAGE_KEYS.LOGS] || [];

  logs.push(result);

  const cutoff = Date.now() - settings.retentionDays * 86_400_000;
  logs = logs.filter(l => l.ts >= cutoff);
  if (logs.length > settings.maxLogs) logs = logs.slice(logs.length - settings.maxLogs);

  await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs });

  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const flaggedToday = logs.filter(l => l.flagged && l.ts >= sod.getTime()).length;

  if (flaggedToday > 0) {
    chrome.action.setBadgeText({ text: String(Math.min(flaggedToday, 99)) });
    chrome.action.setBadgeBackgroundColor({ color: "#C8643C" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ── Main classification pipeline ──────────────────────────────────────────────
// ── Persist blocked video ID ─────────────────────────────────────────────────
// Stores a compact record per blocked videoId so content.js can immediately
// re-block on revisit without re-running the full classification pipeline.
// Entries are pruned on the same retentionDays schedule as logs.
async function saveBlockedId(videoId, { reason, rating, title, category }) {
  const settings = await getSettings();
  const stored   = await chrome.storage.local.get(STORAGE_KEYS.BLOCKED);
  const blocked  = stored[STORAGE_KEYS.BLOCKED] || {};

  blocked[videoId] = { ts: Date.now(), reason, rating, title, category };

  // Prune entries older than retentionDays to keep storage tidy
  const cutoff = Date.now() - settings.retentionDays * 86_400_000;
  for (const [id, entry] of Object.entries(blocked)) {
    if (entry.ts < cutoff) delete blocked[id];
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.BLOCKED]: blocked });
}

async function handleClassify(payload, tab) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const now      = Date.now();
  const minGap   = Math.max(settings.captureIntervalSec * 1_000, MIN_GAP_MS);
  const lastSeen = lastSentByVideoId.get(payload.videoId) || 0;
  if (now - lastSeen < minGap) return;
  lastSentByVideoId.set(payload.videoId, now);

  const sensitivity = settings.sensitivity ?? 0.5;

  // Step 1 — tiered keyword scan (text)
  // scanFlags uses tier-gated keywords. We also run a direct violence/weapons
  // title scan at tier-1 severity regardless of sensitivity setting, because
  // titles like "gun violence", "fight compilation", "shooting" are unambiguous.
  const titleLower = ((payload.title || "") + " " + (payload.channel || "")).toLowerCase();

  // Unambiguous keywords that always fire regardless of sensitivity setting.
  // These supplement scanFlags() which is tier-gated.
  const directTitleFlags = [];

  if (["gun","guns","gunshot","shooting","shot dead","shot fired","gunfight","gun fight",
       "firearm","armed","at gunpoint"].some(kw => titleLower.includes(kw))) {
    directTitleFlags.push("weapons");
  }
  if (["fight","fighting","brawl","knockout","ko","knocked out","stabbed","stabbing",
       "knife attack","beat up","beating","murder","killing","kills","killed","violence",
       "violent","blood","gore","war footage","combat","massacre","execution","attack",
       "assault","gang fight","street fight","punch","punching"].some(kw => titleLower.includes(kw))) {
    directTitleFlags.push("violence");
  }
  if (["kissing","making out","hook up","hookup","kiss prank","first kiss",
       "couple prank","romantic couple","kiss challenge"].some(kw => titleLower.includes(kw))) {
    directTitleFlags.push("romance");
  }
  if (["horror","jumpscare","jump scare","scary movie","terrifying","demon","possessed",
       "haunted","ghost story","creepy","disturbing","nightmare","zombie","monster"].some(kw => titleLower.includes(kw))) {
    directTitleFlags.push("horror_scary");
  }
  if (["viewer discretion","graphic content","not for kids","mature content",
       "trigger warning","age restricted","parental advisory"].some(kw => titleLower.includes(kw))) {
    directTitleFlags.push("flagged_content");
  }

  const textFlags = [...new Set([
    ...scanFlags((payload.title || "") + " " + (payload.channel || ""), sensitivity),
    ...directTitleFlags,
  ])];

  // Step 2 — screenshot + image classification
  let dataUrl = null;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
  } catch (err) {
    console.warn("[SG] Screenshot capture failed:", err.message);
  }

  let imageResult = { category: "other", tier: "neutral", label: "no_screenshot", confidence: null, inferenceMs: null };
  let visionMode  = "none";
  let textSentimentScore = 0;
  // ── Model-performance tracking (MobileNet + DistilBERT) ────────────────────
  // Only populated on the "on_device" path — the Claude Vision path replaces
  // both local models, so there is nothing to measure for them on that run.
  let textSentimentLabel = "N/A"; // DistilBERT output label: POSITIVE / NEGATIVE / UNKNOWN / ERROR / N/A
  let textInferenceMs = null;

  if (dataUrl && settings.anthropicApiKey) {
    imageResult = await analyzeImageWithClaude(dataUrl, payload.title, settings.anthropicApiKey, sensitivity);
    visionMode  = "claude";
  } else if (dataUrl) {
    const onDevice = await classifyWithOffscreen({ dataUrl, title: payload.title });
    if (onDevice) {
      const sentimentConcern =
        onDevice.textSentiment === "NEGATIVE" && onDevice.textScore > 0.85 && sensitivity >= 0.7;
      textSentimentScore = onDevice.textScore || 0;
      textSentimentLabel = onDevice.textSentiment || "UNKNOWN";
      textInferenceMs = onDevice.textInferenceMs ?? null;
      imageResult = {
        category:   onDevice.category,
        tier:       onDevice.categoryTier === "concern" || sentimentConcern ? "concern" : "neutral",
        label:      onDevice.imageLabel,
        confidence: onDevice.imageConfidence,
        inferenceMs: onDevice.imageInferenceMs ?? null,
      };
    } else {
      imageResult = { category: "other", tier: "neutral", label: "on_device_unavailable", confidence: null, inferenceMs: null };
      textSentimentLabel = "UNAVAILABLE"; // offscreen doc unreachable — DistilBERT never ran
    }
    // If on-device image classification returned generic "other/neutral"
    // but we already detected a concern from the title, upgrade imageResult
    // so computeWeightedScore assigns partial visual credit.
    if (imageResult.tier === "neutral" && imageResult.category === "other" && directTitleFlags.length > 0) {
      imageResult = {
        category:   directTitleFlags[0],
        tier:       "neutral", // partial credit path — not full concern
        label:      "title_keyword_detected",
        confidence: null,
        inferenceMs: imageResult.inferenceMs ?? null,
      };
    }
    visionMode = "on_device";
  }

  // Step 3 — audio transcription + keyword scan
  let audioFlags = [], transcript = "", audioMode = "none";
  if (settings.audioScanEnabled && tab?.id) {
    const audioResult = await captureAndTranscribeAudio(tab, settings.audioClipSeconds || 6);
    if (audioResult?.transcript) {
      transcript = audioResult.transcript;
      audioFlags = scanFlags(transcript, sensitivity);
      audioMode  = "on_device";
    } else {
      audioMode = "unavailable";
    }
  }

  // ── Step 4: Weighted final score & verdict ────────────────────────────────
  const weightedScore = computeWeightedScore({
    imageResult,
    textFlags,
    audioFlags,
    textScore: textSentimentScore,
  });
  const finalVerdict = weightedScore >= 0.5 || textFlags.length > 0 || audioFlags.length > 0 || imageResult.tier === "concern"
    ? "Inappropriate" : "Appropriate";

  // ── Step 5: MTRCB Rating ──────────────────────────────────────────────────
  const mtrcbRating = deriveMtrcbRating(imageResult.category, textFlags, audioFlags, imageResult);

  // ── Determine user category from child profile age ───────────────────────
  // ageRating is the CHILD'S access level (G / PG / SPG), derived from age.
  // mtrcbRating is the VIDEO'S content classification.
  // A video is blocked when its rating exceeds the child's permitted level.
  const profileData    = await chrome.storage.local.get("sg_profile");
  const childAge       = profileData?.sg_profile?.age ?? null;
  const ageRating      = ageToMtrcbCategory(childAge);  // child's category
  const effectiveBlocked = MTRCB_BLOCKED[ageRating] || MTRCB_BLOCKED.PG;

  // Primary gate: is the video's MTRCB rating allowed for this child's category?
  // G user → only G; PG user → G+PG; SPG user → G+PG+SPG
  const ratingExceedsCategory = !isVideoAllowedForCategory(mtrcbRating, ageRating);

  // Secondary gate: content-category check (catches flagged_content, etc.)
  const blockedCats = (settings.blockedCategories?.length > 0)
    ? settings.blockedCategories
    : effectiveBlocked;
  const categoryFlagged =
    textFlags.some(f => blockedCats.includes(f)) ||
    audioFlags.some(f => blockedCats.includes(f)) ||
    (imageResult.tier === "concern" && blockedCats.includes(imageResult.category));

  // A video is flagged if its rating exceeds the child's level OR content is blocked
  const flagged = ratingExceedsCategory || categoryFlagged;

  const checksRun = {
    title: true,
    image: dataUrl ? true : false,
    audio: audioMode === "on_device",
  };

  // ── Snapshot thumbnail ────────────────────────────────────────────────────
  let snapshot = null;
  if (dataUrl && settings.saveSnapshots && (flagged || settings.saveSnapshotsAllShorts)) {
    snapshot = await makeThumbnail(dataUrl);
  }

  // ── TTS / Audio classification label ─────────────────────────────────────
  let ttsClassification = "N/A";
  if (audioMode === "on_device") {
    ttsClassification = audioFlags.length > 0 ? "Inappropriate" : "Appropriate";
  }

  const logEntry = {
    ts:               now,
    videoId:          payload.videoId,
    url:              payload.url,
    title:            payload.title,
    channel:          payload.channel,
    category:         imageResult.category,
    categoryTier:     imageResult.tier,
    imageLabel:       imageResult.label,
    imageConfidence:  imageResult.confidence,
    imageInferenceMs: imageResult.inferenceMs ?? null,
    textFlags,
    audioFlags,
    transcript:       transcript ? transcript.slice(0, 400) : "",
    ttsClassification,
    flagged,
    sensitivity,
    visionMode,
    audioMode,
    // ── Model-performance fields (only meaningful when visionMode === "on_device") ──
    textSentiment:      textSentimentLabel,  // DistilBERT: POSITIVE / NEGATIVE / UNKNOWN / ERROR / UNAVAILABLE / N/A
    textSentimentScore, // DistilBERT confidence 0–1 for the label above
    textInferenceMs,    // DistilBERT wall-clock inference time in ms (measured in offscreen.js)
    checksRun,
    snapshot,
    // ── v1.4 new fields ──
    weightedScore,
    finalVerdict,
    mtrcbRating,
    ageRating,
  };

  await saveResult(logEntry);

  // ── Email notification ────────────────────────────────────────────────────
  if (flagged && settings.emailNotifyEnabled) {
    sendEmailNotification(settings, logEntry).catch(() => {});
  }

  // ── Block + auto-skip ────────────────────────────────────────────────────
  // Step 1: send SG_BLOCK_SHORT immediately — content.js shows an overlay
  //         that hides the video frame the instant the flag is confirmed.
  // Step 2: send SG_SKIP_SHORT after a short pause so YouTube's own
  //         navigation fires after the overlay is in place (avoids a flash
  //         of the flagged frame during the SPA route transition).
  if (flagged && tab?.id) {
    const blockReason = textFlags.length > 0 ? textFlags[0] : (audioFlags.length > 0 ? audioFlags[0] : imageResult.category);

    // Persist to blocked-IDs store so revisits are caught immediately
    await saveBlockedId(payload.videoId, {
      reason:       blockReason,
      rating:       mtrcbRating,    // the video's MTRCB rating
      userCategory: ageRating,      // the child's access category
      title:        payload.title,
      category:     imageResult.category,
    });

    chrome.tabs.sendMessage(tab.id, {
      type:         "SG_BLOCK_SHORT",
      videoId:      payload.videoId,
      category:     imageResult.category,
      reason:       blockReason,
      rating:       mtrcbRating,    // video's rating
      userCategory: ageRating,      // child's category (for block message)
    }).catch(() => {});

    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: "SG_SKIP_SHORT", videoId: payload.videoId }).catch(() => {});
    }, 300);  // overlay is already up — skip can be near-instant
  }
}

// ── Unified message listener ──────────────────────────────────────────────────
// All chrome.runtime.onMessage handling consolidated here to avoid the
// ambiguity of multiple listeners receiving every message and one returning
// false while others resolve pending-map promises.
chrome.runtime.onMessage.addListener((msg, sender) => {
  // ── Offscreen classification result ──────────────────────────────────────
  if (msg?.type === MSG_CLASSIFY_RESULT) {
    const pending = pendingOffscreenRequests.get(msg.payload?.requestId);
    if (pending) {
      pendingOffscreenRequests.delete(msg.payload.requestId);
      pending.resolve(msg.payload);
    }
    return false;
  }

  // ── Offscreen audio transcription result ──────────────────────────────────
  if (msg?.type === MSG_TRANSCRIBE_RESULT) {
    const pending = pendingAudioRequests.get(msg.payload?.requestId);
    if (pending) {
      pendingAudioRequests.delete(msg.payload.requestId);
      pending.resolve(msg.payload);
    }
    return false;
  }

  // ── Revisit check: content.js asks if a videoId is already blocked ─────────
  // This runs synchronously (no async needed) — we read from local storage
  // and reply via sendResponse before the listener returns.
  if (msg?.type === "SG_CHECK_BLOCKED") {
    getSettings().then((settings) => {
      // Monitoring is off — never re-block, regardless of past flags.
      if (!settings.enabled) {
        try { sender && chrome.tabs.sendMessage(sender.tab.id, {
          type:         "SG_CHECK_BLOCKED_RESULT",
          videoId:      msg.videoId,
          blocked:      false,
        }); } catch (_) {}
        return;
      }

      chrome.storage.local.get(STORAGE_KEYS.BLOCKED, (stored) => {
        const blocked = stored[STORAGE_KEYS.BLOCKED] || {};
        const entry   = blocked[msg.videoId] || null;
        try { sender && chrome.tabs.sendMessage(sender.tab.id, {
          type:         "SG_CHECK_BLOCKED_RESULT",
          videoId:      msg.videoId,
          blocked:      !!entry,
          reason:       entry?.reason        || null,
          rating:       entry?.rating        || null,   // video's MTRCB rating
          userCategory: entry?.userCategory  || null,   // child's access category
          title:        entry?.title         || null,
        }); } catch (_) {}
      });
    });
    return false;
  }

  // ── New Short detected by content script ─────────────────────────────────
  if (msg?.type === "SG_CLASSIFY_SHORT" && sender.tab) {
    handleClassify(msg.payload, sender.tab).catch(console.error);
    return false;
  }

  // ── Settings sync request from dashboard ─────────────────────────────────
  if (msg?.type === "SG_SYNC_SETTINGS") {
    getSettings().then(s => syncSettingsToCloud(s)).catch(() => {});
    return false;
  }

  // ── Gmail OAuth ───────────────────────────────────────────────────────────
  // Must be triggered by a user gesture (button click in dashboard).
  // After approval the token is cached; sendEmailNotification() retrieves
  // it silently (interactive: false) with no popup needed.
  //
  // IMPORTANT: getAuthToken({interactive:true}) alone will silently reuse
  // whatever Google account is already cached — it will NOT show the account
  // picker again. That's why "connect a different Gmail" used to appear to
  // do nothing. We clear the cached token first so Chrome re-prompts and
  // the parent can actually pick/switch accounts.
  if (msg?.type === "SG_AUTH_GMAIL") {
    chrome.identity.getAuthToken({ interactive: false }, (oldToken) => {
      const clearOld = oldToken
        ? new Promise(res => chrome.identity.removeCachedAuthToken({ token: oldToken }, res))
        : Promise.resolve();
      clearOld.then(() => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          const success = !chrome.runtime.lastError && !!token;
          chrome.runtime.sendMessage({
            type: "SG_AUTH_GMAIL_RESULT",
            success,
            error: chrome.runtime.lastError?.message || null,
          }).catch(() => {});
        });
      });
    });
    return false;
  }

  return false;
});

// ── Listen for chrome.storage.sync changes (cross-device push) ───────────────
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes.sg_sync_settings) {
    // Merge synced settings into local storage
    const local = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const curr  = { ...DEFAULT_SETTINGS, ...(local[STORAGE_KEYS.SETTINGS] || {}) };
    const synced = changes.sg_sync_settings.newValue || {};
    // Never overwrite sensitive local-only fields from sync
    const { pinHash, pinSalt, anthropicApiKey } = curr;
    // Also never wipe blockedCategories with an empty array from sync
    if (!synced.blockedCategories || synced.blockedCategories.length === 0) {
      delete synced.blockedCategories;
    }
    const merged = { ...curr, ...synced, pinHash, pinSalt, anthropicApiKey };
    // Final guard
    if (!merged.blockedCategories || merged.blockedCategories.length === 0) {
      merged.blockedCategories = DEFAULT_SETTINGS.blockedCategories;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
    console.log("[SG] Settings synced from another device.");
  }
});
