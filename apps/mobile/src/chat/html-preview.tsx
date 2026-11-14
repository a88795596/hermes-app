import { useMemo } from "react";
import { WebView } from "react-native-webview";
import { buildPreviewHtml } from "./html-document";

export function HtmlPreview({ html, name }: { html: string; name: string }) {
  const source = useMemo(() => ({ html: buildPreviewHtml(html, name) }), [html, name]);
  return <WebView source={source} style={{ flex: 1, backgroundColor: "white" }} accessibilityLabel={name}
    // Catch every origin here; excluded whitelist origins otherwise open through native Linking.
    originWhitelist={["*"]}
    onShouldStartLoadWithRequest={({ url }) => url === "about:blank" || url === "about:srcdoc"}
    javaScriptEnabled
    javaScriptCanOpenWindowsAutomatically={false}
    setSupportMultipleWindows
    onOpenWindow={() => {}}
    allowFileAccess={false}
    allowFileAccessFromFileURLs={false}
    allowUniversalAccessFromFileURLs={false}
    allowContentAccess={false}
    mixedContentMode="never"
    incognito
    cacheEnabled={false}
    sharedCookiesEnabled={false}
    thirdPartyCookiesEnabled={false}
    domStorageEnabled={false}
    allowsLinkPreview={false}
    dataDetectorTypes="none"
    mediaPlaybackRequiresUserAction
    mediaCapturePermissionGrantType="deny"
  />;
}
