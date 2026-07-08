/*
  Discovery Ridge Leaflet map loader for jsDelivr.
  Include this file after defining window.DRMapsQueue jobs.
*/
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var state = (window.__DRMapsLoaderState = window.__DRMapsLoaderState || {
    started: false,
    booted: false,
    scripts: {},
    styles: {},
  });

  var LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  var LEAFLET_SRC = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

  function getLoaderBaseUrl() {
    var current = document.currentScript;
    if (current && current.src) {
      return current.src.replace(/[^/?#]+(\?.*)?$/, "");
    }

    var tag = document.querySelector('script[src*="drmaps-loader.js"]');
    if (tag && tag.src) {
      return tag.src.replace(/[^/?#]+(\?.*)?$/, "");
    }

    return "";
  }

  var BASE_URL = getLoaderBaseUrl();

  function isLeafletLoaded() {
    return typeof window.L !== "undefined";
  }

  function loadStyle(href) {
    if (!href || state.styles[href]) return state.styles[href] || Promise.resolve();

    var existing = document.querySelector('link[data-drmaps-href="' + href + '"]');
    if (existing) {
      state.styles[href] = Promise.resolve();
      return state.styles[href];
    }

    state.styles[href] = new Promise(function (resolve, reject) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.drmapsHref = href;
      link.addEventListener("load", resolve);
      link.addEventListener("error", function (err) {
        reject(err || new Error("Failed loading stylesheet: " + href));
      });
      (document.head || document.documentElement).appendChild(link);
    });

    return state.styles[href];
  }

  function loadScript(src, isLoadedCheck) {
    if (typeof isLoadedCheck === "function" && isLoadedCheck()) {
      return Promise.resolve();
    }

    if (state.scripts[src]) return state.scripts[src];

    state.scripts[src] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-drmaps-src="' + src + '"]');
      if (existing) {
        if (existing.getAttribute("data-drmaps-loaded") === "true") {
          resolve();
          return;
        }
        existing.addEventListener("load", function () {
          existing.setAttribute("data-drmaps-loaded", "true");
          resolve();
        });
        existing.addEventListener("error", function (err) {
          reject(err || new Error("Failed loading script: " + src));
        });
        return;
      }

      var script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.drmapsSrc = src;
      script.addEventListener("load", function () {
        script.setAttribute("data-drmaps-loaded", "true");
        resolve();
      });
      script.addEventListener("error", function (err) {
        reject(err || new Error("Failed loading script: " + src));
      });
      (document.head || document.body || document.documentElement).appendChild(script);
    });

    return state.scripts[src];
  }

  function loadInternal(path) {
    if (!BASE_URL) {
      return Promise.reject(new Error("Unable to resolve drmaps-loader base URL"));
    }
    return loadScript(BASE_URL + path);
  }

  function bootRuntime() {
    if (state.booted) return;
    state.booted = true;

    if (typeof window.__DRMapsBootstrapRuntime === "function") {
      window.__DRMapsBootstrapRuntime();
      return;
    }

    console.error("DRMaps runtime bootstrap function missing.");
  }

  function start() {
    if (state.started) return;
    state.started = true;

    loadStyle(LEAFLET_CSS)
      .catch(function (err) {
        console.warn("DRMaps Leaflet stylesheet failed to load", err);
      })
      .then(function () {
        return loadScript(LEAFLET_SRC, isLeafletLoaded);
      })
      .then(function () {
        return loadInternal("runtime/drmaps-runtime.js");
      })
      .then(bootRuntime)
      .catch(function (err) {
        console.error("DRMaps loader failed", err);
      });
  }

  start();
})();
