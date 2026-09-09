// Parses a Chrome "Save Page As -> Webpage, Complete" export of a Hudl
// presentation/review page into a normalized play library. Pure logic only
// (string/JSON parsing, path math) -- no DOM or Node-specific APIs -- so it
// runs unmodified in the browser, in Electron's main process, and under
// plain Node for the smoke test.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HudlImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TICKS_PER_SECOND = 10000000; // .NET-style ticks (100ns units)

  function ticksToSeconds(ticks) {
    return ticks / TICKS_PER_SECOND;
  }

  function extractEmbedData(htmlText) {
    const m = htmlText.match(/window\.__hudlEmbed\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) throw new Error('Could not find window.__hudlEmbed data in this export — is it a Hudl presentation export?');
    return JSON.parse(m[1]);
  }

  // Resolve a "../../z/foo.mp4"-style relative path (as it appears in the
  // export's embedded JSON, relative to the HTML file) against the HTML
  // file's own location, expressed as an array of path segments relative to
  // the export's top-level folder (e.g. ["Start_WR Post Game Review"]).
  function resolveRelativePath(htmlDirSegments, relPath) {
    const stack = htmlDirSegments.slice();
    relPath
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.')
      .forEach((seg) => {
        if (seg === '..') stack.pop();
        else stack.push(seg);
      });
    return stack;
  }

  function buildLibrary(embed, htmlDirSegments) {
    const slides = (embed.data && embed.data.presentationData && embed.data.presentationData.slides) || [];
    const presentationName = (embed.data && embed.data.presentationData && embed.data.presentationData.name) || 'Hudl Export';

    const plays = slides.map((slide, i) => {
      const videoBlock = (slide.video && slide.video[0]) || null;
      const sourceSize = (videoBlock && videoBlock.position) || { width: 630, height: 470 };

      const angles = videoBlock
        ? videoBlock.angles.map((a) => ({
            name: a.angleName || 'Angle',
            pathSegments: resolveRelativePath(htmlDirSegments, a.path),
            durationSec: ticksToSeconds(a.durationTicks || 0),
            annotations: (a.annotations || [])
              .map((ann) => ({
                timeMs: ann.timeMs,
                strokeData: ann.strokeData || [],
                textAnnotations: ann.textAnnotations || [],
              }))
              .sort((x, y) => x.timeMs - y.timeMs),
          }))
        : [];

      return {
        order: slide.order != null ? slide.order : i,
        title: 'Play ' + ((slide.order != null ? slide.order : i) + 1),
        thumbnailPathSegments: videoBlock && videoBlock.thumbnailPath ? resolveRelativePath(htmlDirSegments, videoBlock.thumbnailPath) : null,
        sourceSize: sourceSize,
        angles: angles,
      };
    });

    return { presentationName, plays };
  }

  // Given currentTimeMs and an annotation list sorted by timeMs (as
  // produced by buildLibrary), return the annotation that should currently
  // be visible: the latest one at or before currentTimeMs, or null.
  function activeAnnotationAt(annotations, currentTimeMs) {
    let active = null;
    for (let i = 0; i < annotations.length; i++) {
      if (annotations[i].timeMs <= currentTimeMs) active = annotations[i];
      else break;
    }
    return active;
  }

  return { extractEmbedData, resolveRelativePath, buildLibrary, ticksToSeconds, activeAnnotationAt };
});
