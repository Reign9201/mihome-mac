(function (root) {
  const MAX_MESSAGE = 4000;
  let pending = Promise.resolve();

  function text(value) {
    return String(value ?? '').slice(0, MAX_MESSAGE);
  }

  function invokeLog(level, tag, message) {
    const invoke = root.__MIHOME_TAURI__?.invoke;
    if (!invoke) return;
    // Serialize frontend log IPC so bursty diagnostics are never dropped.
    pending = pending.then(() => invoke('log_frontend', {
      level,
      tag: text(tag || 'UI').slice(0, 48),
      message: text(message),
    })).catch(() => {});
  }

  const originalError = root.console.error.bind(root.console);
  const originalWarn = root.console.warn.bind(root.console);
  root.console.error = (...args) => {
    originalError(...args);
    invokeLog('error', 'UI', args.map(text).join(' '));
  };
  root.console.warn = (...args) => {
    originalWarn(...args);
    invokeLog('warn', 'UI', args.map(text).join(' '));
  };

  root.addEventListener('error', (event) => {
    const where = event.filename
      ? ` (${String(event.filename).split('/').pop()}:${event.lineno || 0}:${event.colno || 0})`
      : '';
    invokeLog('error', 'UI', `${event.message || '脚本错误'}${where}`);
  });
  root.addEventListener('unhandledrejection', (event) => {
    invokeLog('error', 'UI', `未处理的异步错误：${text(event.reason)}`);
  });
  document.addEventListener('visibilitychange', () => {
    invokeLog('info', 'UI', document.hidden ? '窗口进入后台' : '窗口回到前台');
  });

  root.MiLog = Object.freeze({
    debug: (tag, message) => invokeLog('debug', tag, message),
    info: (tag, message) => invokeLog('info', tag, message),
    warn: (tag, message) => invokeLog('warn', tag, message),
    error: (tag, message) => invokeLog('error', tag, message),
  });

  try {
    const MediaSourceClass = root.ManagedMediaSource || root.MediaSource;
    invokeLog('info', 'UI', `播放器能力：${JSON.stringify({
      userAgent: navigator.userAgent,
      webrtc: 'RTCPeerConnection' in root,
      mediaSource: Boolean(MediaSourceClass),
      managedMediaSource: 'ManagedMediaSource' in root,
      hevcMse: Boolean(MediaSourceClass?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L153.B0"')),
      hls: document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
    })}`);
  } catch (error) {
    invokeLog('warn', 'UI', `读取播放器能力失败：${text(error)}`);
  }
  invokeLog('info', 'UI', `界面加载：${root.location.protocol}`);
})(window);
