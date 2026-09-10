// Registers the app shell for offline use / installability. Extracted from
// web/index.html into an external file so it can load under the extension's
// strict CSP (script-src 'self'), which blocks inline <script> blocks.
//
// Service workers require a secure context (http(s), not file://), so this
// simply no-ops when the page is opened by double-clicking index.html -- the
// app still works fine over file://, just without offline caching or an
// install prompt in that mode. It also no-ops in chrome-extension:// pages
// (the extension is already packaged/offline), where navigator.serviceWorker
// is either unavailable or the register() rejects -- the .catch swallows it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
}
