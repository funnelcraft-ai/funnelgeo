// The one line agencies paste into their website. It adds the audit form in a
// frame served from the agency's own workspace address, and lets the frame set
// its own height. It names nothing but the agency's address, so the platform
// stays invisible on the agency's site.
const SCRIPT = `(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  var targets = document.querySelectorAll('[data-ai-visibility-audit]');
  if (!targets.length) {
    var holder = document.createElement('div');
    script.parentNode.insertBefore(holder, script.nextSibling);
    targets = [holder];
  }
  Array.prototype.forEach.call(targets, function (target) {
    if (target.getAttribute('data-ready')) return;
    target.setAttribute('data-ready', '1');
    var frame = document.createElement('iframe');
    frame.src = origin + '/embed/audit';
    frame.title = 'Free AI visibility report';
    frame.loading = 'lazy';
    frame.style.cssText = 'display:block;width:100%;max-width:560px;height:700px;border:0;background:transparent;';
    target.appendChild(frame);
    window.addEventListener('message', function (event) {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      var data = event.data || {};
      if (data.type !== 'ai-visibility-audit:height') return;
      frame.style.height = Math.min(Math.max(Number(data.height) || 0, 200), 3000) + 'px';
    });
  });
})();
`;

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
