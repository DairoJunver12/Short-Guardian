// ── Shorts Guardian — Offscreen Classifier ───────────────────────────────────
// offscreen.html loads:
//   1. tf.min.js          → window.tf  (UMD)
//   2. mobilenet.min.js   → window.mobilenet  (UMD)
//   3. offscreen-loader.js (type=module) → window.TransformersLib
//   4. THIS file (plain script) — runs after 1+2 are ready
//
// AUDIO CAPTURE — WHY THIS APPROACH:
//
// chrome.tabCapture streamIds can only be consumed by getUserMedia in
// extension pages (background, offscreen, popup). Content scripts get
// "Error starting tab capture" regardless of how they call getUserMedia.
//
// Offscreen documents CAN open the stream, but have no real audio output
// device, so Chrome's audio scheduler doesn't pull the Web Audio graph —
// ScriptProcessorNode.onaudioprocess never fires, and MediaRecorder's
// ondataavailable push path also produces empty chunks.
//
// THE FIX — forced polling with requestData():
//
// MediaRecorder in an offscreen doc does accumulate compressed audio data
// internally; it just never pushes ondataavailable on its own because that
// push is tied to the audio clock. Calling recorder.requestData() on a tight
// setInterval (every 250 ms) forces the browser to flush whatever it has
// buffered so far, bypassing the clock-driven push. Combined with an early-
// exit check (if chunks are still 0 bytes after the first ~1 s we know the
// stream is truly silent/broken and bail), this reliably captures audio when
// the Short is playing.

const MSG_CLASSIFY_SHORT    = "SG_CLASSIFY_SHORT";
const MSG_CLASSIFY_RESULT   = "SG_CLASSIFY_RESULT";
const MSG_TRANSCRIBE_AUDIO  = "SG_TRANSCRIBE_AUDIO";
const MSG_TRANSCRIBE_RESULT = "SG_TRANSCRIBE_RESULT";

// ── Category map ─────────────────────────────────────────────────────────────
// MobileNet classifies ImageNet objects — it cannot detect actions like
// "fighting" directly. We catch violence/weapons by matching every ImageNet
// label relevant to those contexts, PLUS a title-keyword heuristic
// (VIOLENCE_TITLE_KW) applied when MobileNet returns a generic label but
// the title contains strong fighting/violence signals.
// Title keywords for violence — used when MobileNet returns a generic label
const VIOLENCE_TITLE_KW = [
  "fight", "fighting", "brawl", "punch", "punching", "beat up", "beating",
  "knockout", "ko", "knocked out", "slap", "stabbed", "stabbing", "stab",
  "shot", "shooting", "gunshot", "gun fight", "gunfight", "knife attack",
  "attack", "assault", "murder", "kill", "killing", "kills", "killed",
  "blood", "gore", "death", "violent", "violence", "war", "combat",
  "battle", "massacre", "execution", "gang fight", "street fight",
  "robbery", "carjack", "mugging",
];

// Title keywords for romance/kissing — MobileNet cannot detect these visually
const ROMANCE_TITLE_KW = [
  "kissing", "making out", "hook up", "hookup", "kiss prank", "first kiss",
  "couple prank", "romantic couple", "kiss challenge", "bf gf prank",
  "lover", "make out",
];

