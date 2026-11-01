(function (root) {
  const MSE_VIDEO_CODECS = [
    'avc1.640029',
    'avc1.64002A',
    'avc1.640033',
    'hvc1.1.6.L153.B0',
  ];
  const MSE_AUDIO_CODECS = [
    'mp4a.40.2',
    'mp4a.40.5',
    'flac',
  ];
  const MSE_CODECS = [...MSE_VIDEO_CODECS, ...MSE_AUDIO_CODECS];
  const WEBRTC_CONNECT_TIMEOUT = 8000;
  const WEBRTC_TRACK_TIMEOUT = 12000;
  const WEBRTC_FRAME_TIMEOUT = 15000;
  const WEBRTC_PRIMARY_CONNECT_TIMEOUT = 4500;
  const WEBRTC_PRIMARY_TRACK_TIMEOUT = 6000;
  const MSE_STARTUP_TIMEOUT = 8000;
  const MSE_FRAME_TIMEOUT = 12000;
  const HLS_STARTUP_TIMEOUT = 12000;
  // Keep only a few frames of MSE runway. The old one-second target made a
  // healthy stream sit a full second behind the camera before network and
  // decode latency were added.
  const MSE_LIVE_TARGET = 0.35;
  const MSE_LIVE_MAX = 1.2;
  const MSE_LIVE_CHECK_INTERVAL = 250;
  const MSE_LIVE_TRIM_INTERVAL = 2000;
  const MSE_LIVE_RETAIN_BEHIND = 0.75;
  const WEBRTC_STATS_INTERVAL = 1000;
  const WEBRTC_STALE_BUFFER_MAX = 0.35;
  const WEBRTC_STALE_BUFFER_CHECKS = 2;
  const WEBRTC_DECODE_STALL_CHECKS = 3;
  const WEBRTC_PACKET_STALL_CHECKS = 3;
  const WEBRTC_HARD_STALL_WINDOW = 25000;
  const WEBRTC_RESUME_RECONNECT_AFTER = 1000;
  const WEBRTC_BACKGROUND_REBUILD_AFTER = 1500;
  const WEBRTC_LIVE_AFTER_PAUSE_MS = 1200;
  const audioControllers = new WeakMap();

  function supportedMseTypes(MediaSourceClass, videoOnly = false) {
    if (!MediaSourceClass?.isTypeSupported) return '';
    return (videoOnly ? MSE_VIDEO_CODECS : MSE_CODECS)
      .filter((codec) => MediaSourceClass.isTypeSupported(`video/mp4; codecs="${codec}"`))
      .join(',');
  }

  function runPlayback(video, onError, onSuccess) {
    const result = video.play();
    if (result?.then) {
      result.then(() => onSuccess?.(), (error) => onError?.(String(error)));
    }
    return result;
  }

  function play(video, stream, options = {}) {
    const notify = (mode, detail = '') => {
      try {
        options.onMode?.(mode, detail);
      } catch (_) {}
    };
    const failed = (mode, error) => {
      try {
        options.onError?.(mode, error);
      } catch (_) {}
    };
    const diagnostics = (mode, detail) => {
      try {
        options.onDiagnostics?.(mode, detail);
      } catch (_) {}
    };
    const endpoint = (isFallback = false) => (
      isFallback ? 'h264' : (stream.video_codec || 'native')
    );

    let disposed = false;
    let cleanupTransport = null;
    let transportIndex = -1;
    let activeWebrtcUrl = stream.webrtc_url || '';
    let usingFallbackWebrtc = false;
    const transports = stream.prefer_mse
      ? ['mse', 'webrtc', 'hls']
      : ['webrtc', 'mse', 'hls'];

    const resetVideo = () => {
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      // MSE temporarily speeds playback up to catch the live edge. Do not let
      // that rate leak into WebRTC, where it would also pitch-shift the audio.
      video.playbackRate = 1;
      video.load();
    };

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      cleanupTransport?.();
      cleanupTransport = null;
      audioController?.cleanup();
      audioController = null;
      audioControllers.delete(video);
      resetVideo();
    };

    let advance;

    const startHls = (reason = '') => {
      if (disposed) return;
      resetVideo();
      let closed = false;
      let startupTimer = 0;
      const onError = () => {
        if (!closed && !disposed) failed('hls', 'video element error');
      };
      const onFrame = () => {
        if (!closed && video.videoWidth) clearTimeout(startupTimer);
      };
      const stop = () => {
        closed = true;
        clearTimeout(startupTimer);
        video.removeEventListener('error', onError);
        video.removeEventListener('loadeddata', onFrame);
      };
      cleanupTransport = stop;
      video.addEventListener('error', onError, { once: true });
      video.addEventListener('loadeddata', onFrame);
      video.src = stream.url;
      video.load();
      runPlayback(video);
      notify('hls', reason);
      startupTimer = setTimeout(() => {
        if (!closed && !video.videoWidth) {
          failed('hls', 'hls first frame timeout');
          stop();
        }
      }, HLS_STARTUP_TIMEOUT);
    };

    const startMse = (reason = '') => {
      if (disposed) return;
      resetVideo();
      const MediaSourceClass = root.ManagedMediaSource || root.MediaSource;
      const codecs = supportedMseTypes(MediaSourceClass, stream.video_only);
      const mseUrl = stream.mse_webrtc_url || stream.webrtc_url;
      if (!MediaSourceClass || !codecs || !mseUrl || !root.WebSocket) {
        advance(reason || 'mse unsupported');
        return;
      }

      const ws = new WebSocket(mseUrl);
      ws.binaryType = 'arraybuffer';
      const mediaSource = new MediaSourceClass();
      const objectUrl = root.ManagedMediaSource ? '' : root.URL.createObjectURL(mediaSource);
      let sourceBuffer = null;
      let sourceOpen = false;
      let closed = false;
      let opened = false;
      let failedOnce = false;
      let startupTimer = 0;
      let frameTimer = 0;
      let sourcePoll = 0;
      let liveTimer = 0;
      let visibleTimer = 0;
      let lastTrimAt = 0;
      const pending = [];
      let pendingBytes = 0;

      const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(startupTimer);
        clearTimeout(frameTimer);
        clearTimeout(sourcePoll);
        clearTimeout(liveTimer);
        clearTimeout(visibleTimer);
        root.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
        root.removeEventListener?.('focus', onWindowFocus);
        try { ws.close(); } catch (_) {}
        if (objectUrl) root.URL.revokeObjectURL(objectUrl);
      };
      cleanupTransport = stop;

      const fail = (detail) => {
        if (closed || disposed || failedOnce) return;
        failedOnce = true;
        failed('mse', detail);
        advance(detail);
      };

      const appendNext = () => {
        if (closed || !sourceBuffer || sourceBuffer.updating || !pending.length) return;
        const chunk = pending.shift();
        pendingBytes -= chunk.byteLength;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch (error) {
          fail(`mse append failed: ${error}`);
        }
      };

      const maintainLiveWindow = () => {
        if (closed || !sourceBuffer?.buffered?.length) return;
        const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
        const start = sourceBuffer.buffered.start(0);
        if (video.currentTime < start || video.currentTime === 0) {
          video.currentTime = Math.max(start, end - 0.08);
        }
        const gap = end - video.currentTime;
        if (gap > MSE_LIVE_MAX) {
          video.currentTime = Math.max(start, end - 0.08);
          video.playbackRate = 1;
        } else if (gap > 0.7) {
          video.playbackRate = 1.35;
        } else if (gap > 0.45) {
          video.playbackRate = 1.15;
        } else if (gap > 0.28) {
          video.playbackRate = 1.04;
        } else {
          video.playbackRate = 1;
        }
        // Remove old media only behind the playback head. Removing everything
        // except the last 0.35s makes WebKit repeatedly invalidate the frame it
        // is decoding, which looks like a frozen stream even though data keeps
        // arriving.
        const keepBefore = Math.max(start, video.currentTime - MSE_LIVE_RETAIN_BEHIND);
        const now = Date.now();
        if (
          keepBefore - start > MSE_LIVE_RETAIN_BEHIND
          && now - lastTrimAt >= MSE_LIVE_TRIM_INTERVAL
        ) {
          lastTrimAt = now;
          try {
            sourceBuffer.remove(start, keepBefore);
          } catch (_) {}
        }
        if ('setLiveSeekableRange' in mediaSource && end > start) {
          try { mediaSource.setLiveSeekableRange(start, end); } catch (_) {}
        }
        runPlayback(video);
      };

      const jumpToLive = (reason, force = false) => {
        if (closed || !sourceBuffer?.buffered?.length) return;
        const start = sourceBuffer.buffered.start(0);
        const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
        const before = video.currentTime;
        const gap = end - before;
        if (!force && gap <= MSE_LIVE_MAX) return;
        const target = Math.max(before, start, end - MSE_LIVE_TARGET);
        try {
          video.currentTime = target;
          video.playbackRate = 1;
        } catch (_) {}
        diagnostics('mse-live-edge', {
          reason,
          before,
          target,
          start,
          end,
          gap,
        });
        runPlayback(video);
      };

      const scheduleLiveCheck = () => {
        if (closed) return;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
          if (closed) return;
          maintainLiveWindow();
          scheduleLiveCheck();
        }, MSE_LIVE_CHECK_INTERVAL);
      };

      const kickToLive = (reason) => {
        if (closed) return;
        clearTimeout(visibleTimer);
        jumpToLive(reason, true);
        // WebKit can resume the media clock a few frames after visibility
        // becomes visible. Re-check after the renderer and WS have resumed.
        visibleTimer = setTimeout(() => {
          jumpToLive(`${reason}+resume`, true);
          maintainLiveWindow();
        }, 350);
      };

      const onVisibilityChange = () => {
        if (!root.document?.hidden) kickToLive('visible');
      };
      const onWindowFocus = () => kickToLive('focus');
      root.document?.addEventListener?.('visibilitychange', onVisibilityChange);
      root.addEventListener?.('focus', onWindowFocus);

      const sendCodecs = () => {
        if (closed || !sourceOpen || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'mse', value: codecs }));
      };

      const markSourceOpen = () => {
        if (closed) return;
        sourceOpen = true;
        sendCodecs();
        runPlayback(video);
      };
      const pollSourceOpen = () => {
        if (closed || sourceOpen) return;
        if (mediaSource.readyState === 'open') {
          markSourceOpen();
        } else {
          sourcePoll = setTimeout(pollSourceOpen, 100);
        }
      };
      mediaSource.addEventListener('sourceopen', markSourceOpen, { once: true });
      mediaSource.addEventListener('sourceclose', () => {
        if (opened) fail('mse source closed');
      }, { once: true });

      if (root.ManagedMediaSource) {
        video.disableRemotePlayback = true;
        video.srcObject = mediaSource;
      } else {
        video.src = objectUrl;
        video.load();
      }
      runPlayback(video);
      pollSourceOpen();
      scheduleLiveCheck();

      ws.addEventListener('open', sendCodecs);
      ws.addEventListener('message', (event) => {
        if (closed) return;
        if (typeof event.data === 'string') {
          let message;
          try { message = JSON.parse(event.data); } catch (_) { return; }
          if (message.type === 'error') {
            fail(`mse rejected: ${message.value || 'unknown error'}`);
            return;
          }
          if (message.type !== 'mse' || sourceBuffer) return;
          if (!sourceOpen || mediaSource.readyState !== 'open') {
            fail('mse source is not open');
            return;
          }
          try {
            sourceBuffer = mediaSource.addSourceBuffer(message.value);
            sourceBuffer.mode = 'segments';
            sourceBuffer.addEventListener('updateend', () => {
              if (closed) return;
              appendNext();
            });
            sourceBuffer.addEventListener('error', () => fail('mse source buffer error'));
            opened = true;
            clearTimeout(startupTimer);
            notify('mse', message.value);
            runPlayback(video);
          } catch (error) {
            fail(`mse unsupported: ${error}`);
          }
          return;
        }
        if (!sourceBuffer || !event.data?.byteLength) return;
        const chunk = event.data;
        if (pendingBytes + chunk.byteLength > 24 * 1024 * 1024) {
          fail('mse buffer overflow');
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        appendNext();
      });
      // WebKit's error event carries no status; the following close event does.
      ws.addEventListener('error', () => {});
      ws.addEventListener('close', (event) => {
        if (!closed) {
          fail(
            `${opened ? 'mse websocket closed' : 'mse websocket closed before media'}`
            + ` (code=${event.code}, clean=${event.wasClean}, reason=${event.reason || '-'})`,
          );
        }
      });
      startupTimer = setTimeout(() => {
        if (!opened) fail('mse startup timeout');
      }, MSE_STARTUP_TIMEOUT);
      frameTimer = setTimeout(() => {
        if (!video.videoWidth) fail('mse frame timeout');
      }, MSE_FRAME_TIMEOUT);
    };

    let audioController = null;
    let audioEnabled = false;
    let lastPacketStallAt = 0;
    let hardStallRequested = false;

    const requestHardStall = (detail) => {
      if (hardStallRequested || disposed) return;
      hardStallRequested = true;
      diagnostics('webrtc', { reason: 'hard-stall', detail });
      try {
        options.onStall?.('webrtc', detail);
      } catch (_) {}
    };

    const ensureAudioController = () => {
      if (audioController || !stream.audio_webrtc_url) return audioController;
      if (!root.RTCPeerConnection || !root.WebSocket || !root.Audio) return null;

      const audioUrl = stream.audio_webrtc_url;
      const audio = new root.Audio();
      const ws = new WebSocket(audioUrl);
      const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [] });
      const earlyCandidates = [];
      const element = audio;
      let closed = false;
      let remoteSet = false;
      let lastError = '';
      let connectTimer = 0;
      let trackTimer = 0;
      let statsTimer = 0;
      let audioSignalReported = false;

      element.autoplay = false;
      element.muted = true;
      element.volume = 1;
      element.preload = 'auto';

      const reportAudio = (reason, detail = {}) => {
        diagnostics('audio', {
          reason,
          enabled: audioEnabled,
          muted: element.muted,
          paused: element.paused,
          readyState: element.readyState,
          lastError,
          ...detail,
        });
      };

      const playAudio = (restartOutput = false) => {
        if (closed || !audioEnabled || !element.srcObject) return;
        element.muted = false;
        element.volume = 1;
        const shouldStart = restartOutput || element.paused;
        if (!shouldStart) return;
        // Calling pause()+play() on an already-playing element aborts the
        // pending play promise and can clip the first audio packets. Only
        // restart when the renderer actually needs to be reattached.
        if (restartOutput && !element.paused) element.pause();
        const result = element.play();
        if (result?.then) {
          result.then(
            () => {
              lastError = '';
              reportAudio('playing');
            },
            (error) => {
              lastError = String(error);
              reportAudio('play rejected', { error: lastError });
            },
          );
        }
      };

      const reportAudioStats = async (reason) => {
        if (closed || pc.connectionState !== 'connected') return;
        const inbound = {};
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type !== 'inbound-rtp') return;
            const kind = report.kind || report.mediaType || 'audio';
            inbound[kind] = {
              bytes: report.bytesReceived || 0,
              packets: report.packetsReceived || 0,
              packetsLost: report.packetsLost || 0,
              jitter: report.jitter,
              audioLevel: report.audioLevel,
              totalAudioEnergy: report.totalAudioEnergy,
              totalSamplesDuration: report.totalSamplesDuration,
              concealedSamples: report.concealedSamples,
              silentConcealedSamples: report.silentConcealedSamples,
              jitterBufferDelay: report.jitterBufferDelay,
              jitterBufferEmittedCount: report.jitterBufferEmittedCount,
            };
          });
        } catch (error) {
          lastError = String(error);
        }
        diagnostics('audio-stats', {
          reason,
          state: pc.connectionState,
          enabled: audioEnabled,
          muted: element.muted,
          paused: element.paused,
          readyState: element.readyState,
          inbound,
          lastError,
        });
        const audioStats = inbound.audio || Object.values(inbound)[0];
        if (!audioSignalReported && audioStats && (
          Number(audioStats.bytes) > 0
          || Number(audioStats.packets) > 0
          || Number(audioStats.totalAudioEnergy) > 0
        )) {
          audioSignalReported = true;
          reportAudio('signal', { inbound });
        }
      };

      const scheduleAudioStats = () => {
        if (closed) return;
        clearTimeout(statsTimer);
        statsTimer = setTimeout(async () => {
          await reportAudioStats('periodic');
          scheduleAudioStats();
        }, 5000);
      };

      const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearTimeout(trackTimer);
        clearTimeout(statsTimer);
        element.pause();
        element.srcObject = null;
        try { ws.close(); } catch (_) {}
        try { pc.close(); } catch (_) {}
        if (audioController?.cleanup === stop) audioController = null;
        audioControllers.delete(video);
      };

      const fail = (detail) => {
        lastError = detail;
        reportAudio('failed', { error: detail });
        stop();
      };

      pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: 'webrtc/candidate',
          value: event.candidate.candidate,
        }));
      });
      pc.addEventListener('track', (event) => {
        if (event.track.kind !== 'audio') return;
        clearTimeout(trackTimer);
        element.srcObject = new MediaStream([event.track]);
        event.track.addEventListener('unmute', () => playAudio());
        reportAudio('track');
        playAudio(true);
      });
      pc.addEventListener('connectionstatechange', () => {
        if (closed) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(connectTimer);
          for (const receiver of pc.getReceivers()) {
            try { receiver.jitterBufferTarget = 0; } catch (_) {}
            try { receiver.playoutDelayHint = 0; } catch (_) {}
          }
          reportAudio('connected');
          reportAudioStats('connected');
          scheduleAudioStats();
        } else if (pc.connectionState === 'failed') {
          fail('audio webrtc connection failed');
        }
      });
      ws.addEventListener('message', async (event) => {
        if (closed || typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'webrtc/candidate') {
          const candidate = {
            candidate: message.value,
            sdpMid: message.sdpMid ?? '0',
            sdpMLineIndex: message.sdpMLineIndex ?? 0,
          };
          if (remoteSet) {
            pc.addIceCandidate(candidate).catch(() => {});
          } else {
            earlyCandidates.push(candidate);
          }
          return;
        }
        if (message.type === 'webrtc/answer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: message.value });
            remoteSet = true;
            for (const candidate of earlyCandidates.splice(0)) {
              pc.addIceCandidate(candidate).catch(() => {});
            }
          } catch (error) {
            fail(`audio answer failed: ${error}`);
          }
          return;
        }
        if (message.type === 'error') fail(message.value || 'audio webrtc rejected');
      });
      ws.addEventListener('open', async () => {
        if (closed) return;
        pc.addTransceiver('audio', { direction: 'recvonly' });
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'webrtc/offer', value: pc.localDescription.sdp }));
        } catch (error) {
          fail(`audio offer failed: ${error}`);
        }
      });
      ws.addEventListener('error', () => {});
      ws.addEventListener('close', (event) => {
        if (!closed) {
          fail(`audio websocket closed (code=${event.code}, reason=${event.reason || '-'})`);
        }
      });
      connectTimer = setTimeout(() => {
        if (pc.connectionState !== 'connected') {
          fail(`audio connect timeout (state=${pc.connectionState})`);
        }
      }, WEBRTC_CONNECT_TIMEOUT);
      trackTimer = setTimeout(() => {
        if (!element.srcObject) fail('audio track timeout');
      }, WEBRTC_TRACK_TIMEOUT);

      audioController = {
        cleanup: stop,
        setEnabled(enabled) {
          audioEnabled = enabled;
          reportAudio(enabled ? 'enabled' : 'disabled');
          if (enabled) reportAudioStats('enabled');
          if (enabled) {
            playAudio();
          } else {
            element.pause();
            element.muted = true;
            reportAudio('muted');
          }
        },
      };
      return audioController;
    };

    const setSeparateAudio = (enabled) => {
      audioEnabled = enabled;
      if (!stream.audio_webrtc_url) return false;
      // The video element stays muted: the independent audio PeerConnection
      // owns playback and cannot stall video with an A/V mux timeline.
      video.muted = true;
      video.volume = 1;
      if (!enabled) {
        audioController?.setEnabled(false);
        return true;
      }
      const controller = ensureAudioController();
      if (!controller) return false;
      controller.setEnabled(true);
      return true;
    };

    const startWebrtc = (reason = '', requestedUrl = activeWebrtcUrl, fallback = false) => {
      if (disposed) return;
      if (!root.RTCPeerConnection || !requestedUrl || !root.WebSocket) {
        advance(reason || 'webrtc unsupported');
        return;
      }

      activeWebrtcUrl = requestedUrl;
      usingFallbackWebrtc = fallback;
      const primaryWithFallback = !usingFallbackWebrtc
        && Boolean(stream.fallback_webrtc_url || stream.mse_webrtc_url);
      resetVideo();
      const ws = new WebSocket(requestedUrl);
      const pc = new RTCPeerConnection({
        bundlePolicy: 'max-bundle',
        iceServers: [],
      });
      const tracks = new Map();
      const earlyCandidates = [];
      let closed = false;
      let connected = false;
      let remoteSet = false;
      let videoTrack = null;
      let failedOnce = false;
      let connectTimer = 0;
      let trackTimer = 0;
      let frameTimer = 0;
      let disconnectTimer = 0;
      let statsTimer = 0;
      let resumeTimer = 0;
      let resumeProbeTimer = 0;
      let loadedDataHandler = null;
      let volumeChangeHandler = null;
      let lastPlaybackError = '';
      let audioTrack = null;
      let hiddenAt = 0;
      let blurredAt = 0;
      let pausedAt = 0;
      let codecsSignature = '';
      let staleBufferChecks = 0;
      let decodeStallChecks = 0;
      let packetStallChecks = 0;
      let lastVideoProgress = null;
      let restartWebrtc = () => {};

      const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearTimeout(trackTimer);
        clearTimeout(frameTimer);
        clearTimeout(disconnectTimer);
        clearTimeout(statsTimer);
        clearTimeout(resumeTimer);
        clearTimeout(resumeProbeTimer);
        root.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
        root.removeEventListener?.('focus', onWindowFocus);
        root.removeEventListener?.('blur', onWindowBlur);
        video.removeEventListener?.('pause', onVideoPause);
        video.removeEventListener?.('play', onVideoPlay);
        if (loadedDataHandler) {
          video.removeEventListener('loadeddata', loadedDataHandler);
          loadedDataHandler = null;
        }
        if (volumeChangeHandler) {
          video.removeEventListener('volumechange', volumeChangeHandler);
          volumeChangeHandler = null;
        }
        try { ws.close(); } catch (_) {}
        try { pc.close(); } catch (_) {}
        tracks.forEach((track) => track.stop());
      };
      cleanupTransport = stop;

      const fail = (detail) => {
        if (closed || disposed || failedOnce) return;
        if (!usingFallbackWebrtc && stream.fallback_webrtc_url) {
          diagnostics('webrtc', {
            reason: 'fallback',
            detail,
            endpoint: endpoint(true),
          });
          stop();
          startWebrtc('h264-fallback', stream.fallback_webrtc_url, true);
          return;
        }
        failedOnce = true;
        failed('webrtc', detail);
        advance(detail);
      };

      const useTracks = (reason = 'tracks') => {
        if (closed || !videoTrack) return;
        const current = video.srcObject;
        const media = current instanceof MediaStream ? current : new MediaStream();
        let changed = current !== media;
        for (const track of tracks.values()) {
          const attached = media.getTracks().some((item) => item.id === track.id);
          // While muted, keep audio out of the media element entirely. Some
          // WebKit versions otherwise pace the video clock against the audio
          // track and accumulate several seconds of live latency.
          if (track.kind === 'audio' && video.muted) {
            if (attached) {
              media.removeTrack(track);
              changed = true;
            }
            continue;
          }
          if (attached) continue;
          media.addTrack(track);
          changed = true;
        }
        if (current !== media) video.srcObject = media;
        // WebKit may keep the audio renderer closed when the audio track
        // arrives after playback has started, or when a muted video becomes
        // audible. A pause/play cycle is required to attach the renderer.
        const restartAudio = reason.startsWith('audio-') && !video.muted;
        if (restartAudio && !video.paused) video.pause();
        if (changed || video.paused || restartAudio) {
          runPlayback(
            video,
            (error) => {
              lastPlaybackError = error;
              diagnostics('webrtc', { reason: 'play rejected', error });
            },
            () => { lastPlaybackError = ''; },
          );
        }
      };

      const reportMedia = async (reason) => {
        if (closed || !connected) return;
        const inbound = {};
        let staleVideoBuffer = false;
        let decodeStalled = false;
        let packetStalled = false;
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type !== 'inbound-rtp') return;
            const kind = report.kind || report.mediaType || 'unknown';
            const emitted = Number(report.jitterBufferEmittedCount) || 0;
            const jitterBufferAverage = kind === 'video' && emitted > 0
              ? (Number(report.jitterBufferDelay) || 0) / emitted
              : null;
            if (kind === 'video') {
              staleVideoBuffer = Boolean(
                jitterBufferAverage > WEBRTC_STALE_BUFFER_MAX
                && (Number(report.framesDecoded) || 0) > 30
              );
            }
            inbound[kind] = {
              bytes: report.bytesReceived || 0,
              packets: report.packetsReceived || 0,
              packetsLost: report.packetsLost || 0,
              jitter: report.jitter,
              audioLevel: report.audioLevel,
              totalAudioEnergy: report.totalAudioEnergy,
              totalSamplesDuration: report.totalSamplesDuration,
              frames: report.framesDecoded,
              framesDropped: report.framesDropped,
              freezeCount: report.freezeCount,
              totalFreezesDuration: report.totalFreezesDuration,
              jitterBufferDelay: report.jitterBufferDelay,
              jitterBufferEmittedCount: report.jitterBufferEmittedCount,
              jitterBufferAverage,
            };
          });
        } catch (_) {}
        const videoStats = inbound.video;
        if (videoStats && Number.isFinite(Number(videoStats.frames))) {
          const frames = Number(videoStats.frames) || 0;
          const packets = Number(videoStats.packets) || 0;
          const now = Date.now();
          if (lastVideoProgress && packets > 0 && !video.paused && !root.document?.hidden) {
            if (packets <= lastVideoProgress.packets) {
              packetStallChecks += 1;
            } else {
              packetStallChecks = 0;
            }
          } else if (video.paused || root.document?.hidden) {
            packetStallChecks = 0;
          }
          if (lastVideoProgress && frames > 0
            && !video.paused
            && !root.document?.hidden
            && packets > lastVideoProgress.packets
            && frames <= lastVideoProgress.frames) {
            decodeStallChecks += 1;
          } else if (!lastVideoProgress || frames > lastVideoProgress.frames) {
            decodeStallChecks = 0;
          } else if (video.paused || root.document?.hidden) {
            decodeStallChecks = 0;
          }
          decodeStalled = decodeStallChecks >= WEBRTC_DECODE_STALL_CHECKS;
          if (decodeStalled) {
            diagnostics('webrtc', {
              reason: 'decode-stall',
              framesBefore: lastVideoProgress?.frames,
              framesAfter: frames,
              packetsBefore: lastVideoProgress?.packets,
              packetsAfter: packets,
              stalledChecks: decodeStallChecks,
            });
          }
          packetStalled = packetStallChecks >= WEBRTC_PACKET_STALL_CHECKS;
          if (packetStalled) {
            diagnostics('webrtc', {
              reason: 'packet-stall',
              frames: lastVideoProgress?.frames,
              packets: lastVideoProgress?.packets,
              stalledChecks: packetStallChecks,
              state: pc.connectionState,
            });
          }
          lastVideoProgress = { frames, packets, at: now };
        } else {
          decodeStallChecks = 0;
          packetStallChecks = 0;
          lastVideoProgress = null;
        }
        const codecs = [];
        try {
          for (const receiver of pc.getReceivers()) {
            codecs.push({
              kind: receiver.track.kind,
              codecs: receiver.getParameters().codecs?.map((codec) => ({
                mimeType: codec.mimeType,
                clockRate: codec.clockRate,
                channels: codec.channels,
              })),
            });
          }
        } catch (_) {}
        const remoteAudioCodecs = String(pc.remoteDescription?.sdp || '')
          .split(/\r?\n/)
          .filter((line) => /^a=rtpmap:\d+\s+/i.test(line))
          .map((line) => line.replace(/^a=rtpmap:\d+\s+/i, ''))
          .filter((line) => /opus|pcmu|pcma|g722|telephone-event/i.test(line));
        const nextCodecsSignature = JSON.stringify({ codecs, remoteAudioCodecs });
        const includeCodecs = nextCodecsSignature !== codecsSignature;
        if (includeCodecs) codecsSignature = nextCodecsSignature;
        diagnostics('webrtc', {
          reason,
          endpoint: endpoint(usingFallbackWebrtc),
          videoCodec: stream.video_codec || 'native',
          videoOnly: Boolean(stream.video_only),
          muted: video.muted,
          volume: video.volume,
          paused: video.paused,
          readyState: video.readyState,
          networkState: video.networkState,
          mediaError: video.error?.message || '',
          lastPlaybackError,
          audioTrack: audioTrack && {
            muted: audioTrack.muted,
            enabled: audioTrack.enabled,
            readyState: audioTrack.readyState,
          },
          codecs: includeCodecs ? codecs : undefined,
          remoteAudioCodecs: includeCodecs ? remoteAudioCodecs : undefined,
          inbound,
        });
        if (closed || !connected) return;
        if (reason === 'periodic' && packetStalled) {
          const now = Date.now();
          if (lastPacketStallAt && now - lastPacketStallAt < WEBRTC_HARD_STALL_WINDOW) {
            requestHardStall('packet-stall');
          } else {
            lastPacketStallAt = now;
            restartWebrtc('packet-stall');
          }
          return;
        }
        if (reason === 'periodic' && decodeStalled) {
          restartWebrtc('decode-stall');
          return;
        }
        if (reason === 'periodic' && !root.document?.hidden && staleVideoBuffer) {
          staleBufferChecks += 1;
          if (staleBufferChecks >= WEBRTC_STALE_BUFFER_CHECKS) {
            restartWebrtc('jitter-buffer');
          }
        } else {
          staleBufferChecks = 0;
        }
      };

      const scheduleMediaStats = () => {
        if (closed) return;
        clearTimeout(statsTimer);
        statsTimer = setTimeout(async () => {
          if (!root.document?.hidden) await reportMedia('periodic');
          scheduleMediaStats();
        }, WEBRTC_STATS_INTERVAL);
      };

      const decodedFrames = () => {
        const quality = video.getVideoPlaybackQuality?.();
        const frames = quality?.totalVideoFrames ?? video.webkitDecodedFrameCount;
        return Number(frames) || 0;
      };

      const resumeLivePlayback = (reason) => {
        if (closed || disposed) return;
        clearTimeout(resumeTimer);
        clearTimeout(resumeProbeTimer);
        resumeTimer = setTimeout(() => {
          if (closed || disposed || root.document?.hidden) return;
          const beforeFrames = decodedFrames();
          const beforeTime = Number(video.currentTime) || 0;
          if (video.paused) {
            runPlayback(
              video,
              (error) => {
                lastPlaybackError = error;
                diagnostics('webrtc', { reason: 'resume rejected', error });
              },
              () => { lastPlaybackError = ''; },
            );
          }
          reportMedia('resume');

          // Most WebKit suspensions recover without touching the PeerConnection.
          // Give decoded progress a short window before paying for a full rebuild.
          resumeProbeTimer = setTimeout(() => {
            if (closed || disposed || root.document?.hidden) return;
            const frames = decodedFrames();
            const time = Number(video.currentTime) || 0;
            const progressed = video.videoWidth > 0
              && (frames > beforeFrames || time > beforeTime + 0.05);
            if (progressed) {
              diagnostics('webrtc', {
                reason: 'resume-live',
                detail: reason,
                framesBefore: beforeFrames,
                framesAfter: frames,
                timeBefore: beforeTime,
                timeAfter: time,
              });
              return;
            }
            diagnostics('webrtc', {
              reason: 'resume-stalled',
              detail: reason,
              framesBefore: beforeFrames,
              framesAfter: frames,
              timeBefore: beforeTime,
              timeAfter: time,
              state: pc.connectionState,
            });
            restartWebrtc(`${reason}-stalled`);
          }, 1400);
        }, 160);
      };
      const onVisibilityChange = () => {
        if (closed || disposed) return;
        if (root.document?.hidden) {
          hiddenAt = Date.now();
          staleBufferChecks = 0;
          decodeStallChecks = 0;
          packetStallChecks = 0;
          lastVideoProgress = null;
          clearTimeout(resumeTimer);
          clearTimeout(resumeProbeTimer);
          return;
        }
        const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = 0;
        if (hiddenFor >= WEBRTC_BACKGROUND_REBUILD_AFTER) {
          // WebKit may keep decoding while hidden but resume the renderer
          // behind the live edge. A progress probe cannot detect that skew, so
          // rebuild the live transport whenever the page was hidden long
          // enough to accumulate playback delay.
          restartWebrtc('visibility-resume');
        } else if (hiddenFor >= WEBRTC_RESUME_RECONNECT_AFTER) {
          resumeLivePlayback('visibility-resume');
        }
      };
      const onWindowFocus = () => {
        if (closed || disposed) return;
        const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
        const blurredFor = blurredAt ? Date.now() - blurredAt : 0;
        hiddenAt = 0;
        blurredAt = 0;
        if (hiddenFor >= WEBRTC_BACKGROUND_REBUILD_AFTER
          || blurredFor >= WEBRTC_BACKGROUND_REBUILD_AFTER) {
          // The app being covered by another window has the same WebKit
          // throttling behavior as document.hidden, but some WKWebView builds
          // do not emit visibilitychange for it.
          restartWebrtc('focus-resume');
        } else if (hiddenFor >= WEBRTC_RESUME_RECONNECT_AFTER
          || blurredFor >= WEBRTC_RESUME_RECONNECT_AFTER) {
          resumeLivePlayback('focus-resume');
        }
      };
      const onWindowBlur = () => {
        if (!closed && !disposed) blurredAt = Date.now();
      };
      const onVideoPause = () => {
        if (!closed && !disposed) pausedAt = Date.now();
      };
      const onVideoPlay = () => {
        if (closed || disposed) return;
        const pausedFor = pausedAt ? Date.now() - pausedAt : 0;
        pausedAt = 0;
        // WebRTC cannot seek a live MediaStream. Once playback resumes after a
        // real pause, rebuild it or the renderer stays permanently behind.
        if (pausedFor >= WEBRTC_LIVE_AFTER_PAUSE_MS) {
          restartWebrtc('resume-after-pause');
        }
      };
      root.document?.addEventListener?.('visibilitychange', onVisibilityChange);
      root.addEventListener?.('focus', onWindowFocus);
      root.addEventListener?.('blur', onWindowBlur);
      video.addEventListener?.('pause', onVideoPause);
      video.addEventListener?.('play', onVideoPlay);

      loadedDataHandler = () => {
        if (closed || !video.videoWidth) return;
        clearTimeout(frameTimer);
        // Keep the live media transport once decoded frames are observable.
        try { ws.close(); } catch (_) {}
      };
      volumeChangeHandler = () => {
        useTracks(video.muted ? 'audio-muted' : 'audio-unmuted');
        reportMedia('volumechange');
      };
      video.addEventListener('loadeddata', loadedDataHandler, { once: true });
      video.addEventListener('volumechange', volumeChangeHandler);

      restartWebrtc = (restartReason) => {
        if (closed || disposed) return;
        if (
          !usingFallbackWebrtc
          && stream.fallback_webrtc_url
          && /decode-stall|jitter-buffer/.test(restartReason)
        ) {
          diagnostics('webrtc', {
            reason: 'fallback',
            detail: restartReason,
            endpoint: endpoint(true),
          });
          stop();
          startWebrtc('h264-fallback', stream.fallback_webrtc_url, true);
          return;
        }
        diagnostics('webrtc', { reason: 'restart', detail: restartReason });
        stop();
        startWebrtc(restartReason, activeWebrtcUrl, usingFallbackWebrtc);
      };

      pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: 'webrtc/candidate',
          value: event.candidate.candidate,
        }));
      });
      pc.addEventListener('track', (event) => {
        tracks.set(event.track.kind, event.track);
        if (event.track.kind === 'video') {
          videoTrack = event.track;
          clearTimeout(trackTimer);
        } else if (event.track.kind === 'audio') {
          audioTrack = event.track;
        }
        event.track.addEventListener('unmute', () => useTracks('audio-unmuted'));
        for (const receiver of pc.getReceivers()) {
          // Apply the live-edge hints as soon as each receiver exists. Waiting
          // for connectionstatechange leaves WebKit's default jitter buffer in
          // place for the first seconds of playback.
          try { receiver.jitterBufferTarget = 0; } catch (_) {}
          try { receiver.playoutDelayHint = 0; } catch (_) {}
        }
        useTracks(
          event.track.kind === 'audio' && !event.track.muted
            ? 'audio-track-ready'
            : 'tracks',
        );
      });
      pc.addEventListener('connectionstatechange', () => {
        if (closed) return;
        if (pc.connectionState === 'connected') {
          connected = true;
          clearTimeout(connectTimer);
          clearTimeout(disconnectTimer);
          for (const receiver of pc.getReceivers()) {
            // These hints are not implemented by every WebKit release.
            try { receiver.jitterBufferTarget = 0; } catch (_) {}
            try { receiver.playoutDelayHint = 0; } catch (_) {}
          }
          notify(
            'webrtc',
            usingFallbackWebrtc
              ? 'connected (H.264 fallback)'
              : `connected (${endpoint()})`,
          );
          useTracks('connected');
          setTimeout(() => reportMedia('connected'), 3000);
          setTimeout(() => reportMedia('connected+7s'), 7000);
          setTimeout(() => reportMedia('connected+12s'), 12000);
          scheduleMediaStats();
          return;
        }
        if (pc.connectionState === 'disconnected' && connected) {
          clearTimeout(disconnectTimer);
          disconnectTimer = setTimeout(() => {
            if (!closed && pc.connectionState === 'disconnected') {
              fail('webrtc disconnected');
            }
          }, 3000);
          return;
        }
        if (pc.connectionState === 'failed') {
          fail('webrtc connection failed');
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (!closed && pc.iceConnectionState === 'failed') {
          fail('webrtc ICE failed');
        }
      });

      ws.addEventListener('message', async (event) => {
        if (closed) return;
        if (typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'webrtc/candidate') {
          const candidate = {
            candidate: message.value,
            sdpMid: message.sdpMid ?? '0',
            sdpMLineIndex: message.sdpMLineIndex ?? 0,
          };
          if (remoteSet) {
            pc.addIceCandidate(candidate).catch(() => {});
          } else {
            earlyCandidates.push(candidate);
          }
          return;
        }
        if (message.type === 'webrtc/answer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: message.value });
            remoteSet = true;
            for (const candidate of earlyCandidates.splice(0)) {
              pc.addIceCandidate(candidate).catch(() => {});
            }
          } catch (error) {
            fail(`webrtc answer failed: ${error}`);
          }
          return;
        }
        if (message.type === 'error') fail(message.value || 'webrtc rejected');
      });
      ws.addEventListener('open', async () => {
        if (closed) return;
        pc.addTransceiver('video', { direction: 'recvonly' });
        if (!stream.audio_webrtc_url && !stream.video_only) {
          pc.addTransceiver('audio', { direction: 'recvonly' });
        }
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({
            type: 'webrtc/offer',
            value: pc.localDescription.sdp,
          }));
        } catch (error) {
          fail(`webrtc offer failed: ${error}`);
        }
      });
      // WebKit's error event carries no status; the following close event does.
      ws.addEventListener('error', () => {});
      ws.addEventListener('close', (event) => {
        if (!closed && !connected) {
          fail(
            `webrtc websocket closed (code=${event.code}, clean=${event.wasClean},`
            + ` reason=${event.reason || '-'})`,
          );
        }
      });

      connectTimer = setTimeout(() => {
        if (!connected) {
          fail(`webrtc connect timeout (state=${pc.connectionState}, ice=${pc.iceConnectionState})`);
        }
      }, primaryWithFallback ? WEBRTC_PRIMARY_CONNECT_TIMEOUT : WEBRTC_CONNECT_TIMEOUT);
      trackTimer = setTimeout(() => {
        if (!videoTrack) {
          fail(`webrtc video track timeout (state=${pc.connectionState})`);
        }
      }, primaryWithFallback ? WEBRTC_PRIMARY_TRACK_TIMEOUT : WEBRTC_TRACK_TIMEOUT);
      frameTimer = setTimeout(() => {
        if (!video.videoWidth) fail('webrtc frame timeout');
      }, WEBRTC_FRAME_TIMEOUT);
    };

    advance = (reason = '') => {
      if (disposed) return;
      cleanupTransport?.();
      cleanupTransport = null;
      transportIndex += 1;
      const mode = transports[transportIndex];
      if (!mode) {
        failed('player', reason || 'no playback transport available');
        return;
      }
      if (mode === 'webrtc') startWebrtc(reason, stream.webrtc_url, false);
      else if (mode === 'mse') startMse(reason);
      else startHls(reason);
    };

    if (stream.audio_webrtc_url) {
      const shouldEnableAudio = !video.muted;
      setSeparateAudio(shouldEnableAudio);
      audioControllers.set(video, { setEnabled: setSeparateAudio });
    } else {
      audioControllers.delete(video);
    }
    advance();
    return cleanup;
  }

  root.MiCameraPlayer = Object.freeze({
    play,
    setAudio(video, enabled) {
      const controller = audioControllers.get(video);
      if (!controller) return false;
      controller.setEnabled(Boolean(enabled));
      return true;
    },
  });
})(window);
