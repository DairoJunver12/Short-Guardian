/* Shorts Guardian — larger UI for easier reading.
   Scales the whole dashboard (text, buttons, spacing) up to 2x (100% bigger).
   The scale shrinks automatically on narrower screens so the layout never breaks:
   the page always keeps at least MIN_EFFECTIVE_WIDTH CSS pixels of room.
   To change the maximum size, edit MAX_SCALE (1 = original size, 2 = 100% bigger). */
(function () {
  var MAX_SCALE = 2;
  var MIN_EFFECTIVE_WIDTH = 1000;

  function apply() {
    var w = window.innerWidth || document.documentElement.clientWidth || MIN_EFFECTIVE_WIDTH;
    var s = Math.max(1, Math.min(MAX_SCALE, w / MIN_EFFECTIVE_WIDTH));
    s = Math.round(s * 100) / 100;
    var root = document.documentElement;
    root.style.zoom = s;
    root.style.setProperty("--ui-scale", s);
  }

  apply();
  window.addEventListener("resize", apply);
})();
