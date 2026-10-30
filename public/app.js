(function () {
  "use strict";

  /* =====================================================================
   *  CONFIG  –  edit only this block to customise ads
   * ===================================================================== */
  var CONFIG = {
    // Waterfall order. First entry is tried first; if it fails / no fill,
    // the next one is tried. Swap the two names to change priority.
    adOrder: ["tads", "adsgram"],

    // Mid-roll: pause the video and show another ad after this many seconds of playback
    midRollAfterSeconds: 30,

    adsgramBlockId: "56812",   // Adsgram rewarded unit

    tadsWidgetId: "12977",     // Tads widget ID
    tadsDebug: false,          // true = test ads only (no revenue)
    tadsTimeoutMs: 7000        // strict cap so the UI never freezes
  };

  var $ = function (id) { return document.getElementById(id); };
  var input = $("link"), playBtn = $("play"), video = $("player");
  var playerBox = $("player-box"), downloadBtn = $("download");
  var loading = $("loading"), loadingText = $("loading-text");
  var errorBox = $("error"), errorText = $("error-text"), retryBtn = $("retry");
  var features = $("features");

  var currentVideoUrl = null;
  var midRollDone = false;
  var midRollRunning = false;

  /* ---------- Telegram WebApp: register user ---------- */
  var tg = window.Telegram && window.Telegram.WebApp;
  try {
    if (tg) {
      tg.ready();
      tg.expand();
      var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.id) {
        fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: u.id,
            username: u.username || null,
            first_name: u.first_name || ""
          })
        }).catch(function (e) { console.error("[register]", e); });
      }
      // Deep link: ?startapp=<base64url of the link>
      var sp = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (sp) {
        try {
          var b = sp.replace(/-/g, "+").replace(/_/g, "/");
          while (b.length % 4) b += "=";
          input.value = atob(b);
          playBtn.disabled = !input.value.trim();
        } catch (e) {}
      }
    }
  } catch (e) { console.error(e); }

  /* ---------- UI helpers ---------- */
  function setBusy(busy, text) {
    input.disabled = busy;
    playBtn.disabled = busy || !input.value.trim();
    loading.hidden = !busy;
    if (text) loadingText.textContent = text;
  }
  function showError(msg) {
    setBusy(false);
    errorText.textContent = msg;
    errorBox.hidden = false;
    features.hidden = false;
  }

  /* ---------- Ad provider: Adsgram rewarded -> Promise<boolean> ---------- */
  function showAdsgram() {
    return new Promise(function (resolve) {
      if (!window.Adsgram) return resolve(false);
      try {
        window.Adsgram.init({ blockId: CONFIG.adsgramBlockId }).show()
          .then(function () { resolve(true); })
          .catch(function (err) {
            console.log("[Adsgram] skipped / no fill:", err);
            resolve(false);
          });
      } catch (err) {
        console.log("[Adsgram] exception:", err);
        resolve(false);
      }
    });
  }

  /* ---------- Ad provider: Tads fullscreen -> Promise<boolean> (hard timeout) ---------- */
  function showTads() {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        console.log("[Tads] timeout - moving on");
        finish(false);
      }, CONFIG.tadsTimeoutMs);

      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }

      try {
        if (!window.tads || typeof window.tads.init !== "function") return finish(false);
        var ad = window.tads.init({
          widgetId: CONFIG.tadsWidgetId,
          type: "fullscreen",
          debug: CONFIG.tadsDebug,
          onShow: function () { clearTimeout(timer); },   // ad is visible: wait for close
          onShowReward: function () { finish(true); },
          onClose: function () { finish(true); },
          onAdsNotFound: function () { finish(false); },
          onError: function () { finish(false); }
        });
        if (ad && typeof ad.showAd === "function") {
          var r = ad.showAd();
          if (r && typeof r.catch === "function") r.catch(function () { finish(false); });
        } else {
          finish(false);
        }
      } catch (err) {
        console.error("[Tads]", err);
        finish(false);
      }
    });
  }

  var PROVIDERS = { tads: showTads, adsgram: showAdsgram };

  /* ---------- Waterfall: runs CONFIG.adOrder, stops at first ad that shows ---------- */
  async function runAdWaterfall() {
    for (var i = 0; i < CONFIG.adOrder.length; i++) {
      var name = CONFIG.adOrder[i];
      var fn = PROVIDERS[name];
      if (!fn) continue;
      console.log("[Waterfall] trying", name);
      var shown = await fn();
      if (shown) return name;
    }
    return "none"; // nothing filled: caller continues anyway
  }

  /* ---------- Extract helper (tolerant to response shape) ---------- */
  function pickVideoUrl(data) {
    if (!data) return null;
    if (typeof data === "string" && /^https?:\/\//i.test(data)) return data;
    var keys = ["videoUrl", "video_url", "url", "link", "direct_link", "directLink", "download_link", "downloadUrl", "stream_url", "streamUrl"];
    for (var i = 0; i < keys.length; i++) {
      var v = data[keys[i]];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    }
    if (data.data) return pickVideoUrl(data.data);
    if (data.result) return pickVideoUrl(data.result);
    return null;
  }

  function exitFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen();
    } catch (e) {}
  }

  /* ---------- Mid-roll: after N seconds of playback, pause -> ad -> resume ---------- */
  async function runMidRoll() {
    if (midRollDone || midRollRunning) return;
    midRollRunning = true;
    midRollDone = true;               // only once per video

    video.pause();
    exitFullscreen();
    playerBox.hidden = true;          // hide video while the ad runs
    setBusy(true, "Loading ad…");

    await runAdWaterfall();

    setBusy(false);
    playerBox.hidden = false;         // then show the video again
    try { await video.play(); } catch (e) { /* user taps play */ }
    midRollRunning = false;
  }

  video.addEventListener("timeupdate", function () {
    if (!midRollDone && !midRollRunning && video.currentTime >= CONFIG.midRollAfterSeconds) {
      runMidRoll();
    }
  });

  /* ---------- Download button ---------- */
  downloadBtn.addEventListener("click", function () {
    if (!currentVideoUrl) return;
    try {
      if (tg && typeof tg.openLink === "function") {
        tg.openLink(currentVideoUrl);   // opens in the phone's browser, which handles downloads
        return;
      }
    } catch (e) {}
    var a = document.createElement("a");
    a.href = currentVideoUrl;
    a.download = "";
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ---------- Play flow ---------- */
  async function onPlay() {
    var link = input.value.trim();
    if (!link) return;

    errorBox.hidden = true;
    features.hidden = true;
    playerBox.hidden = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
    currentVideoUrl = null;
    midRollDone = false;
    midRollRunning = false;

    setBusy(true, "Loading ad…");
    await runAdWaterfall(); // resolves whether played or skipped

    setBusy(true, "Fetching video…");
    try {
      var res = await fetch("/api/extract?url=" + encodeURIComponent(link));
      var data = await res.json();
      var videoUrl = res.ok ? pickVideoUrl(data) : null;
      if (!videoUrl) {
        return showError((data && data.error) || "Could not get a video link. Try again.");
      }
      currentVideoUrl = videoUrl;
      setBusy(false);
      video.src = videoUrl;
      playerBox.hidden = false;
      try { await video.play(); } catch (e) { /* autoplay blocked: user taps play */ }
    } catch (err) {
      console.error("[extract]", err);
      showError("Network error. Please try again.");
    }
  }

  input.addEventListener("input", function () { playBtn.disabled = !input.value.trim(); });
  input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !playBtn.disabled) onPlay(); });
  playBtn.addEventListener("click", onPlay);
  retryBtn.addEventListener("click", function () {
    errorBox.hidden = true;
    input.disabled = false;
    playBtn.disabled = !input.value.trim();
  });
})();
