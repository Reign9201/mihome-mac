(function (root) {
  const MSE_CODECS = [
    'avc1.640029',
    'avc1.64002A',
    'avc1.640033',
    'hvc1.1.6.L153.B0',
    'mp4a.40.2',
    'mp4a.40.5',
    'flac',
  ];
  const WEBRTC_CONNECT_TIMEOUT = 8000;
  const WEBRTC_TRACK_TIMEOUT = 12000;
  const WEBRTC_FRAME_TIMEOUT = 15000;
  const MSE_STARTUP_TIMEOUT = 8000;
  const MSE_FRAME_TIMEOUT = 12000;
  const HLS_STARTUP_TIMEOUT = 12000;
  const MSE_LIVE_TARGET = 1;
  const MSE_LIVE_MAX = 2.5;

  function supportedMseTypes(MediaSourceClass) {
    if (!MediaSourceClass?.isTypeSupported) return '';
    return MSE_CODECS
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

    let disposed = false;
    let cleanupTransport = null;
    let transportIndex = -1;
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
      const codecs = supportedMseTypes(MediaSourceClass);
      if (!MediaSourceClass || !codecs || !stream.webrtc_url || !root.WebSocket) {
        advance(reason || 'mse unsupported');
        return;
      }

      const ws = new WebSocket(stream.webrtc_url);
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
      const pending = [];
      let pendingBytes = 0;

      const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(startupTimer);
        clearTimeout(frameTimer);
        clearTimeout(sourcePoll);
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
        if (end - start > MSE_LIVE_MAX) {
          try {
            sourceBuffer.remove(start, Math.max(start, end - MSE_LIVE_TARGET));
          } catch (_) {}
        }
        if (video.currentTime < start || video.currentTime === 0) {
          video.currentTime = Math.max(start, end - 0.15);
        }
        const gap = end - video.currentTime;
        if (gap > MSE_LIVE_MAX) {
          video.currentTime = Math.max(start, end - 0.15);
          video.playbackRate = 1;
        } else if (gap > 0.4) {
          video.playbackRate = Math.min(1.25, 1 + (gap - 0.25) * 0.25);
        } else if (gap > 0.2) {
          video.playbackRate = 1.04;
        } else {
          video.playbackRate = 1;
        }
        if ('setLiveSeekableRange' in mediaSource && end > start) {
          try { mediaSource.setLiveSeekableRange(start, end); } catch (_) {}
        }
        runPlayback(video);
      };

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
              maintainLiveWindow();
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

    const startWebrtc = (reason = '') => {
      if (disposed) return;
      if (!root.RTCPeerConnection || !stream.webrtc_url || !root.WebSocket) {
        advance(reason || 'webrtc unsupported');
        return;
      }

      resetVideo();
      const ws = new WebSocket(stream.webrtc_url);
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
      let loadedDataHandler = null;
      let volumeChangeHandler = null;
      let lastPlaybackError = '';

      const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearTimeout(trackTimer);
        clearTimeout(frameTimer);
        clearTimeout(disconnectTimer);
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
        failedOnce = true;
        failed('webrtc', detail);
        advance(detail);
      };

      const useTracks = () => {
        if (closed || !videoTrack) return;
        const current = video.srcObject;
        const media = current instanceof MediaStream ? current : new MediaStream();
        let changed = current !== media;
        for (const track of tracks.values()) {
          if (media.getTracks().some((item) => item.id === track.id)) continue;
          media.addTrack(track);
          changed = true;
        }
        if (current !== media) video.srcObject = media;
        if (changed || video.paused) {
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
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type !== 'inbound-rtp') return;
            const kind = report.kind || report.mediaType || 'unknown';
            inbound[kind] = {
              bytes: report.bytesReceived || 0,
              packets: report.packetsReceived || 0,
              audioLevel: report.audioLevel,
              totalAudioEnergy: report.totalAudioEnergy,
              totalSamplesDuration: report.totalSamplesDuration,
              frames: report.framesDecoded,
            };
          });
        } catch (_) {}
        const audioTrack = tracks.get('audio');
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
        diagnostics('webrtc', {
          reason,
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
          codecs,
          remoteAudioCodecs,
          inbound,
        });
      };

      loadedDataHandler = () => {
        if (closed || !video.videoWidth) return;
        clearTimeout(frameTimer);
        // Keep the live media transport once decoded frames are observable.
        try { ws.close(); } catch (_) {}
      };
      volumeChangeHandler = () => reportMedia('volumechange');
      video.addEventListener('loadeddata', loadedDataHandler, { once: true });
      video.addEventListener('volumechange', volumeChangeHandler);

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
        }
        event.track.addEventListener('unmute', useTracks);
        useTracks();
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
          notify('webrtc', 'connected');
          useTracks();
          setTimeout(() => reportMedia('connected'), 3000);
          setTimeout(() => reportMedia('connected+7s'), 7000);
          setTimeout(() => reportMedia('connected+12s'), 12000);
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
        pc.addTransceiver('audio', { direction: 'recvonly' });
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
      }, WEBRTC_CONNECT_TIMEOUT);
      trackTimer = setTimeout(() => {
        if (!videoTrack) {
          fail(`webrtc video track timeout (state=${pc.connectionState})`);
        }
      }, WEBRTC_TRACK_TIMEOUT);
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
      if (mode === 'webrtc') startWebrtc(reason);
      else if (mode === 'mse') startMse(reason);
      else startHls(reason);
    };

    advance();
    return cleanup;
  }

  root.MiCameraPlayer = Object.freeze({ play });
})(window);
