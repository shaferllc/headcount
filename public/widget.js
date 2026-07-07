/**
 * <headcount-badge> — a live concurrent-visitor counter with odometer digits.
 *
 *   <script src="https://your-worker.example/widget.js" defer></script>
 *   <headcount-badge site="blog"></headcount-badge>
 *
 * Attributes:
 *   site       required — the site name you ping with
 *   endpoint   API origin (default: where widget.js came from)
 *   window     liveness window in seconds (default 60)
 *   interval   poll cadence in seconds (default 5)
 *
 * Styling: the element inherits font and color; digits are 1em tall. Set
 * font-size on the element to scale it. When the value changes, the changed
 * digit columns roll odometer-style — perceptible even for ±1, which a
 * numeric ease never is (34→35 has no intermediate integers to show).
 */
(function () {
  'use strict';

  var SCRIPT_ORIGIN = (function () {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return ''; }
  })();
  var ROLL = 'transform 600ms cubic-bezier(0.22, 0.61, 0.36, 1)';

  class HeadcountBadge extends HTMLElement {
    connectedCallback() {
      this._host = document.createElement('span');
      this._host.style.cssText = 'display:inline-block;font-variant-numeric:tabular-nums;';
      this.appendChild(this._host);
      this._value = null;
      // Live push first; polling is the fallback (and the explicit mode via live="poll").
      if (this.getAttribute('live') === 'poll' || typeof WebSocket === 'undefined') {
        this._startPolling();
      } else {
        this._connect();
      }
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      try { this._ws && this._ws.close(); } catch (e) {}
    }

    _connect() {
      var endpoint = (this.getAttribute('endpoint') || SCRIPT_ORIGIN).replace(/\/$/, '');
      var site = this.getAttribute('site');
      if (!site || !endpoint) return;
      var self = this;
      try {
        var ws = new WebSocket(endpoint.replace(/^http/, 'ws') + '/ws?site=' + encodeURIComponent(site));
        this._ws = ws;
        ws.onmessage = function (ev) {
          try {
            var data = JSON.parse(ev.data);
            if (typeof data.count === 'number') self._render(data.count);
          } catch (e) {}
        };
        ws.onerror = ws.onclose = function () {
          if (self._ws !== ws) return; // already replaced
          self._ws = null;
          self._startPolling(); // graceful degrade; no WS retry this pageload
        };
      } catch (e) {
        this._startPolling();
      }
    }

    _startPolling() {
      if (this._timer) return;
      this._poll();
      var interval = Math.max(2, parseInt(this.getAttribute('interval'), 10) || 5) * 1000;
      this._timer = setInterval(this._poll.bind(this), interval);
    }

    async _poll() {
      var endpoint = (this.getAttribute('endpoint') || SCRIPT_ORIGIN).replace(/\/$/, '');
      var site = this.getAttribute('site');
      if (!site || !endpoint) return;
      var windowSeconds = parseInt(this.getAttribute('window'), 10) || 60;
      try {
        var res = await fetch(endpoint + '/live?site=' + encodeURIComponent(site) + '&window=' + windowSeconds);
        if (!res.ok) return;
        var data = await res.json();
        if (typeof data.count === 'number') this._render(data.count);
      } catch (e) {}
    }

    _render(value) {
      var immediate = this._value === null;
      if (value === this._value) return;
      this._value = value;

      var host = this._host;
      var chars = value.toLocaleString('en-US').split('');
      var shape = chars.map(function (c) { return /\d/.test(c) ? 'd' : c; }).join('');

      // Rebuild columns only when the number's shape changes (9→10, 999→1,000):
      // stable columns are what let the CSS transition roll at all.
      if (host.dataset.shape !== shape) {
        host.dataset.shape = shape;
        host.textContent = '';
        chars.forEach(function (c) {
          if (!/\d/.test(c)) {
            var sep = document.createElement('span');
            sep.style.cssText = 'display:inline-block;height:1em;line-height:1em;';
            sep.textContent = c;
            host.appendChild(sep);
            return;
          }
          var col = document.createElement('span');
          col.style.cssText = 'display:inline-block;overflow:hidden;height:1em;line-height:1em;';
          var strip = document.createElement('span');
          strip.className = 'hc-strip';
          strip.style.cssText = 'display:block;transition:' + ROLL + ';';
          for (var d = 0; d <= 9; d++) {
            var cell = document.createElement('span');
            cell.style.cssText = 'display:block;height:1em;line-height:1em;';
            cell.textContent = String(d);
            strip.appendChild(cell);
          }
          col.appendChild(strip);
          host.appendChild(col);
        });
        immediate = true;
      }

      host.setAttribute('aria-label', String(value));
      var strips = host.querySelectorAll('.hc-strip');
      var i = 0;
      chars.forEach(function (c) {
        if (!/\d/.test(c)) return;
        var strip = strips[i++];
        if (immediate) {
          strip.style.transition = 'none';
          strip.style.transform = 'translateY(-' + c + 'em)';
          void strip.offsetHeight; // commit the jump before re-enabling the roll
          strip.style.transition = ROLL;
        } else {
          strip.style.transform = 'translateY(-' + c + 'em)';
        }
      });
    }
  }

  if (!customElements.get('headcount-badge')) {
    customElements.define('headcount-badge', HeadcountBadge);
  }
})();
