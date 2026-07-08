(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var runtimeState = (window.__DRMapsRuntimeState = window.__DRMapsRuntimeState || {
    booted: false,
    maps: {},
  });

  var MAP_ID = "dr-lot-map";
  var CONFIG_ID = "dr-map-config";
  var LOTS_DATA_ID = "dr-lots-data";
  var LEGACY_LOT_SELECTOR = ".dr-lot[data-lot-slug]";

  function bootstrapRuntime() {
    if (runtimeState.booted) return;
    runtimeState.booted = true;

    injectBaseStyles();

    function normalizeQueueJob(job) {
      if (typeof job === "function") {
        return { kind: "function", fn: job };
      }

      if (!job || typeof job !== "object") {
        return { kind: "invalid" };
      }

      var type = String(job.type || "").trim();
      if (!type) return { kind: "invalid" };
      return { kind: "object", type: type, options: job.options || {} };
    }

    function runQueuedJob(job) {
      var normalized = normalizeQueueJob(job);
      if (normalized.kind === "function") {
        try {
          normalized.fn(window.DRMaps);
        } catch (err) {
          console.error("DRMaps queue function job failed", err);
        }
        return 1;
      }

      if (normalized.kind !== "object") return 0;
      var method = window.DRMaps && window.DRMaps[normalized.type];
      if (typeof method !== "function") {
        console.warn("DRMaps queue object job ignored; unknown type:", normalized.type);
        return 0;
      }

      try {
        method(normalized.options);
      } catch (err) {
        console.error("DRMaps queue object job failed", normalized.type, err);
      }
      return 1;
    }

    window.DRMaps = window.DRMaps || {
      initLotMap: initLotMap,
      getState: function getState(mapId) {
        return runtimeState.maps[mapId || MAP_ID] || null;
      },
    };

    var pendingJobs = Array.isArray(window.DRMapsQueue) ? window.DRMapsQueue.slice() : [];
    window.DRMapsQueue = {
      push: function push(job) {
        return runQueuedJob(job);
      },
    };

    var jobsRun = 0;
    pendingJobs.forEach(function (job) {
      jobsRun += runQueuedJob(job);
    });

    if (!jobsRun && document.getElementById(MAP_ID)) {
      window.DRMaps.initLotMap();
    }
  }

  function initLotMap(options) {
    options = options || {};

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          initLotMap(options);
        },
        { once: true },
      );
      return false;
    }

    var mapId = options.mapId || MAP_ID;
    var mapEl = document.getElementById(mapId);
    if (!mapEl) {
      console.warn("DRMaps map container not found:", mapId);
      return false;
    }

    if (typeof window.L === "undefined") {
      console.error("Leaflet not found. Ensure Leaflet is loaded before DRMaps runtime.");
      return false;
    }

    if (mapEl.getAttribute("data-drmaps-initialized") === "true") return false;
    mapEl.setAttribute("data-drmaps-initialized", "true");

    var mapData = getMapData(mapEl, options);
    var config = getConfig(options);
    var lots = getLotsData();
    var state = {
      mapId: mapId,
      mapEl: mapEl,
      map: null,
      lots: lots,
      lotsBySlug: buildLotsBySlug(lots),
      lotsBySvgId: buildLotsBySvgId(lots),
      shapesBySlug: {},
      shapesBySvgId: {},
      shapeLots: {},
      boundLots: [],
      warnings: [],
    };
    runtimeState.maps[mapId] = state;

    if (!mapData.svgUrl) {
      warn(state, "Missing SVG URL for Discovery Ridge map.");
      return false;
    }

    var minZoom = parseNumber(firstDefined(options.minZoom, mapEl.dataset.minZoom));
    if (minZoom === null) minZoom = -2;

    var map = window.L.map(mapId, {
      crs: window.L.CRS.Simple,
      zoomSnap: 0.1,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 80,
      minZoom: minZoom,
      attributionControl: false,
    });
    state.map = map;

    mapEl.classList.add("dr-map");
    if (!mapEl.style.minHeight) mapEl.style.minHeight = "560px";

    window.addEventListener("resize", function () {
      map.invalidateSize();
    });

    fetch(mapData.svgUrl)
      .then(function (response) {
        if (!response.ok) throw new Error("Failed to fetch SVG: " + response.status);
        return response.text();
      })
      .then(function (svgText) {
        var parsed = parseSvg(svgText);
        var svg = parsed.svg;
        var viewBox = parseViewBox(mapData.viewBox || svg.getAttribute("viewBox"));
        var width = parseLength(svg.getAttribute("width")) || mapData.width;
        var height = parseLength(svg.getAttribute("height")) || mapData.height;

        if (!viewBox && width && height) {
          viewBox = { minX: 0, minY: 0, width: width, height: height };
        }
        if (!viewBox) {
          viewBox = { minX: 0, minY: 0, width: 1000, height: 1000 };
          warn(state, "SVG missing viewBox and size; using 1000x1000 fallback bounds.");
        }

        svg.setAttribute("viewBox", [viewBox.minX, viewBox.minY, viewBox.width, viewBox.height].join(" "));
        svg.setAttribute("width", viewBox.width);
        svg.setAttribute("height", viewBox.height);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

        var bounds = window.L.latLngBounds([
          [viewBox.minY, viewBox.minX],
          [viewBox.minY + viewBox.height, viewBox.minX + viewBox.width],
        ]);

        var overlay = window.L.svgOverlay(svg, bounds, { interactive: true });
        overlay.addTo(map);
        fitMap(map, bounds, mapEl, options);
        map.setMaxBounds(bounds.pad(1.0));

        var svgRoot = overlay.getElement();
        state.svgRoot = svgRoot;
        prepareSvgForMap(svgRoot);
        validateAndIndexSvg(state, svgRoot);
        bindLotEvents(state, config);
        addStatusDots(state, config);
        addLegend(state, config);
        bindExternalFocusHandlers(state, config);
        openDeepLinkedLot(state, config);

        if (typeof options.onReady === "function") {
          options.onReady({
            map: map,
            lots: lots.slice(),
            warnings: state.warnings.slice(),
          });
        }
      })
      .catch(function (err) {
        mapEl.removeAttribute("data-drmaps-initialized");
        console.error("DRMaps SVG map failed", err);
      });

    return true;
  }

  function getMapData(mapEl, options) {
    options = options || {};
    var config = parseJsonScript("dr-map-data") || {};
    var svgUrl = firstDefined(
      options.svgUrl,
      mapEl.dataset.svgUrl,
      config.svgUrl,
      config.svg_url,
      config["svg-url"],
    );
    return {
      svgUrl: svgUrl,
      viewBox: firstDefined(options.viewBox, mapEl.dataset.svgViewbox, config.viewBox),
      width: parseLength(firstDefined(options.svgWidth, mapEl.dataset.svgWidth, config.width)),
      height: parseLength(firstDefined(options.svgHeight, mapEl.dataset.svgHeight, config.height)),
    };
  }

  function getConfig(options) {
    var config = parseJsonScript(CONFIG_ID) || {};
    var statuses = Array.isArray(options.statuses) ? options.statuses : config.statuses;
    return {
      statuses: normalizeStatuses(statuses || []),
      statusDotRadius: parseNumber(firstDefined(options.statusDotRadius, config.statusDotRadius)) || 7,
    };
  }

  function getLotsData() {
    var lots = [];
    var aggregate = parseJsonScript(LOTS_DATA_ID);
    if (Array.isArray(aggregate)) {
      lots = lots.concat(aggregate);
    } else if (aggregate && Array.isArray(aggregate.lots)) {
      lots = lots.concat(aggregate.lots);
    }

    document.querySelectorAll(".dr-lots-json,.dr-lot-json").forEach(function (node) {
      var parsed = parseJsonNode(node);
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        lots = lots.concat(parsed);
      } else if (Array.isArray(parsed.lots)) {
        lots = lots.concat(parsed.lots);
      } else {
        lots.push(parsed);
      }
    });

    return dedupeLots(lots.map(normalizeLot));
  }

  function normalizeStatuses(statuses) {
    var normalized = [];
    statuses.forEach(function (status) {
      if (!status) return;
      var label = firstDefined(status.label, status.name, status.status, "");
      var color = firstDefined(status.color, status.swatchColor, status.statusColor, "");
      var sort = parseNumber(firstDefined(status.sort, status.sortOrder, status.statusSort));
      if (!label || !color) return;
      normalized.push({
        label: String(label),
        color: String(color),
        sort: sort === null ? 9999 : sort,
      });
    });
    return normalized;
  }

  function normalizeLot(lot) {
    lot = lot || {};
    return {
      name: stringField(firstDefined(lot.name, lot.title, lot.Name)),
      slug: normalizeSlug(firstDefined(lot.slug, lot.Slug)),
      svgId: normalizeSvgId(
        firstDefined(
          lot.svgId,
          lot.svgID,
          lot.svg_id,
          lot["svg-id"],
          lot["SVG ID"],
          lot["Svg ID"],
          lot.elementSvgId,
          lot.svgElementId,
          lot["Element SVG ID"]
        )
      ),
      status: stringField(firstDefined(lot.status, lot.Status)),
      lotNumber: stringField(firstDefined(lot.lotNumber, lot.lot_number, lot["lot-number"], lot["Lot number"])),
      block: stringField(firstDefined(lot.block, lot.Block)),
      width: stringField(firstDefined(lot.width, lot.Width)),
      depth: stringField(firstDefined(lot.depth, lot.Depth)),
      type: stringField(firstDefined(lot.type, lot.Type)),
      price: stringField(firstDefined(lot.price, lot.Price)),
      builder: stringField(firstDefined(lot.builder, lot.Builder)),
      imageUrl: stringField(firstDefined(lot.imageUrl, lot.image_url, lot.Image)),
      buttonText: stringField(firstDefined(lot.buttonText, lot.button_text, lot["button-text"], lot["Button text"])),
      buttonUrl: stringField(firstDefined(lot.buttonUrl, lot.button_url, lot["button-url"], lot["Button URL"])),
    };
  }

  function dedupeLots(lots) {
    var out = [];
    var seen = Object.create(null);
    lots.forEach(function (lot) {
      var key = lot.slug ? "slug:" + lot.slug : lot.svgId ? "svg:" + lot.svgId : "";
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(lot);
    });
    return out;
  }

  function buildLotsBySlug(lots) {
    var lookup = Object.create(null);
    lots.forEach(function (lot) {
      if (lot.slug && !lookup[lot.slug]) lookup[lot.slug] = lot;
    });
    return lookup;
  }

  function buildLotsBySvgId(lots) {
    var lookup = Object.create(null);
    lots.forEach(function (lot) {
      if (lot.svgId && !lookup[lot.svgId]) lookup[lot.svgId] = lot;
    });
    return lookup;
  }

  function validateAndIndexSvg(state, svgRoot) {
    var seenSvgIds = Object.create(null);
    var shapeCount = 0;

    state.lots.forEach(function (lot) {
      if (!lot.svgId) {
        warn(state, "CMS lot is missing SVG ID: " + (lot.slug || lot.name || "unknown lot"));
        return;
      }

      if (seenSvgIds[lot.svgId]) {
        warn(state, "Duplicate CMS SVG ID: " + lot.svgId);
        return;
      }
      seenSvgIds[lot.svgId] = true;

      var shape = findSvgElementById(svgRoot, lot.svgId);
      if (!shape) {
        warn(state, "CMS lot SVG ID has no matching SVG element: " + lot.svgId);
        return;
      }
      if (!isClickableSvgShape(shape)) {
        warn(state, "CMS lot SVG ID matches a non-clickable SVG element: " + lot.svgId);
        return;
      }
      if (indexShapeForLot(state, shape, lot, "svgId")) shapeCount += 1;
    });

    svgRoot.querySelectorAll(LEGACY_LOT_SELECTOR).forEach(function (shape) {
      var slug = normalizeSlug(shape.getAttribute("data-lot-slug"));
      if (!slug) return;
      var lot = state.lotsBySlug[slug];
      if (!lot) {
        warn(state, "SVG lot has no matching CMS lot: " + slug);
        return;
      }
      if (!getShapeForLot(state, lot) && indexShapeForLot(state, shape, lot, "data-lot-slug")) shapeCount += 1;
    });

    if (!shapeCount) warn(state, "No SVG elements matched CMS lot SVG IDs.");

    state.lots.forEach(function (lot) {
      if (!getShapeForLot(state, lot)) {
        warn(state, "CMS lot has no bound SVG shape: " + (lot.svgId || lot.slug || lot.name || "unknown lot"));
      }
    });
  }

  function indexShapeForLot(state, shape, lot, source) {
    var shapeId = normalizeSvgId(shape.getAttribute("id"));
    var shapeKey = shapeId || lot.svgId || lot.slug;
    var existingLot = state.shapeLots[shapeKey];
    if (existingLot && existingLot !== lot) {
      warn(
        state,
        "SVG shape is assigned to multiple CMS lots: " +
          shapeKey +
          " (" +
          (existingLot.slug || existingLot.name || "existing") +
          ", " +
          (lot.slug || lot.name || "new") +
          ")"
      );
      return false;
    }

    state.shapeLots[shapeKey] = lot;
    if (lot.svgId) state.shapesBySvgId[lot.svgId] = shape;
    if (lot.slug) state.shapesBySlug[lot.slug] = shape;
    if (shapeId && !state.shapesBySvgId[shapeId]) state.shapesBySvgId[shapeId] = shape;
    shape.classList.add("dr-lot");
    shape.setAttribute("tabindex", "0");
    shape.setAttribute("role", "button");
    shape.setAttribute("aria-label", lot.name || lot.slug || lot.svgId || shapeId);
    shape.setAttribute("data-dr-bound-by", source);
    if (lot.slug) shape.setAttribute("data-dr-lot-slug", lot.slug);
    if (lot.svgId) shape.setAttribute("data-dr-svg-id", lot.svgId);
    state.boundLots.push(lot);
    return true;
  }

  function bindLotEvents(state, config) {
    var popup = null;
    var activeShape = null;

    function ensurePopup() {
      if (popup) return popup;
      popup = window.L.popup({
        closeButton: true,
        autoPan: true,
        offset: [0, -10],
        className: "dr-lot-popup-shell",
      });
      popup.on("remove", function () {
        if (activeShape) activeShape.classList.remove("is-active");
        activeShape = null;
      });
      state.popup = popup;
      return popup;
    }

    function openShape(shape, lot, lock) {
      var center = getShapeCenter(shape);
      if (!center) return false;
      ensurePopup()
        .setLatLng(window.L.latLng(center.y, center.x))
        .setContent(buildPopupHtml(lot, config))
        .openOn(state.map);

      if (lock) {
        if (activeShape && activeShape !== shape) activeShape.classList.remove("is-active");
        activeShape = shape;
        shape.classList.add("is-active");
      }
      return true;
    }

    state.openLotBySlug = function openLotBySlug(slug) {
      var key = normalizeSlug(slug);
      var lot = state.lotsBySlug[key];
      if (!lot) return false;
      return openLot(lot);
    };

    state.openLotBySvgId = function openLotBySvgId(svgId) {
      var key = normalizeSvgId(svgId);
      var lot = state.lotsBySvgId[key];
      if (!lot) return false;
      return openLot(lot);
    };

    function openLot(lot) {
      var shape = getShapeForLot(state, lot);
      if (!shape || !lot) return false;
      var center = getShapeCenter(shape);
      if (center) state.map.panTo(window.L.latLng(center.y, center.x), { animate: true });
      return openShape(shape, lot, true);
    }

    state.boundLots.forEach(function (lot) {
      var shape = getShapeForLot(state, lot);
      if (!shape || !lot || shape.getAttribute("data-dr-events-bound") === "true") return;
      shape.setAttribute("data-dr-events-bound", "true");

      shape.addEventListener("mouseenter", function () {
        shape.classList.add("is-hovered");
      });
      shape.addEventListener("mouseleave", function () {
        shape.classList.remove("is-hovered");
      });
      shape.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        openShape(shape, lot, true);
      });
      shape.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openShape(shape, lot, true);
      });
    });

    state.map.on("click", function () {
      if (popup) state.map.closePopup(popup);
    });
  }

  function addStatusDots(state, config) {
    var svgRoot = state.svgRoot;
    if (!svgRoot) return;
    var group = svgRoot.querySelector("#dr-status-dots");
    if (!group) {
      group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("id", "dr-status-dots");
      group.setAttribute("pointer-events", "none");
      svgRoot.appendChild(group);
    }
    group.innerHTML = "";

    state.boundLots.forEach(function (lot) {
      var shape = getShapeForLot(state, lot);
      if (!shape || !lot) return;
      var status = getStatusMeta(lot.status, config);
      if (!status.color) return;
      var center = getShapeCenter(shape);
      if (!center) return;

      var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", center.x);
      circle.setAttribute("cy", center.y);
      circle.setAttribute("r", config.statusDotRadius);
      circle.setAttribute("fill", status.color);
      circle.setAttribute("stroke", "#ffffff");
      circle.setAttribute("stroke-width", Math.max(1, config.statusDotRadius * 0.25));
      circle.setAttribute("data-dr-status-dot", lot.svgId || lot.slug || "");
      group.appendChild(circle);
    });
  }

  function addLegend(state, config) {
    if (!config.statuses.length) return;
    var legend = window.L.control({ position: "bottomright" });
    legend.onAdd = function () {
      var div = window.L.DomUtil.create("div", "dr-map-legend");
      var title = document.createElement("button");
      title.type = "button";
      title.className = "dr-map-legend__title";
      div.appendChild(title);

      var body = document.createElement("div");
      body.className = "dr-map-legend__body";
      div.appendChild(body);

      var open = true;
      function setOpen(nextOpen) {
        open = !!nextOpen;
        body.hidden = !open;
        title.textContent = open ? "Legend (hide)" : "Legend (show)";
        title.setAttribute("aria-expanded", open ? "true" : "false");
      }

      title.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(!open);
      });

      config.statuses
        .slice()
        .sort(function (a, b) {
          return a.sort - b.sort || a.label.localeCompare(b.label);
        })
        .forEach(function (status) {
          if (!statusIsPresent(state.lots, status.label)) return;
          var row = document.createElement("div");
          row.className = "dr-map-legend__item";
          var swatch = document.createElement("span");
          swatch.className = "dr-map-legend__swatch";
          swatch.style.background = status.color;
          var label = document.createElement("span");
          label.textContent = status.label;
          row.appendChild(swatch);
          row.appendChild(label);
          body.appendChild(row);
        });

      if (window.L.DomEvent) {
        window.L.DomEvent.disableClickPropagation(div);
        window.L.DomEvent.disableScrollPropagation(div);
      }
      setOpen(true);
      return div;
    };
    legend.addTo(state.map);
  }

  function bindExternalFocusHandlers(state) {
    if (state.externalFocusBound) return;
    state.externalFocusBound = true;
    document.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-dr-lot-slug],[data-dr-svg-id],[data-dr-lot-svg-id]");
      if (!trigger) return;
      var slug = trigger.getAttribute("data-dr-lot-slug");
      var svgId = trigger.getAttribute("data-dr-svg-id") || trigger.getAttribute("data-dr-lot-svg-id");
      var opened = (svgId && state.openLotBySvgId && state.openLotBySvgId(svgId)) || (slug && state.openLotBySlug && state.openLotBySlug(slug));
      if (!opened) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.mapEl && state.mapEl.scrollIntoView) {
        state.mapEl.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      }
    });
  }

  function openDeepLinkedLot(state) {
    if (!window.location || !window.location.search) return;
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (err) {
      return;
    }
    var slug = params.get("drLotSlug") || params.get("lot") || "";
    var svgId = params.get("drSvgId") || params.get("svgId") || "";
    if (!slug && !svgId) return;
    setTimeout(function () {
      var opened = (svgId && state.openLotBySvgId(svgId)) || (slug && state.openLotBySlug(slug));
      if (!opened) {
        warn(state, "Unable to open deep-linked lot: " + (svgId || slug));
      }
    }, 0);
  }

  function buildPopupHtml(lot, config) {
    var status = getStatusMeta(lot.status, config);
    var imageUrl = safeImageUrl(lot.imageUrl);
    var buttonUrl = safePublicUrl(lot.buttonUrl);
    var title = lot.name || lot.slug || "Lot";
    var rows = [
      ["Status", lot.status],
      ["Lot", joinParts([lot.lotNumber, lot.block ? "Block " + lot.block : ""])],
      ["Width", lot.width],
      ["Depth", lot.depth],
      ["Type", lot.type],
      ["Price", lot.price],
      ["Builder", lot.builder],
    ];

    var html = '<article class="dr-lot-popup">';
    if (imageUrl) {
      html += '<img class="dr-lot-popup__image" src="' + escapeAttr(imageUrl) + '" alt="' + escapeAttr(title) + '" loading="lazy">';
    }
    html += '<div class="dr-lot-popup__body">';
    html += '<h3 class="dr-lot-popup__title">' + escapeHtml(title) + "</h3>";
    if (lot.status) {
      html +=
        '<div class="dr-lot-popup__status" style="--dr-status-color:' +
        escapeAttr(status.color || "#667085") +
        '">' +
        escapeHtml(lot.status) +
        "</div>";
    }
    html += '<dl class="dr-lot-popup__details">';
    rows.forEach(function (row) {
      if (!row[1]) return;
      html += "<div><dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1]) + "</dd></div>";
    });
    html += "</dl>";
    if (buttonUrl && lot.buttonText) {
      var external = /^https?:/i.test(buttonUrl);
      html +=
        '<a class="dr-lot-popup__cta" href="' +
        escapeAttr(buttonUrl) +
        '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
        ">" +
        escapeHtml(lot.buttonText) +
        "</a>";
    }
    html += "</div></article>";
    return html;
  }

  function getStatusMeta(label, config) {
    var key = normalizeStatusKey(label);
    for (var i = 0; i < config.statuses.length; i += 1) {
      if (normalizeStatusKey(config.statuses[i].label) === key) return config.statuses[i];
    }
    return { label: label || "", color: "", sort: 9999 };
  }

  function statusIsPresent(lots, label) {
    var key = normalizeStatusKey(label);
    return lots.some(function (lot) {
      return normalizeStatusKey(lot.status) === key;
    });
  }

  function parseSvg(text) {
    var doc = new DOMParser().parseFromString(text, "image/svg+xml");
    var parserError = doc.querySelector("parsererror");
    if (parserError) throw new Error("Invalid SVG document");
    var svg = doc.querySelector("svg");
    if (!svg) throw new Error("No <svg> element found in SVG document");
    return { doc: doc, svg: svg };
  }

  function prepareSvgForMap(svgRoot) {
    if (!svgRoot) return;
    var rootImages = [];
    svgRoot.querySelectorAll("image").forEach(function (image) {
      image.setAttribute("pointer-events", "none");
      if (image.parentNode === svgRoot) rootImages.push(image);
    });

    if (!rootImages.length) return;
    var defs = svgRoot.querySelector("defs");
    var refNode = defs ? defs.nextSibling : svgRoot.firstChild;
    rootImages.reverse().forEach(function (image) {
      svgRoot.insertBefore(image, refNode);
    });
  }

  function findSvgElementById(svgRoot, svgId) {
    var key = normalizeSvgId(svgId);
    if (!svgRoot || !key) return null;
    var nodes = svgRoot.querySelectorAll("[id]");
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute("id") === key) return nodes[i];
    }
    return null;
  }

  function isClickableSvgShape(shape) {
    if (!shape || !shape.tagName || typeof shape.getBBox !== "function") return false;
    var tag = shape.tagName.toLowerCase().replace(/^.*:/, "");
    return ["path", "rect", "polygon", "polyline", "circle", "ellipse"].indexOf(tag) !== -1;
  }

  function getShapeForLot(state, lot) {
    if (!state || !lot) return null;
    if (lot.svgId && state.shapesBySvgId[lot.svgId]) return state.shapesBySvgId[lot.svgId];
    if (lot.slug && state.shapesBySlug[lot.slug]) return state.shapesBySlug[lot.slug];
    return null;
  }

  function fitMap(map, bounds, mapEl, options) {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [20, 20], animate: false });
    var zoomOffset = parseNumber(firstDefined(options.initialZoomOffset, mapEl.dataset.initialZoomOffset));
    if (zoomOffset !== null) map.setZoom(map.getZoom() + zoomOffset, { animate: false });
    setTimeout(function () {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [20, 20], animate: false });
    }, 100);
  }

  function getShapeCenter(shape) {
    if (!shape || typeof shape.getBBox !== "function") return null;
    try {
      var box = shape.getBBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } catch (err) {
      return null;
    }
  }

  function parseJsonScript(id) {
    var node = document.getElementById(id);
    return parseJsonNode(node);
  }

  function parseJsonNode(node) {
    if (!node) return null;
    if (node.tagName === "SCRIPT" && node.type && node.type !== "application/json") return null;
    var raw = node.dataset && node.dataset.json ? node.dataset.json : node.textContent || "";
    raw = decodeHtmlEntities(raw);
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("DRMaps failed to parse JSON", node.id || node.className || node, err);
      return null;
    }
  }

  function decodeHtmlEntities(value) {
    if (!value || value.indexOf("&") === -1) return value || "";
    var textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }

  function safePublicUrl(value) {
    var raw = String(value || "").trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return "";
    if (raw.charAt(0) === "/" && raw.charAt(1) !== "/") return raw;
    try {
      var url = new URL(raw, window.location.href);
      if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "tel:" || url.protocol === "mailto:") {
        return raw;
      }
    } catch (err) {
      return "";
    }
    return "";
  }

  function safeImageUrl(value) {
    var url = safePublicUrl(value);
    if (!url) return "";
    if (/^(tel|mailto):/i.test(url)) return "";
    return url;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function parseLength(value) {
    if (value === undefined || value === null || value === "") return null;
    var num = parseFloat(String(value).replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(num) ? num : null;
  }

  function parseNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    var num = parseFloat(String(value));
    return Number.isFinite(num) ? num : null;
  }

  function parseViewBox(value) {
    if (!value) return null;
    var parts = String(value)
      .trim()
      .split(/\s+/)
      .map(function (part) {
        return parseFloat(part);
      });
    if (
      parts.length !== 4 ||
      parts.some(function (part) {
        return !Number.isFinite(part);
      })
    ) {
      return null;
    }
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== "") return arguments[i];
    }
    return null;
  }

  function stringField(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function normalizeSlug(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeSvgId(value) {
    var trimmed = String(value || "").trim();
    return trimmed.charAt(0) === "#" ? trimmed.slice(1).trim() : trimmed;
  }

  function normalizeStatusKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function joinParts(parts) {
    return parts
      .filter(function (part) {
        return part !== undefined && part !== null && String(part).trim();
      })
      .join(" ");
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function warn(state, message) {
    state.warnings.push(message);
    console.warn("DRMaps:", message);
  }

  function injectBaseStyles() {
    if (document.getElementById("drmaps-base-styles")) return;
    var style = document.createElement("style");
    style.id = "drmaps-base-styles";
    style.textContent =
      ".dr-map{position:relative;background:#f8fafc}.dr-lot{cursor:pointer;pointer-events:all;transition:opacity 120ms ease,stroke-width 120ms ease}.dr-lot.is-hovered,.dr-lot.is-active{stroke:#111827!important;stroke-width:6!important;opacity:.92}.dr-lot-popup-shell .leaflet-popup-content{margin:0}.dr-lot-popup{width:min(280px,72vw);font:14px/1.4 Arial,sans-serif;color:#1f2937;background:#fff;border-radius:6px;overflow:hidden}.dr-lot-popup__image{display:block;width:100%;height:110px;object-fit:cover;background:#eef2f7}.dr-lot-popup__body{padding:14px}.dr-lot-popup__title{margin:0 0 8px;font-size:18px;line-height:1.2;color:#111827}.dr-lot-popup__status{display:inline-flex;align-items:center;gap:6px;margin:0 0 10px;font-weight:700;text-transform:uppercase;color:var(--dr-status-color)}.dr-lot-popup__status:before{content:\"\";width:9px;height:9px;border-radius:999px;background:var(--dr-status-color)}.dr-lot-popup__details{display:grid;gap:4px;margin:0}.dr-lot-popup__details div{display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px}.dr-lot-popup__details dt{font-weight:700;color:#475467}.dr-lot-popup__details dd{margin:0;color:#111827}.dr-lot-popup__cta{display:block;margin-top:12px;padding:9px 12px;border-radius:4px;background:#4fa5cc;color:#fff!important;text-align:center;text-decoration:none;font-weight:700}.dr-map-legend{padding:10px 12px;border-radius:6px;background:rgba(255,255,255,.94);box-shadow:0 8px 24px rgba(15,23,42,.18);font:13px/1.35 Arial,sans-serif;color:#1f2937}.dr-map-legend__title{display:block;width:100%;padding:0;margin:0 0 7px;border:0;background:transparent;text-align:left;font-weight:700;cursor:pointer}.dr-map-legend__body{display:grid;gap:6px}.dr-map-legend__item{display:flex;align-items:center;gap:7px}.dr-map-legend__swatch{display:inline-block;width:11px;height:11px;border-radius:999px;border:1px solid rgba(0,0,0,.14)}";
    (document.head || document.documentElement).appendChild(style);
  }

  window.__DRMapsBootstrapRuntime = bootstrapRuntime;
})();
