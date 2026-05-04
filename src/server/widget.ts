/**
 * Embeddable widget — a single JS file customers drop into their app.
 *
 *   <script src="https://lunaorbit.dev/widget.js" data-key="lo_pk_..." async></script>
 *
 * Adds a small "Run AI test" button in the bottom-right corner. Clicking
 * opens a drawer with a textarea: user types what to test (defaulting to
 * "Test the current page"), clicks Run → POST /v1/auto with the API key.
 *
 * Designed for non-technical users embedded inside their company's own
 * app — the widget knows the current URL, prefills it as the target,
 * and shows live status + screenshots inline as the run progresses.
 *
 * Zero framework deps. Vanilla DOM + fetch. ~5KB minified.
 */

export function renderWidgetJs(publicBaseUrl: string): string {
  // Note: keep this string self-contained; it's served to the customer's
  // browser, not bundled. Reference `publicBaseUrl` at the top so all
  // network calls go to our server (CORS-friendly).
  return `(function(){
  var s = document.currentScript;
  var key = s && s.getAttribute('data-key');
  var base = ${JSON.stringify(publicBaseUrl || "")};
  if (!key) { console.error('[luna-orbit] data-key required on the script tag'); return; }

  var open = false;
  var btn = document.createElement('button');
  btn.textContent = '🧪 AI test this page';
  Object.assign(btn.style, {
    position: 'fixed', right: '20px', bottom: '20px', zIndex: 2147483647,
    padding: '10px 16px', borderRadius: '999px', border: 'none',
    background: '#111827', color: 'white', font: '500 13px -apple-system, system-ui',
    cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
  });

  var panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', right: '20px', bottom: '70px', zIndex: 2147483647,
    width: '380px', maxHeight: '70vh', background: 'white', border: '1px solid #e5e7eb',
    borderRadius: '12px', padding: '16px', boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
    font: '13px -apple-system, system-ui', color: '#111827',
    display: 'none', flexDirection: 'column', gap: '10px', overflow: 'auto'
  });
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:14px">Luna Orbit · AI test</strong>' +
    '<button id="lo-close" style="background:transparent;border:none;cursor:pointer;font-size:18px;color:#6b7280">×</button></div>' +
    '<label style="font-weight:500">Target URL<input id="lo-target" type="url" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px;font-size:13px"/></label>' +
    '<label style="font-weight:500">What to test<textarea id="lo-req" rows="3" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px;font-family:inherit;font-size:13px"></textarea></label>' +
    '<button id="lo-run" style="background:#111827;color:white;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:500">Run</button>' +
    '<div id="lo-status" style="display:none;padding:8px;border-radius:6px;font-size:12px"></div>' +
    '<div id="lo-link" style="display:none;font-size:12px"></div>';

  function toggle() {
    open = !open;
    panel.style.display = open ? 'flex' : 'none';
    if (open) {
      panel.querySelector('#lo-target').value = window.location.href;
      panel.querySelector('#lo-req').value = panel.querySelector('#lo-req').value || 'Verify the page loads, the main heading is visible, and the primary CTA is clickable';
      panel.querySelector('#lo-req').focus();
    }
  }
  btn.addEventListener('click', toggle);

  function appendAll() {
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    panel.querySelector('#lo-close').addEventListener('click', toggle);
    panel.querySelector('#lo-run').addEventListener('click', async function() {
      var target = panel.querySelector('#lo-target').value.trim();
      var requirement = panel.querySelector('#lo-req').value.trim();
      var status = panel.querySelector('#lo-status');
      var link = panel.querySelector('#lo-link');
      if (!target || !requirement) { status.textContent = 'Please fill in both fields.'; status.style.background = '#fee2e2'; status.style.color = '#991b1b'; status.style.display = 'block'; return; }

      status.textContent = 'Starting…'; status.style.background = '#dbeafe'; status.style.color = '#1e40af'; status.style.display = 'block';
      link.style.display = 'none';

      try {
        var r = await fetch(base + '/v1/auto', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
          body: JSON.stringify({ target: target, requirement: requirement })
        });
        var data = await r.json();
        if (!r.ok) throw new Error(data.detail || data.error || ('HTTP ' + r.status));
        status.textContent = 'Running… ' + data.id;
        link.innerHTML = '<a href="' + base + '/runs/' + data.id + '" target="_blank" style="color:#1e40af">Watch live →</a>';
        link.style.display = 'block';

        // Poll until finished, surface verdict in-place.
        var poll = setInterval(async function() {
          try {
            var rr = await fetch(base + '/v1/runs/' + data.id, { headers: { 'authorization': 'Bearer ' + key } });
            var rec = await rr.json();
            if (rec.status === 'passed' || rec.status === 'failed' || rec.status === 'errored') {
              clearInterval(poll);
              var ok = rec.status === 'passed';
              status.textContent = (ok ? '✓ PASS' : '✗ ' + rec.status.toUpperCase()) + ' — ' + (rec.intents_satisfied || 0) + '/' + (rec.intents_total || 0) + ' intents · ' + (rec.duration_ms ? (rec.duration_ms / 1000).toFixed(1) + 's' : '');
              status.style.background = ok ? '#dcfce7' : '#fee2e2';
              status.style.color = ok ? '#166534' : '#991b1b';
            }
          } catch (e) { console.error('[luna-orbit] poll error', e); }
        }, 3000);
      } catch (e) {
        status.textContent = 'Failed: ' + e.message;
        status.style.background = '#fee2e2'; status.style.color = '#991b1b';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', appendAll);
  else appendAll();
})();
`;
}
