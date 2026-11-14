// Browser platform runtime for DeskFleet KMP Web (Kotlin/Wasm).
// Provides Cookie-credentialed fetch, WebRTC PeerConnection + H.264 <video> frame capture,
// WebAuthn Passkeys, File System Access / download helpers, WakeLock, and Notifications.
(function () {
  "use strict";

  const originalFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
  if (originalFetch) {
    globalThis.fetch = function (input, init) {
      const nextInit = Object.assign({ credentials: "include" }, init || {});
      return originalFetch(input, nextInit);
    };
  }

  let cachedFragmentToken = null;
  (function captureInitialFragmentToken() {
    try {
      const rawHash = location.hash ? location.hash.slice(1) : "";
      const params = new URLSearchParams(rawHash);
      const tok = params.get("token");
      if (tok) {
        cachedFragmentToken = tok;
        history.replaceState(null, "", location.pathname + location.search);
      } else if (location.pathname.replace(/\/$/, "") === "/auth/email/verify") {
        const stored = sessionStorage.getItem("deskfleet-email-verify-token");
        if (stored) {
          cachedFragmentToken = stored;
          sessionStorage.removeItem("deskfleet-email-verify-token");
        }
      }
    } catch (_) {}
  })();

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- Browser Staged Local Files ---
  const stagedFiles = new Map(); // virtualPath -> Uint8Array
  let wakeLockSentinel = null;
  let lastCopiedText = "";

  // --- Browser WebRTC Peer Registry ---
  let nextPeerId = 1;
  const peers = new Map();

  function attachChannelHandlers(entry, dc) {
    const label = dc.label;
    dc.binaryType = "arraybuffer";
    entry.channels.set(label, dc);
    const pushEvent = (ev) => {
      entry.events.push(ev);
      if (entry.waiters.length > 0) {
        const resolve = entry.waiters.shift();
        resolve(JSON.stringify(entry.events.shift()));
      }
    };
    if (dc.readyState === "open") {
      pushEvent({ type: "dataChannelOpen", label });
    } else {
      dc.onopen = () => pushEvent({ type: "dataChannelOpen", label });
    }
    dc.onclose = () => pushEvent({ type: "dataChannelClosed", label });
    dc.onerror = (e) => pushEvent({ type: "error", message: (e && e.message) || "DataChannel error" });
    dc.onmessage = (msg) => {
      if (typeof msg.data === "string") {
        const enc = new TextEncoder().encode(msg.data);
        pushEvent({ type: "data", label, isString: true, dataBase64: bytesToBase64(enc) });
      } else if (msg.data instanceof ArrayBuffer) {
        pushEvent({ type: "data", label, isString: false, dataBase64: bytesToBase64(new Uint8Array(msg.data)) });
      } else if (msg.data && typeof msg.data.arrayBuffer === "function") {
        msg.data.arrayBuffer().then((buf) => {
          pushEvent({ type: "data", label, isString: false, dataBase64: bytesToBase64(new Uint8Array(buf)) });
        });
      }
    };
  }

  function setupVideoCapture(entry, stream) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const captureFrame = () => {
      if (entry.closed) return;
      const w = video.videoWidth | 0;
      const h = video.videoHeight | 0;
      if (w > 0 && h > 0 && ctx) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const rgba = img.data;
        const bgra = new Uint8Array(rgba.length);
        for (let i = 0; i < rgba.length; i += 4) {
          bgra[i] = rgba[i + 2];
          bgra[i + 1] = rgba[i + 1];
          bgra[i + 2] = rgba[i];
          bgra[i + 3] = 255;
        }
        entry.frameSeq += 1;
        entry.latestFrame = {
          seq: entry.frameSeq,
          width: w,
          height: h,
          bgraBase64: bytesToBase64(bgra),
        };
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(captureFrame);
      }
    };
    video.play().catch(() => {});
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(captureFrame);
    } else {
      entry.videoTimer = setInterval(captureFrame, 33);
    }
    entry.videoEl = video;
  }

  globalThis.__deskfleetWebHost = {
    serverOrigin() {
      if (typeof globalThis.__DESKFLEET_SERVER_URL__ === "string" && globalThis.__DESKFLEET_SERVER_URL__) {
        return globalThis.__DESKFLEET_SERVER_URL__;
      }
      return location.origin;
    },
    hostname() {
      return location.hostname || "localhost";
    },
    userAgent() {
      return navigator.userAgent || "Browser";
    },
    currentPath() {
      return location.pathname || "/";
    },
    queryParam(name) {
      return new URLSearchParams(location.search).get(name) || "";
    },
    consumeFragmentToken() {
      const tok = cachedFragmentToken || "";
      cachedFragmentToken = null;
      return tok;
    },
    navigate(path) {
      location.assign(path);
    },
    openUrl(url) {
      if (url.startsWith("/") || url.startsWith(location.origin)) {
        location.assign(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    storageGet(key) {
      try {
        const v = localStorage.getItem("deskfleet:" + key);
        return v === null ? "" : v;
      } catch (_) {
        return "";
      }
    },
    storageSet(key, value) {
      try {
        localStorage.setItem("deskfleet:" + key, value);
      } catch (_) {}
    },
    copyText(text) {
      lastCopiedText = text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    },
    readClipboardCached() {
      return lastCopiedText;
    },
    setKeepAwake(enabled) {
      if (!navigator.wakeLock) return;
      if (enabled && !wakeLockSentinel) {
        navigator.wakeLock.request("screen").then((s) => { wakeLockSentinel = s; }).catch(() => {});
      } else if (!enabled && wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
      }
    },
    notify(title, body) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((p) => {
          if (p === "granted") new Notification(title, { body });
        });
      }
    },

    // --- WebAuthn Passkeys ---
    passkeysAvailable() {
      return typeof PublicKeyCredential !== "undefined" &&
        typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function";
    },
    async authenticatePasskeyJson(publicKeyJson) {
      const opts = JSON.parse(publicKeyJson);
      const cred = await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts),
      });
      if (!cred) throw new Error("Passkey authentication was cancelled");
      return JSON.stringify(cred.toJSON());
    },
    async registerPasskeyJson(publicKeyJson) {
      const opts = JSON.parse(publicKeyJson);
      const cred = await navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts),
      });
      if (!cred) throw new Error("Passkey registration was cancelled");
      return JSON.stringify(cred.toJSON());
    },

    // --- Browser Local Files & Downloads ---
    listLocalFilesJson() {
      const entries = [];
      for (const [path, bytes] of stagedFiles.entries()) {
        const name = path.split("/").pop() || path;
        entries.push({
          name,
          path,
          kind: "file",
          size: bytes.byteLength,
          modifiedMs: Date.now(),
        });
      }
      return JSON.stringify({
        path: "/browser-staged",
        parent: null,
        roots: ["/browser-staged"],
        entries,
      });
    },
    readLocalFileBase64(path) {
      const bytes = stagedFiles.get(path);
      if (!bytes) return "";
      return bytesToBase64(bytes);
    },
    saveDownloadBase64(fileName, b64) {
      const bytes = base64ToBytes(b64);
      const safePath = "/browser-staged/" + fileName;
      stagedFiles.set(safePath, bytes);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return safePath;
    },

    // --- Browser Native WebRTC ---
    rtcCreatePeer(configJson) {
      const cfg = JSON.parse(configJson || "{}");
      const iceServers = (cfg.iceServers || []).map((s) => {
        const item = { urls: s.urls };
        if (s.username) item.username = s.username;
        if (s.credential) item.credential = s.credential;
        return item;
      });
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: cfg.relayOnly ? "relay" : "all",
      });
      const id = nextPeerId++;
      const entry = {
        id,
        pc,
        channels: new Map(),
        events: [],
        waiters: [],
        closed: false,
        frameSeq: 0,
        latestFrame: null,
        videoEl: null,
        videoTimer: null,
      };
      const pushEvent = (ev) => {
        if (entry.closed && ev.type !== "closed") return;
        entry.events.push(ev);
        if (entry.waiters.length > 0) {
          const resolve = entry.waiters.shift();
          resolve(JSON.stringify(entry.events.shift()));
        }
      };
      if (cfg.videoCodec) {
        pc.addTransceiver("video", { direction: "recvonly" });
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          pushEvent({
            type: "iceCandidate",
            candidate: {
              candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid || null,
              sdpMLineIndex: typeof e.candidate.sdpMLineIndex === "number" ? e.candidate.sdpMLineIndex : null,
              usernameFragment: e.candidate.usernameFragment || null,
            },
          });
        } else {
          pushEvent({ type: "iceCandidate", candidate: null });
        }
      };
      pc.onconnectionstatechange = () => {
        pushEvent({ type: "stateChanged", state: pc.connectionState || "unknown" });
      };
      pc.ondatachannel = (e) => {
        if (e.channel) attachChannelHandlers(entry, e.channel);
      };
      pc.ontrack = (e) => {
        const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        setupVideoCapture(entry, stream);
      };
      peers.set(id, entry);
      return id;
    },
    rtcCreateDataChannel(id, label) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      const opts = label === "deskfleet-input" ? { ordered: false, maxRetransmits: 0 } : { ordered: true };
      const dc = entry.pc.createDataChannel(label, opts);
      attachChannelHandlers(entry, dc);
    },
    async rtcCreateOffer(id) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      return entry.pc.localDescription ? entry.pc.localDescription.sdp : offer.sdp;
    },
    async rtcAnswerOffer(id, offerSdp) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      await entry.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      return entry.pc.localDescription ? entry.pc.localDescription.sdp : answer.sdp;
    },
    async rtcAcceptAnswer(id, answerSdp) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      await entry.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return "ok";
    },
    async rtcAddIceCandidate(id, candidateJson) {
      const entry = peers.get(id);
      if (!entry) return "closed";
      const c = JSON.parse(candidateJson);
      await entry.pc.addIceCandidate(c);
      return "ok";
    },
    rtcSendBase64(id, label, dataBase64) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      const dc = entry.channels.get(label);
      if (!dc || dc.readyState !== "open") throw new Error("DataChannel not open: " + label);
      dc.send(base64ToBytes(dataBase64));
    },
    rtcSendText(id, label, text) {
      const entry = peers.get(id);
      if (!entry) throw new Error("Unknown WebRTC peer");
      const dc = entry.channels.get(label);
      if (!dc || dc.readyState !== "open") throw new Error("DataChannel not open: " + label);
      dc.send(text);
    },
    rtcPollEventJson(id, timeoutMs) {
      const entry = peers.get(id);
      if (!entry) return Promise.resolve(JSON.stringify({ type: "closed" }));
      if (entry.events.length > 0) {
        return Promise.resolve(JSON.stringify(entry.events.shift()));
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = entry.waiters.indexOf(onReady);
          if (idx >= 0) entry.waiters.splice(idx, 1);
          resolve("");
        }, Math.max(20, timeoutMs || 250));
        function onReady(payload) {
          clearTimeout(timer);
          resolve(payload);
        }
        entry.waiters.push(onReady);
      });
    },
    rtcPollVideoFrameJson(id, afterSeq) {
      const entry = peers.get(id);
      if (!entry || !entry.latestFrame || entry.latestFrame.seq <= afterSeq) return "";
      return JSON.stringify(entry.latestFrame);
    },
    rtcClose(id) {
      const entry = peers.get(id);
      if (!entry) return;
      entry.closed = true;
      if (entry.videoTimer) clearInterval(entry.videoTimer);
      if (entry.videoEl) entry.videoEl.srcObject = null;
      for (const dc of entry.channels.values()) {
        try { dc.close(); } catch (_) {}
      }
      try { entry.pc.close(); } catch (_) {}
      while (entry.waiters.length > 0) {
        const resolve = entry.waiters.shift();
        resolve(JSON.stringify({ type: "closed" }));
      }
      peers.delete(id);
    },
    async rtcProbeNatJson(server) {
      const started = Date.now();
      const normalized = server.startsWith("stun:") || server.startsWith("turn:") ? server : ("stun:" + server);
      const pc = new RTCPeerConnection({ iceServers: [{ urls: [normalized] }] });
      pc.createDataChannel("probe");
      let srflx = null;
      let host = null;
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3500);
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          const line = e.candidate.candidate || "";
          if (line.includes(" typ srflx ")) srflx = line;
          if (line.includes(" typ host ")) host = line;
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve());
      });
      try { pc.close(); } catch (_) {}
      return JSON.stringify({
        server: normalized,
        outcome: srflx ? "complete" : "udpBlocked",
        mappedAddress: srflx,
        localAddress: host,
        mappingBehavior: srflx ? "endpointIndependent" : "unknown",
        filteringBehavior: "unknown",
        durationMs: Date.now() - started,
      });
    },
  };
})();
