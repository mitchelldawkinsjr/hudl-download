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

  function renderPlayInfo(container, data) {
    if (isEmpty(data)) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    container.hidden = false;

    let html = '<h2>Play Info</h2>';
    if (data.playLabel) {
      html += `<div class="field-row"><span class="k">Play</span><span class="v">${escapeHtml(data.playLabel.replace(/^Play-/, ''))}</span></div>`;
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
