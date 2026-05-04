/**
 * Shared HTML chrome — single inline stylesheet, no JS framework, no build.
 */

export function renderPage(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111827;line-height:1.5}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:-0.01em}
  h2{font-size:15px;font-weight:600;color:#374151;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em}
  h3{font-size:14px;font-weight:600;margin:0 0 8px}
  a{color:#1e40af;text-decoration:none} a:hover{text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f3f4f6;padding:1px 5px;border-radius:3px}
  .meta{color:#6b7280;font-size:13px}
  .hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;font-size:13px;font-weight:500;cursor:pointer;background:white;color:#111827;font-family:inherit}
  .btn:hover{background:#f9fafb;text-decoration:none}
  .btn.primary{background:#111827;color:white;border-color:#111827}
  .btn.primary:hover{background:#1f2937}
  .btn.ghost{background:transparent;border-color:transparent;color:#6b7280}
  .card{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:16px}
  .card label{display:block;margin-bottom:14px;font-size:13px;color:#374151;font-weight:500}
  .card .hint{color:#9ca3af;font-weight:400;margin-left:4px}
  .card input[type=url],.card input[type=text],.card input[type=email],.card input[type=password],.card textarea,.card select{display:block;margin-top:4px;width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;color:#111827}
  .card input:focus,.card textarea:focus,.card select:focus{outline:none;border-color:#1e40af;box-shadow:0 0 0 3px rgba(30,64,175,0.1)}
  .card textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .card label.row{display:flex;align-items:center;gap:12px}
  .card label.row select{width:auto;flex:1;margin-top:0}
  .actions{display:flex;align-items:center;gap:14px;margin-top:8px}
  .tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:1px solid #e5e7eb;padding:0 4px}
  .tab{background:transparent;border:none;border-bottom:2px solid transparent;padding:10px 14px;font-size:13px;font-weight:500;color:#6b7280;cursor:pointer;margin-bottom:-1px;font-family:inherit}
  .tab:hover{color:#111827}
  .tab.active{color:#111827;border-bottom-color:#111827}
  .tabs + .card{border-top-left-radius:0;border-top-right-radius:0;border-top:1px solid #e5e7eb}
  table{border-collapse:collapse;width:100%;font-size:13px;background:white;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
  th,td{padding:10px 14px;border-bottom:1px solid #f3f4f6;text-align:left;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  th{background:#f9fafb;color:#6b7280;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.05em}
  td.empty{color:#9ca3af;text-align:center;padding:32px}
  .s{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;letter-spacing:0.02em}
  .s-passed{background:#dcfce7;color:#166534}
  .s-failed{background:#fee2e2;color:#991b1b}
  .s-errored{background:#fef3c7;color:#92400e}
  .s-running{background:#dbeafe;color:#1e40af;animation:pulse 1.6s ease-in-out infinite}
  .s-queued{background:#f3f4f6;color:#6b7280}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:24px}
  .stats .lbl{display:block;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px}
  .stats .val{display:block;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .shot{display:block;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white}
  .shot:hover{border-color:#9ca3af;text-decoration:none}
  .shot img{display:block;width:100%;height:auto;background:#f9fafb}
  .shot span{display:block;padding:6px 10px;font-size:11px;color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  iframe{width:100%;height:80vh;border:1px solid #e5e7eb;border-radius:10px;background:white}
  form{margin:0}
</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
