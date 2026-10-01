// tf-webgl-disable.js
// Must be loaded AFTER tf.min.js and BEFORE mobilenet.min.js.
//
// MV3 CSP blocks inline <script> blocks, so this logic can't live in
// offscreen.html directly. Loading it as a 'self' script satisfies the policy.
//
// Why this is needed:
//   tf.min.js (UMD) registers a WebGL backend on load. WebGL's shader
//   compiler calls new Function() which MV3's CSP blocks (EvalError),
//   crashing TF.js initialisation and leaving tf.setBackend undefined.
//   Setting WEBGL_VERSION=0 here tells TF.js to skip WebGL entirely so
//   mobilenet.load() later resolves cleanly against the CPU backend.
if (window.tf && window.tf.env) {
  window.tf.env().set("WEBGL_VERSION", 0);
  window.tf.env().set("WEBGL_CPU_FORWARD", false);
}