const CATEGORY_RULES = [
  { id: "weapons", tier: "concern", kw: [
    // firearms
    "rifle", "assault_rifle", "revolver", "pistol", "firearm", "gun",
    "submachine_gun", "machine_gun", "shotgun",
    // other weapons
    "cannon", "missile", "bow_(weapon)", "cleaver", "hatchet", "knife",
    "dagger", "scalpel", "sword", "blade", "bayonet", "machete",
    // weapon accessories/context
    "holster", "scabbard", "projectile", "gunsight", "bulletproof_vest",
    "military_uniform", "soldier", "tank", "warplane", "bomb",
    "cartridge", "ammunition", "grenade",
  ]},
  { id: "violence", tier: "concern", kw: [
    // combat / fighting gear that ImageNet does label
    "boxing_glove", "boxing_ring", "punching_bag", "face_shield",
    "crash_helmet", "chain_mail", "armor", "shield",
    // injury / emergency indicators
    "bandage", "Band_Aid", "first_aid_kit", "stretcher", "ambulance",
    // martial arts attire ImageNet recognises
    "judo_uniform", "kimono",
  ]},
  { id: "alcohol_tobacco", tier: "concern", kw: [
    "beer_bottle", "beer_glass", "wine_bottle", "red_wine",
    "cocktail_shaker", "corkscrew", "hip_flask", "tobacco",
  ]},
  { id: "vehicles_speed",    tier: "neutral", kw: ["car","racer","motorcycle","moped","snowmobile","jeep","minivan","pickup","tractor","go-kart","airliner"] },
  { id: "animals",           tier: "neutral", kw: ["dog","cat","retriever","terrier","puppy","kitten","bird","fish","horse","rabbit","hamster","lizard","snake","spider","elephant","lion","tiger","bear","monkey","parrot","tortoise","frog"] },
  { id: "food",              tier: "neutral", kw: ["pizza","burger","cake","ice_cream","soup","salad","sandwich","pasta","noodle","bread","banana","strawberry","pretzel","burrito","espresso","candy"] },
  { id: "toys_games",        tier: "neutral", kw: ["toy","yo-yo","balloon","kite","jigsaw_puzzle","rubik","lego","teddy","marble","dice","chess"] },
  { id: "sports",            tier: "neutral", kw: ["ball","racket","skateboard","ski","snowboard","surfboard","dumbbell","barbell","helmet","puck","baseball","basketball","volleyball","trampoline"] },
  { id: "music_instruments", tier: "neutral", kw: ["guitar","piano","drum","violin","trumpet","flute","microphone","accordion","banjo","cello","harp","saxophone"] },
  { id: "electronics",       tier: "neutral", kw: ["phone","laptop","computer","keyboard","headset","joystick","remote_control","camera","television"] },
  { id: "nature_outdoors",   tier: "neutral", kw: ["mountain","beach","forest","lake","valley","volcano","cliff","coral_reef","geyser","waterfall","sandbar"] },
  { id: "people_fashion",    tier: "neutral", kw: ["suit","gown","sunglasses","lipstick","wig","necklace","sandal","sneaker","jersey","hat","scarf"] },
];
function categorize(label, title) {
  const l = (label || "").toLowerCase();
  for (const r of CATEGORY_RULES) {
    if (r.kw.some(k => l.includes(k))) return { id: r.id, tier: r.tier };
  }
  // MobileNet can't detect actions (fighting, kissing) from objects alone.
  // Fall back to title keyword matching for violence and romance.
  if (title) {
    const t = title.toLowerCase();
    // Check weapons keywords in title too (e.g. "gun" not in image but in title)
    if (["gun","guns","shooting","gunshot","gunfight","firearm","armed"].some(kw => t.includes(kw))) {
      return { id: "weapons", tier: "concern" };
    }
    if (VIOLENCE_TITLE_KW.some(kw => t.includes(kw))) {
      return { id: "violence", tier: "concern" };
    }
    if (ROMANCE_TITLE_KW.some(kw => t.includes(kw))) {
      return { id: "romance", tier: "concern" };
    }
  }
  return { id: "other", tier: "neutral" };
}

// ── Model state ───────────────────────────────────────────────────────────────
let mnModel    = null;
let dbPipeline = null;
let asrPipeline = null;

