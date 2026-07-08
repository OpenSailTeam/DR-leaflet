# Discovery Ridge Map Assets

This directory contains public map assets served beside the jsDelivr runtime.

```text
assets/discovery-ridge-2026-lot-map.svg
```

The runtime joins Webflow CMS Lots to SVG lot shapes by CMS `svgId`, which must exactly match an SVG shape element `id` such as `path123` or `rect17`.

Requirements:

- The SVG shape IDs assigned in CMS must be unique across lots.
- Mapped SVG elements must be clickable lot shapes: `path`, `rect`, `polygon`, `polyline`, `circle`, or `ellipse`.
- Keep the visible map artwork in the same SVG so Leaflet can render one public file.
- Do not include Webflow API tokens, webhook URLs, private exports, or other secrets.

The runtime still supports old `data-lot-slug` shapes as a fallback, but new production data should use CMS `svgId` assignments.
