// shortcut: CSP cannot block WebRTC; fully offline HTML needs a separate execution sandbox.
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPreviewHtml(html: string, name: string) {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  // An outer policy blocks the inner frame's own navigations, which its CSP alone cannot prevent.
  return `<!doctype html><html lang="zh-CN"><head>${head}<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style></head><body><iframe sandbox="allow-scripts" title="${escapeAttribute(name)}" srcdoc="${escapeAttribute(`${head}${html}`)}"></iframe></body></html>`;
}