async function tryLoadModels() {
  for (let i = 0; i < 30; i++) {
    if (window.mobilenet && window.tf) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (window.mobilenet && window.tf) {
    try {
      await window.tf.setBackend("cpu");
      await window.tf.ready();
      mnModel = await window.mobilenet.load({ version: 2, alpha: 1.0 });
      console.log("[SG] MobileNet ready (cpu backend)");
    } catch (e) { console.warn("[SG] MobileNet failed:", e.message); }
  }

  for (let i = 0; i < 30; i++) {
    if (window._transformersReady && window.TransformersLib) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (window.TransformersLib) {
    try {
      dbPipeline = await window.TransformersLib.pipeline(
        "text-classification",
        "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
        { quantized: true }
      );
      console.log("[SG] DistilBERT ready");
    } catch (e) { console.warn("[SG] DistilBERT failed:", e.message); }
  }
}
tryLoadModels();

async function ensureAsrPipeline() {
  if (asrPipeline) return asrPipeline;
  for (let i = 0; i < 30; i++) {
    if (window._transformersReady && window.TransformersLib) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!window.TransformersLib) throw new Error("Transformers.js not ready");
  asrPipeline = await window.TransformersLib.pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-tiny.en",
    { quantized: true }
  );
  console.log("[SG] Whisper-tiny ready");
  return asrPipeline;
}

// ── Classify image ────────────────────────────────────────────────────────────
async function classifyImage(dataUrl) {
  if (!mnModel || !dataUrl) return { label: "model_unavailable", confidence: 0, inferenceMs: null };
  return new Promise(resolve => {
    const img = new Image();
    img.onload = async () => {
      const t0 = performance.now();
      try {
        const preds = await mnModel.classify(img, 5);
        const top = preds[0] || { className: "unknown", probability: 0 };
        resolve({ label: top.className, confidence: top.probability, inferenceMs: Math.round(performance.now() - t0) });
      } catch (e) { resolve({ label: "error", confidence: 0, inferenceMs: Math.round(performance.now() - t0) }); }
    };
    img.onerror = () => resolve({ label: "img_error", confidence: 0, inferenceMs: null });
    img.src = dataUrl;
  });
}

// ── Classify text ─────────────────────────────────────────────────────────────
async function classifyText(text) {
  if (!dbPipeline || !text?.trim()) return { sentiment: "UNKNOWN", score: 0, inferenceMs: null };
  const t0 = performance.now();
  try {
    const r = await dbPipeline(text.slice(0, 512));
    const top = Array.isArray(r) ? r[0] : r;
    return { sentiment: top.label || "UNKNOWN", score: top.score || 0, inferenceMs: Math.round(performance.now() - t0) };
  } catch { return { sentiment: "ERROR", score: 0, inferenceMs: Math.round(performance.now() - t0) }; }
}

// ── Audio capture + transcription ─────────────────────────────────────────────
//
// Only one tab-capture stream + AudioContext pair can safely be active in
// this offscreen document at a time. If a second SG_TRANSCRIBE_AUDIO message
// arrives while the previous call's audioCtx.close()/decodeCtx.close() is
// still resolving, the new getUserMedia()/AudioContext() can throw
// "Invalid state" — which is exactly the second error in the log. A simple
// promise-chain lock serializes calls so each one fully tears down its
// resources before the next begins.
let audioLock = Promise.resolve();

function transcribeStream(streamId, clipMs) {
  const run = audioLock.then(() => transcribeStreamInner(streamId, clipMs));
  // Keep the chain alive even if this call rejects, so the next call isn't
  // permanently blocked behind a failed promise.
  audioLock = run.catch(() => {});
  return run;
}

async function transcribeStreamInner(streamId, clipMs) {
  // Open the stream (only works in extension pages, not content scripts)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Route audio back to the (virtual) destination so Chrome keeps the stream
  // alive. Without a downstream consumer the stream may stall.
  const audioCtx = new AudioContext();
  const source   = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  // MediaRecorder + forced polling via requestData().
  //
  // In an offscreen document Chrome's audio clock does not drive
  // ondataavailable automatically (no real output device = no pull).
  // requestData() bypasses the clock: it tells the recorder to flush
  // whatever compressed audio it has buffered right now, even mid-chunk.
  // Calling it on a tight interval (250 ms) ensures we collect data as
  // soon as it becomes available rather than waiting for a clock event
  // that never comes.
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks   = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let capturedCleanly = false;

  try {
    // Start without a timeslice — we drive delivery ourselves via requestData
    recorder.start();

    const pollInterval = setInterval(() => {
      if (recorder.state === "recording") recorder.requestData();
    }, 250);

    // Early-exit sentinel: if we have no data after 1.5 s the stream is
    // genuinely silent or broken — no point waiting the full clip duration.
    const earlyExitTimer = setTimeout(() => {
      const totalBytes = chunks.reduce((n, c) => n + c.size, 0);
      if (totalBytes === 0) {
        console.warn("[SG] No audio data after 1.5 s — aborting capture early");
        clearInterval(pollInterval);
        if (recorder.state === "recording") recorder.stop();
      }
    }, 1500);

    // Wait for the clip duration then stop
    await new Promise(r => setTimeout(r, clipMs));
    clearTimeout(earlyExitTimer);
    clearInterval(pollInterval);

    // One final flush before stopping
    if (recorder.state === "recording") recorder.requestData();

    // Set onstop BEFORE calling stop() to avoid the race where onstop fires
    // before we attach the handler
    const stopPromise = new Promise(r => { recorder.onstop = r; });
    if (recorder.state === "recording") recorder.stop();
    await stopPromise;
    capturedCleanly = true;
  } finally {
    // Always release the mic stream and close the capture AudioContext, even
    // if recording threw partway through — an unreleased stream/context here
    // is what causes the NEXT call's getUserMedia()/new AudioContext() to
    // throw "Invalid state".
    try { source.disconnect(); } catch (_) {}
    stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    if (audioCtx.state !== "closed") {
      try { await audioCtx.close(); } catch (_) {}
    }
  }

  if (!capturedCleanly) return "";

  // Bail out if we still have no data
  const totalBytes = chunks.reduce((n, c) => n + c.size, 0);
  if (totalBytes === 0) {
    console.warn("[SG] MediaRecorder produced no data — audio scan skipped");
    return "";
  }

  // Decode compressed webm/opus → raw PCM
  const blob      = new Blob(chunks, { type: "audio/webm" });
  const arrayBuf  = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    if (decodeCtx.state !== "closed") {
      try { await decodeCtx.close(); } catch (_) {}
    }
  }

  const audioData  = decoded.getChannelData(0);
  const sampleRate = decoded.sampleRate;

  if (audioData.length === 0) {
    console.warn("[SG] Decoded audio has 0 samples — skipping Whisper");
    return "";
  }

  // Whisper expects audio at 16 kHz. If the decoded sample rate differs we
  // must resample, otherwise the frame tensor will have 0 time-steps which
  // causes ONNX to receive shape {6,0,448} and crash with error code 6.
  // Simple linear-interpolation downsample/upsample to TARGET_SR.
  const TARGET_SR = 16000;
  let finalAudio  = audioData;
  if (sampleRate !== TARGET_SR) {
    const ratio      = sampleRate / TARGET_SR;
    const outLen     = Math.round(audioData.length / ratio);
    const resampled  = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const lo     = Math.floor(srcPos);
      const hi     = Math.min(lo + 1, audioData.length - 1);
      const frac   = srcPos - lo;
      resampled[i] = audioData[lo] * (1 - frac) + audioData[hi] * frac;
    }
    finalAudio = resampled;
    console.log(`[SG] Resampled audio ${sampleRate} Hz → ${TARGET_SR} Hz (${audioData.length} → ${outLen} samples)`);
  }

  // Whisper requires at least a short minimum of real audio for the feature
  // extractor to produce a non-degenerate frame count — but NOT a full
  // padded-to-30s buffer. Manually padding to exactly 480,000 samples
  // conflicts with how chunk_length_s does its own internal windowing on
  // quantized tiny models, and on short real clips this produced a
  // zero-length frame dim — ONNX then received shape {6,0,448} instead of
  // {1,6,448,448} and crashed with error code 6.
  //
  // The fix: only pad up to a small floor (1s) to avoid edge cases with
  // sub-frame clips, and let the ASR pipeline's own chunk_length_s handle
  // windowing/padding internally as it's designed to.
  const MIN_SAMPLES = 16000; // 1 s × 16 000 Hz — just enough to avoid a 0-frame extraction
  if (finalAudio.length < MIN_SAMPLES) {
    const padded = new Float32Array(MIN_SAMPLES);
    padded.set(finalAudio);
    finalAudio = padded;
  }

  const asr    = await ensureAsrPipeline();
  const result = await asr(finalAudio, { sampling_rate: TARGET_SR, chunk_length_s: 30 });
  return (result?.text || "").trim();
}

