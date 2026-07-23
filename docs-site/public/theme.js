// Theme toggle: respects prefers-color-scheme until the user chooses;
// the choice persists in localStorage. Progressive enhancement — the
// button stays hidden without JS.
(function () {
  var KEY = 'marionette-theme';
  var root = document.documentElement;
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;

  function current() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  }

  function paint() {
    var light = current() === 'light';
    btn.setAttribute('aria-pressed', String(light));
    btn.textContent = light ? 'dark mode' : 'light mode';
  }

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch (e) { /* storage unavailable: session-only */ }

  btn.hidden = false;
  paint();

  btn.addEventListener('click', function () {
    var next = current() === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
    paint();
  });
})();
