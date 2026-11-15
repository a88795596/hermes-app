import { useMemo } from "react";
import { buildPreviewHtml } from "./html-document";

export function HtmlPreview({ html, name }: { html: string; name: string }) {
  const document = useMemo(() => buildPreviewHtml(html, name), [html, name]);
  return <iframe title={name} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer"
    style={{ flex: 1, width: "100%", height: "100%", border: 0, background: "white" }} />;
}
