/**
 * iTranslate Demo -- Frontend Application
 */
(function () {
  "use strict";

  // -------------------------------------------------------
  // DOM
  // -------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var connectionBadge  = $("connectionBadge");
  var statusDot        = $("statusDot");
  var statusLabel      = $("statusLabel");
  var langPairBadge    = $("langPairBadge");
  var waveformCanvas   = $("waveformCanvas");
  var sourceTranscript = $("sourceTranscript");
  var targetTranscript = $("targetTranscript");
  var sourceLangBadge  = $("sourceLangBadge");
  var targetLangBadge  = $("targetLangBadge");
  var transcriptDivider = $("transcriptDivider");
  var dividerIcon      = $("dividerIcon");
  var detectionText    = $("detectionText");
  var metricSTT        = $("metricSTT");
  var metricTranslate  = $("metricTranslate");
  var metricTTS        = $("metricTTS");
  var metricTotal      = $("metricTotal");
  var micButton        = $("micButton");
  var micIconIdle      = $("micIconIdle");
  var micIconActive    = $("micIconActive");
  var infoStatus       = $("infoStatus");
  var infoSessionId    = $("infoSessionId");
  var infoAudioDuration = $("infoAudioDuration");
  var infoExpires      = $("infoExpires");
  var configLangA      = $("configLangA");
  var configLangB      = $("configLangB");
  var configConfidence = $("configConfidence");
  var confidenceValue  = $("confidenceValue");
  var configKeyterms   = $("configKeyterms");
  var historyBody      = $("historyBody");

  // -------------------------------------------------------
  // State
  // -------------------------------------------------------
  var ws = null;
  var audioContext = null;
  var mediaStream = null;
  var workletNode = null;
  var analyserNode = null;
  var isRecording = false;
  var turnStartTime = null;
  var sttLatency = 0;
  var totalTranslateLatency = 0;
  var totalTTSLatency = 0;
  var turnCounter = 0;
  var ttsQueue = [];
  var isPlayingTTS = false;
  var waveformAnimId = null;
  var lastWasEndOfTurn = true;

  var LANG_NAMES = { en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese" };
  var LANG_SHORT = { en: "EN", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT" };

  // -------------------------------------------------------
  // Config
  // -------------------------------------------------------
  function getConfig() {
    var keyterms = configKeyterms.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      languageA: configLangA.value,
      languageB: configLangB.value,
      sampleRate: 16000,
      endOfTurnConfidence: parseFloat(configConfidence.value),
      keytermsPrompt: keyterms
    };
  }

  function updateLangPairDisplay() {
    var a = LANG_SHORT[configLangA.value] || configLangA.value.toUpperCase();
    var b = LANG_SHORT[configLangB.value] || configLangB.value.toUpperCase();
    langPairBadge.textContent = a + " \u2194 " + b;
    sourceLangBadge.textContent = a;
    targetLangBadge.textContent = b;
  }

  configLangA.addEventListener("change", updateLangPairDisplay);
  configLangB.addEventListener("change", updateLangPairDisplay);
  configConfidence.addEventListener("input", function () { confidenceValue.textContent = this.value; });

  // -------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------
  function connectWebSocket() {
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () { console.log("[WS] Connected"); };
    ws.onmessage = function (e) {
      try { handleServerMessage(JSON.parse(e.data)); } catch (err) { console.error("[WS] Parse error", err); }
    };
    ws.onerror = function () { setConnectionStatus("error"); };
    ws.onclose = function () { setConnectionStatus("disconnected"); setTimeout(connectWebSocket, 2000); };
  }

  function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
  function sendAudio(buf) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf); }

  // -------------------------------------------------------
  // Server message handler
  // -------------------------------------------------------
  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status": setConnectionStatus(msg.status); break;
      case "session_begin":
        infoSessionId.textContent = msg.sessionId ? msg.sessionId.substring(0, 12) + "..." : "--";
        infoExpires.textContent = msg.expiresAt ? new Date(msg.expiresAt * 1000).toLocaleTimeString() : "--";
        infoStatus.textContent = "Active";
        break;
      case "transcript": handleTranscript(msg); break;
      case "translation": handleTranslation(msg); break;
      case "tts_audio": handleTTSAudio(msg); break;
      case "session_end":
        infoAudioDuration.textContent = (msg.audioDuration || 0).toFixed(1) + "s";
        infoStatus.textContent = "Ended";
        break;
      case "error":
        console.error("[Server]", msg.message);
        detectionText.textContent = "Error: " + msg.message;
        break;
    }
  }

  // -------------------------------------------------------
  // Transcript
  // -------------------------------------------------------
  function handleTranscript(msg) {
    if (!msg.transcript) return;

    // New turn started
    if (lastWasEndOfTurn && !msg.endOfTurn && msg.transcript) {
      turnStartTime = Date.now();
      sourceTranscript.innerHTML = "";
      targetTranscript.innerHTML = '<span class="ghost">Translation appears here</span>';
      transcriptDivider.classList.remove("visible");
      transcriptDivider.classList.remove("translating");
    }
    lastWasEndOfTurn = msg.endOfTurn;

    if (turnStartTime && msg.endOfTurn) sttLatency = Date.now() - turnStartTime;

    sourceTranscript.textContent = msg.transcript;

    if (msg.languageCode) {
      sourceLangBadge.textContent = LANG_SHORT[msg.languageCode] || msg.languageCode.toUpperCase();
      var cfg = getConfig();
      var tgt = msg.languageCode === cfg.languageA ? cfg.languageB : cfg.languageA;
      targetLangBadge.textContent = LANG_SHORT[tgt] || tgt.toUpperCase();
    }

    if (msg.languageCode && msg.languageConfidence) {
      detectionText.textContent = (LANG_NAMES[msg.languageCode] || msg.languageCode) + " \u2014 " + (msg.languageConfidence * 100).toFixed(1) + "%";
    }

    if (msg.endOfTurn) {
      transcriptDivider.classList.add("visible");
      transcriptDivider.classList.add("translating");
      targetTranscript.innerHTML = '<span class="ghost">Translating...</span>';
      turnStartTime = null;
      if (sttLatency) metricSTT.textContent = sttLatency + "ms";
    }
  }

  // -------------------------------------------------------
  // Translation
  // -------------------------------------------------------
  function handleTranslation(msg) {
    transcriptDivider.classList.remove("translating");
    targetTranscript.textContent = msg.translated;
    totalTranslateLatency = msg.translateLatency || 0;
    metricTranslate.textContent = totalTranslateLatency + "ms";
    if (msg.targetLang) targetLangBadge.textContent = LANG_SHORT[msg.targetLang] || msg.targetLang.toUpperCase();
  }

  // -------------------------------------------------------
  // TTS Audio
  // -------------------------------------------------------
  function handleTTSAudio(msg) {
    totalTTSLatency = msg.ttsLatency || 0;
    metricTTS.textContent = totalTTSLatency + "ms";
    metricTotal.textContent = (sttLatency + totalTranslateLatency + totalTTSLatency) + "ms";
    addHistoryEntry();
    ttsQueue.push(msg.audio);
    playNextTTS();
  }

  function playNextTTS() {
    if (isPlayingTTS || !ttsQueue.length) return;
    isPlayingTTS = true;

    var raw = atob(ttsQueue.shift());
    var buf = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

    var blob = new Blob([buf.buffer], { type: "audio/mp3" });
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);

    showTTSPlaying(true);
    audio.onended = function () { URL.revokeObjectURL(url); isPlayingTTS = false; showTTSPlaying(false); playNextTTS(); };
    audio.onerror = function () { URL.revokeObjectURL(url); isPlayingTTS = false; showTTSPlaying(false); playNextTTS(); };
    audio.play().catch(function () { isPlayingTTS = false; showTTSPlaying(false); playNextTTS(); });
  }

  function showTTSPlaying(show) {
    var el = targetTranscript.querySelector(".tts-playing");
    if (show && !el) {
      var d = document.createElement("div");
      d.className = "tts-playing";
      d.innerHTML = '<div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div> Playing';
      targetTranscript.appendChild(d);
    } else if (!show && el) { el.remove(); }
  }

  // -------------------------------------------------------
  // History
  // -------------------------------------------------------
  function addHistoryEntry() {
    turnCounter++;
    var empty = historyBody.querySelector(".history-empty");
    if (empty) empty.remove();

    var src = sourceTranscript.textContent || "";
    var tgt = targetTranscript.textContent || "";
    var sl = sourceLangBadge.textContent;
    var tl = targetLangBadge.textContent;

    var e = document.createElement("div");
    e.className = "history-entry";
    e.innerHTML =
      '<div class="history-turn-num">Turn ' + turnCounter + "</div>" +
      '<div class="history-row"><span class="history-lang source">' + esc(sl) + '</span><span class="history-text">' + esc(src) + "</span></div>" +
      '<div class="history-row"><span class="history-lang target">' + esc(tl) + '</span><span class="history-text">' + esc(tgt) + "</span></div>" +
      '<div class="history-meta">' + sttLatency + "ms + " + totalTranslateLatency + "ms + " + totalTTSLatency + "ms</div>";
    historyBody.appendChild(e);
    historyBody.scrollTop = historyBody.scrollHeight;
  }

  function esc(t) { var d = document.createElement("div"); d.appendChild(document.createTextNode(t)); return d.innerHTML; }

  // -------------------------------------------------------
  // Connection Status
  // -------------------------------------------------------
  function setConnectionStatus(s) {
    statusDot.className = "bar-dot";
    connectionBadge.className = "connection-pill";

    if (s === "connected") {
      statusDot.classList.add("connected");
      statusLabel.textContent = "Connected";
      connectionBadge.classList.add("connected");
      connectionBadge.innerHTML = '<span class="pill-dot"></span>Connected';
      infoStatus.textContent = "Connected";
    } else if (s === "disconnected") {
      statusLabel.textContent = "Disconnected";
      connectionBadge.innerHTML = '<span class="pill-dot"></span>Disconnected';
      infoStatus.textContent = "Disconnected";
    } else {
      statusLabel.textContent = "Error";
      connectionBadge.innerHTML = '<span class="pill-dot"></span>Error';
      infoStatus.textContent = "Error";
    }
  }

  // -------------------------------------------------------
  // Microphone
  // -------------------------------------------------------
  async function startMicrophone() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.audioWorklet.addModule("audio-processor.js");

      var source = audioContext.createMediaStreamSource(mediaStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      workletNode = new AudioWorkletNode(audioContext, "audio-processor");
      workletNode.port.onmessage = function (ev) { sendAudio(ev.data); };
      analyserNode.connect(workletNode);

      drawWaveform();
      return true;
    } catch (err) {
      console.error("[Mic]", err);
      detectionText.textContent = "Mic access denied";
      return false;
    }
  }

  function stopMicrophone() {
    if (waveformAnimId) { cancelAnimationFrame(waveformAnimId); waveformAnimId = null; }
    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (analyserNode) { analyserNode.disconnect(); analyserNode = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
    clearWaveform();
  }

  // -------------------------------------------------------
  // Waveform
  // -------------------------------------------------------
  function drawWaveform() {
    if (!analyserNode) return;
    var ctx = waveformCanvas.getContext("2d");
    var W = waveformCanvas.width;
    var H = waveformCanvas.height;
    var len = analyserNode.frequencyBinCount;
    var data = new Uint8Array(len);
    var bars = 36;
    var bw = W / bars - 2;
    var step = Math.floor(len / bars);

    function draw() {
      waveformAnimId = requestAnimationFrame(draw);
      analyserNode.getByteFrequencyData(data);
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < bars; i++) {
        var v = data[i * step] || 0;
        var bh = (v / 255) * H * 0.88;
        var x = i * (bw + 2);
        var t = i / bars;
        var r = Math.round(110 + t * 143);
        var g = Math.round(168 - t * 4);
        var b = Math.round(254 - t * 79);
        var a = 0.4 + (v / 255) * 0.6;
        ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + a.toFixed(2) + ")";
        ctx.beginPath();
        ctx.roundRect(x, H - bh, bw, bh, 2);
        ctx.fill();
      }
    }
    draw();
  }

  function clearWaveform() {
    var ctx = waveformCanvas.getContext("2d");
    ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  }

  // -------------------------------------------------------
  // Session control
  // -------------------------------------------------------
  async function startSession() {
    updateLangPairDisplay();
    resetScreen();

    var ok = await startMicrophone();
    if (!ok) return;

    sendCtrl({ type: "start", config: getConfig() });
    isRecording = true;
    turnStartTime = Date.now();

    micButton.classList.add("active");
    micIconIdle.style.display = "none";
    micIconActive.style.display = "block";
    statusDot.classList.add("recording");
    statusLabel.textContent = "Recording";
    configLangA.disabled = true;
    configLangB.disabled = true;
  }

  function stopSession() {
    sendCtrl({ type: "stop" });
    stopMicrophone();
    isRecording = false;
    turnStartTime = null;

    micButton.classList.remove("active");
    micIconIdle.style.display = "block";
    micIconActive.style.display = "none";
    statusDot.className = "bar-dot";
    statusLabel.textContent = "Stopped";
    configLangA.disabled = false;
    configLangB.disabled = false;
  }

  function resetScreen() {
    sourceTranscript.innerHTML = '<span class="ghost">Tap the mic to start...</span>';
    targetTranscript.innerHTML = '<span class="ghost">Translation appears here</span>';
    transcriptDivider.classList.remove("visible");
    transcriptDivider.classList.remove("translating");
    detectionText.textContent = "";
    metricSTT.textContent = "--";
    metricTranslate.textContent = "--";
    metricTTS.textContent = "--";
    metricTotal.textContent = "--";
    sttLatency = 0;
    totalTranslateLatency = 0;
    totalTTSLatency = 0;
  }

  // -------------------------------------------------------
  // Events
  // -------------------------------------------------------
  micButton.addEventListener("click", function () {
    if (isRecording) stopSession(); else startSession();
  });

  // -------------------------------------------------------
  // Init
  // -------------------------------------------------------
  updateLangPairDisplay();
  connectWebSocket();
})();