// ── Unified message listener ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === MSG_CLASSIFY_SHORT) {
    const p = msg.payload;
    (async () => {
      const [imageResult, textResult] = await Promise.all([
        classifyImage(p.dataUrl),
        classifyText(p.title),
      ]);
      // Pass title so categorize() can apply violence keyword heuristic
      // when MobileNet returns a generic label (e.g. "jersey", "person")
      const category = categorize(imageResult.label, p.title);
      chrome.runtime.sendMessage({
        type: MSG_CLASSIFY_RESULT,
        payload: {
          requestId:       p.requestId,
          imageLabel:      imageResult.label,
          imageConfidence: imageResult.confidence,
          imageInferenceMs: imageResult.inferenceMs,
          category:        category.id,
          categoryTier:    category.tier,
          textSentiment:   textResult.sentiment,
          textScore:       textResult.score,
          textInferenceMs: textResult.inferenceMs,
        },
      }).catch(() => {});
    })();
  }

  if (msg?.type === MSG_TRANSCRIBE_AUDIO) {
    const { requestId, streamId, clipMs } = msg.payload || {};
    (async () => {
      let transcript = "";
      try {
        transcript = await transcribeStream(streamId, clipMs || 6000);
      } catch (e) {
        console.warn("[SG] Audio transcription failed:", e.message);
      }
      chrome.runtime.sendMessage({
        type: MSG_TRANSCRIBE_RESULT,
        payload: { requestId, transcript },
      }).catch(() => {});
    })();
  }
});