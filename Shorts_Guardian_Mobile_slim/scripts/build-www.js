// Generates www/ from the original Chrome-extension source + mobile-src/.
// Usage: node scripts/build-www.js [path-to-extension-folder]
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(process.argv[2] || path.join(ROOT, "extension-src"));
const OUT = path.join(ROOT, "www");
const rd = (p) => fs.readFileSync(path.join(SRC, p), "utf8");
const mob = (p) => fs.readFileSync(path.join(ROOT, "mobile-src", p), "utf8");
const wr = (p, s) => { const f = path.join(OUT, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const patch = (s, from, to, label) => { if (!s.includes(from)) throw new Error("patch failed: " + label); return s.split(from).join(to); };

fs.rmSync(OUT, { recursive: true, force: true });
for (const p of ["app.css", "app.js", "ui-scale.js"]) fs.cpSync(path.join(SRC, p), path.join(OUT, p));
for (const d of ["icons", "vendor"]) fs.cpSync(path.join(SRC, d), path.join(OUT, d), { recursive: true });
for (const p of ["config.js", "chrome-shim.js", "safe-browser.js", "mobile.css"]) wr("mobile/" + p, mob(p));

// index.html (the parent dashboard) + engine scripts
let html = rd("app.html");
html = patch(html, 'content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"', "viewport");
html = patch(html, '<script src="ui-scale.js"></script>',
  '<script src="mobile/config.js"></script>\n<script src="mobile/chrome-shim.js"></script>\n<link rel="stylesheet" href="mobile/mobile.css" />\n<script src="ui-scale.js"></script>', "head");
html = patch(html, '<script src="app.js"></script>',
  '<script src="app.js"></script>\n<script src="vendor/tf.min.js"></script>\n<script src="vendor/mobilenet.min.js"></script>\n' +
  '<script type="module" src="mobile/offscreen-loader.js"></script>\n<script src="mobile/offscreen.js"></script>\n' +
  '<script src="mobile/background.js"></script>\n<script src="mobile/safe-browser.js"></script>', "scripts");
wr("index.html", html);

// Classifier (was the offscreen document) — wrapped so its globals can't clash with app.js
let off = rd("dist/offscreen.js");
off = patch(off, "if (msg?.type === MSG_CLASSIFY_SHORT) {", "if (msg?.type === MSG_CLASSIFY_SHORT && msg.payload?.requestId) {", "offscreen guard");
wr("mobile/offscreen.js", "(function(){\n" + off + "\n})();\n");

let loader = rd("dist/offscreen-loader.js");
loader = patch(loader, "../vendor/transformers.min.js", "../vendor/transformers.min.js", "loader import");
loader = patch(loader, "env.useBrowserCache   = false;", "env.useBrowserCache   = true;", "loader cache");
wr("mobile/offscreen-loader.js", loader);

// Background pipeline — wrapped; audio tab-capture isn't possible on mobile
let bg = rd("dist/background.js");
bg = patch(bg, "settings.audioScanEnabled && tab?.id", "false && tab?.id", "audio off");
wr("mobile/background.js", "(function(){\n" + bg + "\n})();\n");

// Code injected into the Safe YouTube browser
wr("mobile/inject.js", mob("page-shim.js") + "\n" + rd("dist/content.js"));
console.log("www/ built from", SRC);
