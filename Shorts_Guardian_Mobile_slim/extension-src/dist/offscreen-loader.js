// Loads Transformers.js (ESM) and exposes it as a global for offscreen.js.
// Must be type="module" (separate file) to satisfy MV3 CSP 'self' restriction.

import { pipeline, env } from "../vendor/transformers.min.js";

// ── HuggingFace remote model weights ──────────────────────────────────────────
env.allowRemoteModels = true;
env.allowLocalModels  = false;  // chrome-extension:// paths not supported
env.useBrowserCache   = false;  // Cache API unavailable on chrome-extension://

// ── CRITICAL: Force single-threaded WASM, no Worker spawning ─────────────────
//
// Transformers.js bundles onnxruntime-web which by default tries to spawn a
// threaded Worker via a blob: URL ("ort-wasm-threaded.worker.js").
// MV3 blocks blob: URL workers unconditionally, causing the
// "importScripts failed" error. The non-threaded WASM backend ("ort-wasm.wasm")
// runs fully on the main thread of the offscreen page — no workers, no blob:
// URLs, no CSP issues.
//
// These two flags together tell ort-web to pick the single-threaded path:
env.backends.onnx.wasm.proxy    = false;   // Don't offload to a worker proxy
env.backends.onnx.wasm.numThreads = 1;     // WASM SIMD threads = 1 → non-threaded binary

window.TransformersLib    = { pipeline };
window._transformersReady = true;