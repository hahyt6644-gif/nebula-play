(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var input = $("link"), playBtn = $("play"), video = $("player");
  var loading = $("loading"), loadingText = $("loading-text");
  var errorBox = $("error"), errorText = $("error-text"), retryBtn = $("retry");
  var features = $("features");

  /* ---------- Telegram WebApp: register user ---------- */
  try {
    var tg = window.Telegram && window.Telegram.WebApp;
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

  /* ---------- Tier 1: Adsgram rewarded (test blockId "8") ---------- */
  function showAdsgram() {
    return new Promise(function (resolve, reject) {
      if (!window.Adsgram) return reject(new Error("Adsgram SDK not loaded"));
      try {
        window.Adsgram.init({ blockId: "56812" }).show()
          .then(function (result) { resolve(result); })
          .catch(function (err) { reject(err || new Error("Adsgram no fill")); });
      } catch (err) { reject(err); }
    });
  }

  /* ---------- Tier 2: Tads fullscreen (debug: true, hard 7s timeout) ---------- */
  function showTads() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
      // Strict 7s cap: never let the UI freeze on a stuck SDK
      var timer = setTimeout(function () {
        console.log("[Tads] 7s timeout - continuing");
        finish(false);
      }, 7000);

      try {
        if (!window.tads || typeof window.tads.init !== "function") return finish(false);
        var ad = window.tads.init({
          widgetId: "11137",
          type: "fullscreen",
          debug: true,
          onShow: function () { /* ad visible; wait for close, 7s timer is cleared on close */ clearTimeout(timer); },
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

  /* ---------- Waterfall: Tier 1 -> Tier 2 -> always resolves ---------- */
  async function runAdWaterfall() {
    try {
      await showAdsgram();
      return "adsgram";
    } catch (err) {
      console.log("[Adsgram] failed, falling back to Tads:", err);
    }
    var shown = await showTads();
    return shown ? "tads" : "none";
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

  /* ---------- Play flow ---------- */
  async function onPlay() {
    var link = input.value.trim();
    if (!link) return;

    errorBox.hidden = true;
    features.hidden = true;
    video.hidden = true;
    video.pause();
    video.removeAttribute("src");
    video.load();

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
      setBusy(false);
      video.src = videoUrl;
      video.hidden = false;
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
