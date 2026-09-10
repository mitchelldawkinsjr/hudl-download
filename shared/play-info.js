// Renders the optional per-clip metadata sidecar (play number, and any
// tables/label-value pairs the downloader extension scraped off the source
// page) into a container element. Shared between the web and Electron apps.
(function (global) {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function isEmpty(data) {
    if (!data) return true;
    const hasFields = data.fields && Object.keys(data.fields).length;
    const hasTables = data.tables && data.tables.length;
    return !data.playLabel && !hasFields && !hasTables;
  }

  // Always shows the panel once a clip is active -- even with no sidecar
  // data, a "no play info" message is more useful than the panel silently
  // vanishing (which reads as "did my click even register?"). It's up to
  // the caller not to call this at all when there's no active clip (see
  // web/index.html and electron/index.html's `if (!clip)` branches), so
  // that "nothing selected yet" still hides the panel entirely.
  function renderPlayInfo(container, data) {
    container.hidden = false;

    if (isEmpty(data)) {
      container.innerHTML = '<h2>Play Info</h2><div class="play-info-empty">No play info captured for this clip.</div>';
      return;
    }

    let html = '<h2>Play Info</h2>';
    if (data.playLabel) {
      html += `<div class="field-row"><span class="k">Play</span><span class="v">${escapeHtml(data.playLabel.replace(/^Play-/, ''))}</span></div>`;
    }
    if (data.videoId) {
      html += `<div class="field-row"><span class="k">Video ID</span><span class="v">${escapeHtml(data.videoId)}</span></div>`;
    }
    if (data.fields) {
      for (const [k, v] of Object.entries(data.fields)) {
        html += `<div class="field-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`;
      }
    }
    if (data.tables) {
      data.tables.forEach((rows) => {
        html +=
          '<table>' +
          rows
            .map((row, i) => {
              const tag = i === 0 ? 'th' : 'td';
              return '<tr>' + row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join('') + '</tr>';
            })
            .join('') +
          '</table>';
      });
    }
    container.innerHTML = html;
  }

  global.PlayInfo = { renderPlayInfo };
})(window);
