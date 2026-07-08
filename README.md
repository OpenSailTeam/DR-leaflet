# Discovery Ridge Leaflet Map Runtime

Public browser runtime for the Discovery Ridge lot map. This repository is intended to be served through jsDelivr and must contain only browser-safe files.

## Files

- `drmaps-loader.js` loads Leaflet and the map runtime.
- `runtime/drmaps-runtime.js` renders the SVG in Leaflet and binds CMS lot data.
- `assets/discovery-ridge-2026-lot-map.svg` is the public map artwork.
- `snippets/webflow-install.html` shows the Webflow embed contract.

## Webflow Contract

The browser receives lot data from hidden Webflow CMS JSON rendered on the page. It does not call the Webflow API and must not contain Webflow API tokens.

Each public lot JSON object should include:

```json
{
  "name": "Lot name",
  "slug": "lot-slug",
  "svgId": "path123",
  "status": "Developer Inventory",
  "lotNumber": "12",
  "block": "3",
  "width": "44",
  "depth": "115",
  "type": "Walkout",
  "price": "$123,000",
  "builder": "Builder name",
  "imageUrl": "https://example.com/image.jpg",
  "buttonText": "View lot",
  "buttonUrl": "/lots/lot-slug"
}
```

`svgId` must match the SVG element `id` assigned to that lot in Webflow CMS.

## jsDelivr URL

Use `@main` only for staging. Production embeds should point to an immutable version tag after pushing this directory to its own public GitHub repository.

```html
<script src="https://cdn.jsdelivr.net/gh/OWNER/REPO@TAG/drmaps-loader.js"></script>
```

## Safety

Before publishing, scan the repo for secrets:

```bash
rg -n "WEBFLOW_API|Bearer|api[_-]?key|token|secret|webhook|zapier" .
```
