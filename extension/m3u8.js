// Minimal, dependency-free HLS playlist parser.
// Works unmodified in the extension (popup/background) and under plain
// Node.js (used by the smoke-test script), via the export shim below.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HlsParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function resolveUrl(base, uri) {
    try {
      return new URL(uri, base).toString();
    } catch (e) {
      return uri;
    }
  }

  function isMasterPlaylist(text) {
    return text.includes('#EXT-X-STREAM-INF');
  }

  // A "master" playlist lists variant streams (different quality tiers),
  // each pointing at its own "media" playlist of segments.
  function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    let pending = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = {};
        line
          .slice('#EXT-X-STREAM-INF:'.length)
          .split(',')
          .forEach((pair) => {
            const idx = pair.indexOf('=');
            if (idx === -1) return;
            attrs[pair.slice(0, idx).trim()] = pair
              .slice(idx + 1)
              .trim()
              .replace(/^"|"$/g, '');
          });
        pending = attrs;
      } else if (line && !line.startsWith('#')) {
        if (pending) {
          variants.push({
            bandwidth: pending.BANDWIDTH ? parseInt(pending.BANDWIDTH, 10) : null,
            resolution: pending.RESOLUTION || null,
            url: resolveUrl(baseUrl, line.trim()),
          });
          pending = null;
        }
      }
    }
    return variants;
  }

  // A "media" playlist lists the actual segment files, in order.
  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let initUrl = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MAP:')) {
        const m = line.match(/URI="([^"]+)"/);
        if (m) initUrl = resolveUrl(baseUrl, m[1]);
      } else if (line && !line.startsWith('#')) {
        segments.push(resolveUrl(baseUrl, line.trim()));
      }
    }
    return { initUrl, segments };
  }

  return { isMasterPlaylist, parseMaster, parseMedia, resolveUrl };
});
