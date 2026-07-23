// Terminal replay. Each .term[data-demo] contains the complete transcript
// as .t-line elements (fully visible without JS). With JS, the controls
// appear and lines can be streamed. prefers-reduced-motion collapses
// playback to an instant reveal. No autoplay, ever.
(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var LINE_MS = 110;

  document.querySelectorAll('.term[data-demo]').forEach(function (term) {
    var lines = Array.prototype.slice.call(term.querySelectorAll('.t-line'));
    if (lines.length === 0) return;
    var controls = term.querySelector('.term-controls');
    var status = term.querySelector('.term-status');
    var btns = {};
    ['play', 'step', 'skip', 'restart'].forEach(function (act) {
      btns[act] = controls.querySelector('[data-act="' + act + '"]');
    });
    var shown = lines.length; // no-JS default: everything visible
    var timer = null;

    function announce(text) { if (status) status.textContent = text; }

    function render() {
      lines.forEach(function (el, i) { el.hidden = i >= shown; });
      var done = shown >= lines.length;
      btns.play.textContent = timer ? '⏸ pause'
        : reduced.matches ? '⚡ show' : '▶ play';
      btns.play.disabled = done && !timer;
      btns.step.disabled = done || Boolean(timer);
      btns.skip.disabled = done;
      btns.restart.disabled = shown === 0 && !timer;
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    function finishIfDone() {
      if (shown >= lines.length) {
        stop();
        announce('done — ' + lines.length + ' lines shown');
      }
      render();
    }

    function reveal(n) {
      shown = Math.min(lines.length, shown + n);
      finishIfDone();
    }

    btns.play.addEventListener('click', function () {
      if (timer) { stop(); announce('paused'); render(); return; }
      if (shown >= lines.length) return;
      if (reduced.matches) { shown = lines.length; finishIfDone(); return; }
      announce('playing');
      timer = setInterval(function () { reveal(1); }, LINE_MS);
      render();
    });

    btns.step.addEventListener('click', function () { reveal(1); });

    btns.skip.addEventListener('click', function () {
      stop();
      shown = lines.length;
      finishIfDone();
    });

    btns.restart.addEventListener('click', function () {
      stop();
      shown = 0;
      announce('reset');
      render();
    });

    // JS is live: expose the controls and start collapsed at the command
    // line, ready to play.
    controls.hidden = false;
    shown = 1;
    render();
  });
})();
