/**
 * headcount snippet — heartbeat pings for concurrent-visitor counting.
 *
 *   <script src="https://your-worker.example/headcount.js"
 *           data-site="blog" defer></script>
 *
 * Optional attributes:
 *   data-endpoint="https://…"  API origin (default: where this script came from)
 *   data-interval="15"         seconds between pings (10–120)
 *   data-idle="120"            seconds without activity before pings pause
 *
 * Behaviors that make the count honest:
 *   - One visitor id per browser (localStorage), so N tabs ≠ N visitors.
 *   - Leader election across tabs: only one tab pings; if it closes, another
 *     takes over within one interval.
 *   - Hidden tabs don't ping; idle visitors pause and resume on activity.
 *   - If a POST is blocked (extension/network), this pageload falls back to a
 *     GIF beacon — a different request type that evades most blockers.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var site = script.getAttribute('data-site');
  if (!site) return;

  var endpoint = (script.getAttribute('data-endpoint') || new URL(script.src).origin).replace(/\/$/, '');
  var intervalMs = clamp(parseInt(script.getAttribute('data-interval'), 10) || 15, 10, 120) * 1000;
  var idleMs = clamp(parseInt(script.getAttribute('data-idle'), 10) || 120, 30, 900) * 1000;

  var visitorId = getVisitorId();
  var leaderKey = '__hc_leader_' + site;
  var lastActivity = Date.now();
  var wasIdle = false;
  var postBlocked = false;

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function getVisitorId() {
    try {
      var id = localStorage.getItem('__hc_id');
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
        localStorage.setItem('__hc_id', id);
      }
      return id;
    } catch (e) {
      return String(Date.now()) + Math.random().toString(16).slice(2);
    }
  }

  // -- Leader election: latest claim wins; a claim goes stale after interval+5s.
  var tabId = Math.random().toString(16).slice(2);

  function claimLeadership() {
    try { localStorage.setItem(leaderKey, tabId + '|' + Date.now()); } catch (e) {}
  }

  function isLeader() {
    try {
      var raw = localStorage.getItem(leaderKey);
      if (!raw) return false;
      var parts = raw.split('|');
      if (Date.now() - Number(parts[1]) > intervalMs + 5000) return false; // stale leader
      return parts[0] === tabId;
    } catch (e) {
      return true; // no localStorage: every tab pings; the server dedupes by id
    }
  }

  // -- Transport: POST first, GIF beacon after a blocked POST (per pageload).
  function sendPing() {
    var payload = { site: site, id: visitorId, url: location.pathname + location.search };
    if (postBlocked) {
      sendGif(payload);
      return;
    }
    try {
      fetch(endpoint + '/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'omit',
      }).catch(function () {
        postBlocked = true;
        sendGif(payload);
      });
    } catch (e) {
      postBlocked = true;
      sendGif(payload);
    }
  }

  function sendGif(payload) {
    try {
      new Image(1, 1).src = endpoint + '/ping.gif?site=' + encodeURIComponent(payload.site)
        + '&id=' + encodeURIComponent(payload.id)
        + '&url=' + encodeURIComponent(payload.url)
        + '&_=' + Date.now();
    } catch (e) {}
  }

  // -- The beat.
  function tick() {
    if (document.visibilityState !== 'visible') return;
    if (!isLeader()) {
      // Leader gone? Take over so the visitor keeps counting.
      try { if (!localStorage.getItem(leaderKey) || !isLeaderAlive()) claimLeadership(); } catch (e) {}
      if (!isLeader()) return;
    }
    if (Date.now() - lastActivity > idleMs) {
      wasIdle = true;
      return;
    }
    claimLeadership();
    sendPing();
  }

  function isLeaderAlive() {
    try {
      var raw = localStorage.getItem(leaderKey);
      if (!raw) return false;
      return Date.now() - Number(raw.split('|')[1]) <= intervalMs + 5000;
    } catch (e) {
      return false;
    }
  }

  function onActivity() {
    lastActivity = Date.now();
    if (wasIdle) {
      wasIdle = false;
      tick(); // resume immediately so the count recovers fast
    }
  }

  ['mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown'].forEach(function (ev) {
    document.addEventListener(ev, onActivity, { passive: true });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      lastActivity = Date.now();
      tick();
    }
  });

  claimLeadership();
  tick();
  setInterval(tick, intervalMs);
})();
