# Chrome Web Store submission

Steps and notes for publishing the `extension/` folder to the Chrome Web Store.

## Build the upload

```bash
./extension/package.sh
```

Produces `dist/film-room-downloader-v<version>.zip`. This dereferences the
`extension/shared` and `extension/web` symlinks into real copies so the
store's unzipper sees a complete package.

## Upload

1. Go to https://chrome.google.com/webstore/devconsole/ (one-time $5
   developer signup fee).
2. "Add new item" → upload the zip.
3. Fill in the listing:
   - **Privacy policy URL:** `privacy.html` (this repo's root) needs to be
     hosted somewhere publicly reachable before submitting -- not GitHub
     Pages (not in use for this repo). Host it on your own domain/VPS, or
     wherever else is convenient, and use that URL here.
   - **Single purpose:** "Detect and download video streams from the
     user's own logged-in Hudl session for offline film review."
   - **Permission justification** — explain each permission:
     - `webRequest`: observe video requests on `*.hudl.com` to detect streams.
     - `downloads`: save the detected video via Chrome's download manager.
     - `scripting`: read Hudl's per-clip metadata for filenames/sidecars.
     - `storage`: in-extension UI state.
     - `activeTab`: access the active tab when the user clicks the action.

## The one tradeoff to know about: host_permissions scoping

The manifest is scoped to `*://*.hudl.com/*` for both `host_permissions`
and `content_scripts.matches`. This is deliberate: `<all_urls>` plus
`webRequest` is the single most common reason video-downloaders get stalled
or rejected in review, and a Hudl-only scope is far easier to justify.

**What this can break:** if Hudl serves its actual video bytes from a
third-party CDN (e.g. an Akamai/CloudFront domain rather than a
`*.hudl.com` subdomain), `webRequest` won't see those requests and stream
detection will miss them.

**How to check / fix before submitting:**
1. Load the unpacked extension, open a Hudl video page, and watch
   DevTools → Network for the video request's domain.
2. If it's a `*.hudl.com` subdomain, you're done — submit as-is.
3. If it's a third-party CDN, add that domain to `host_permissions` in
   `extension/manifest.json` (e.g. `"*://*.example-cdn.com/*"`). Keep it
   as narrow as possible — every extra domain is another line of
   justification in the review.

The content script (`content_scripts.matches`) should stay scoped to
`*.hudl.com` regardless: it reads Hudl-specific `data-qa-id` attributes
that don't exist on other sites, so broadening it gains nothing and only
weakens the single-purpose story.
