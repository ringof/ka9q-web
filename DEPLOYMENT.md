# Deployment Plan: w1euj.js Script Distribution

## Current State

`w1euj.js` is a Tampermonkey/Greasemonkey userscript that adds a custom UI overlay to ka9q-web's `radio.html`. Users must manually install it in their browser's userscript manager.

## Goal

Serve `w1euj.js` directly from the GitHub repo so it can be loaded as a `<script>` tag in `radio.html`, eliminating the need for a userscript manager.

## Options

### Option A: jsDelivr CDN (Recommended)

jsDelivr is a free, public CDN that mirrors GitHub repos with correct MIME types and caching.

```html
<script src="https://cdn.jsdelivr.net/gh/ringof/ka9q-web@main/w1euj.js" defer></script>
```

**Pros:**
- Correct `application/javascript` content type
- Global CDN with caching (fast loads)
- Supports pinning to a branch, tag, or commit
- No extra setup required — works with any public GitHub repo

**Cons:**
- Cache can lag behind pushes by up to 24h (purgeable via `https://purge.jsdelivr.net/gh/ringof/ka9q-web@main/w1euj.js`)
- Depends on a third-party service

### Option B: raw.githubusercontent.com

GitHub's raw file hosting, available for any public repo.

```html
<script src="https://raw.githubusercontent.com/ringof/ka9q-web/main/w1euj.js" defer></script>
```

**Pros:**
- Zero setup — just use the URL
- Always serves the latest committed version

**Cons:**
- Serves files as `text/plain`, which some browsers block as a script source
- No CDN caching
- Not intended for production use; GitHub may rate-limit or block high-traffic usage

### Option C: GitHub Pages

Not recommended. Adds a `gh-pages` branch and build step for no benefit over the options above when the repo is already public.

## Recommended Approach

1. **Use jsDelivr (Option A)** for external/public consumers.
2. **Pin to a tag or commit** for stability in production deployments:
   ```html
   <!-- pinned to a specific version tag -->
   <script src="https://cdn.jsdelivr.net/gh/ringof/ka9q-web@v0.9.10/w1euj.js" defer></script>

   <!-- pinned to a specific commit -->
   <script src="https://cdn.jsdelivr.net/gh/ringof/ka9q-web@abc1234/w1euj.js" defer></script>
   ```
3. **For local/self-hosted ka9q-web instances**, the script is already installed by `make install` alongside the other HTML/JS assets — no CDN needed.

## Integration Steps

1. Remove the `// ==UserScript==` metadata block from `w1euj.js` (or create a separate build without it), since it's only meaningful to userscript managers and is dead weight when loaded via `<script>`.
2. Add the `<script>` tag to `html/radio.html` before the closing `</body>`:
   ```html
   <script src="https://cdn.jsdelivr.net/gh/ringof/ka9q-web@main/w1euj.js" defer></script>
   ```
3. Tag releases to allow consumers to pin to stable versions.
4. Purge the jsDelivr cache after pushing updates if immediate availability is needed:
   ```
   curl -s https://purge.jsdelivr.net/gh/ringof/ka9q-web@main/w1euj.js
   ```
