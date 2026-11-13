const $ = (selector) => document.querySelector(selector);
const SPEC_BATCH_SIZE = 128;
const MAX_REMOTE_STREAMS = 6;
// Every local grid tile runs its own go2rtc + ffmpeg transcode, so large
// accounts page through cameras instead of opening every stream at once.
const MAX_LOCAL_GRID_STREAMS = 9;
const MAX_REMOTE_START_CONCURRENCY = 3;
const REMOTE_FIRST_FRAME_TIMEOUT = 15000;
const CAMERA_STALL_INTERVALS = 3;
const DEVICE_PRESENCE_REFRESH_MS = 15000;
const log = window.MiLog || Object.freeze({
  debug() {}, info() {}, warn() {}, error() {},
});
const uiIcon = (name, className = '') => icon(name, className);
const runtime = {
  inflight: 0,
  lastRequestMs: 0,
  lastRenderMs: 0,
  errors: 0,
  logs: [],
};
const rawInvoke = window.__MIHOME_TAURI__?.invoke;
const uiLocale = () => window.MihomeI18n?.locale || 'zh-CN';
const uiText = (value, values = null) =>
  window.MihomeI18n?.t?.(String(value ?? ''), values) ?? String(value ?? '');

function runtimeLog(message) {
  runtime.logs.unshift(`${new Date().toLocaleTimeString(uiLocale(), { hour12: false })} ${message}`);
  runtime.logs = runtime.logs.slice(0, 4);
  const box = $('#hudLog');
  if (box) box.innerHTML = runtime.logs.map((line) => `<div>${esc(line)}</div>`).join('');
}

const invoke = rawInvoke
  ? async (command, args = {}) => {
    runtime.inflight += 1;
    const started = performance.now();
    try {
      return await rawInvoke(command, args);
    } catch (error) {
      runtime.errors += 1;
      runtimeLog(`${command} 失败`);
      throw error;
    } finally {
      runtime.inflight = Math.max(0, runtime.inflight - 1);
      runtime.lastRequestMs = performance.now() - started;
    }
  }
  : undefined;

for (const eventName of ['copy', 'cut', 'dragstart', 'selectstart', 'contextmenu']) {
  document.addEventListener(eventName, (event) => {
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
  }, true);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function toast(message, error = false) {
  const stack = $('#toastStack');
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.innerHTML = `${uiIcon(error ? 'close' : 'check')}<span>${esc(message)}</span>`;
  stack.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 260);
  }, 2800);
}

const state = {
  homes: [], devices: [], scenes: [], automations: [], homeId: null, selected: null,
  page: 'overview', theme: localStorage.getItem('mihome-theme') || 'light',
  density: localStorage.getItem('mihome-density') || 'comfortable',
  style: localStorage.getItem('mihome-style') === 'classic' ? 'classic' : 'modern',
  overviewSensorLoading: new Set(), overviewSensorHydrated: new Set(),
  sensorSeries: [], paletteIndex: 0, paletteItems: [],
  statsCache: new Map(), statsRange: localStorage.getItem('mihome-stats-range') || '7d',
  polling: false, loggedIn: false, cameras: [], cameraStreams: [], cameraGrid: false, cameraGridPage: 0,
  selectedCameraDid: null, roomFilter: 'all', activeCamera: null, remoteActive: false,
  deviceFilter: 'all', deviceQuery: '', cameraQuery: '', cameraSessionStartedAt: null, cameraPaused: false,
  remoteWatch: null, remoteWatches: [], cameraWatches: new Map(),
  cameraGeneration: 0, cameraControlsRequest: 0,
  cameraStopSequence: 0,
  cameraQueue: Promise.resolve(),
  restartingCameras: new Set(), restartTimers: new Map(), restartAttempts: new Map(), cardProps: new Map(),
  environmentValues: new Map(), environmentRequest: 0, environmentRevision: 0,
  environmentRefreshing: false, environmentSyncAt: 0,
  remoteAudio: new Map(),
  videoPlayers: new WeakMap(), streamCleanups: new Set(),
  hydratedCards: new Set(), cardObserver: null, cardHydrationQueue: new Map(),
  cardHydrationTimer: null, specs: new Map(), specErrors: new Map(), specLoading: false, specPending: new Set(),
  devicesRequest: 0, inspectorRequest: 0, scenesRequest: 0, camerasRequest: 0,
  automationsRequest: 0, accountGeneration: 0, accountTransition: false,
  accounts: [], loginMode: 'initial', loginRequest: 0, authRecovery: null,
  presenceRefreshing: false, lastPresenceSyncAt: 0, presenceSyncFailed: false,
  access: {
    platform: 'feishu', snapshot: null, pairing: null,
    pairTimer: null, token: '', loading: false, draftMode: null, pollTimer: null,
  },
  quickPick: {
    kind: 'devices', selected: [], listing: [], saving: false, query: '',
  },
};

function setStatus(text, kind = '') {
  const status = $('#loginStatus');
  if (status) {
    status.textContent = text;
    status.className = `status login-status ${kind}`;
  }
  const dot = $('#connDot');
  dot.className = `dot ${kind === 'error' ? 'err' : state.loggedIn ? 'online' : ''}`;
  $('#connText').textContent = state.loggedIn ? '已连接' : kind === 'error' ? '连接失败' : '未登录';
  const accountState = $('#accountState');
  if (accountState) {
    accountState.textContent = state.loggedIn
      ? `${Math.max(1, state.accounts.length)} 个账号 · 已连接`
      : kind === 'error' ? '连接失败' : '等待登录';
  }
  const settingsState = $('#settingsAccountState');
  if (settingsState) settingsState.textContent = state.loggedIn ? '已连接' : kind === 'error' ? '连接失败' : '未登录';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function runLimited(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function queueCameraOperation(operation) {
  const result = state.cameraQueue.then(operation, operation);
  state.cameraQueue = result.catch(() => {});
  return result;
}

function setCameraAudio(video, enabled, name) {
  if (!video) return false;
  if (!enabled) {
    video.muted = true;
    window.MiCameraPlayer?.setAudio?.(video, false);
    return true;
  }

  if (window.MiCameraPlayer?.setAudio?.(video, true)) {
    // Remote audio has its own PeerConnection. Keep the video element muted
    // so audio buffering can never pace the live video pipeline.
    video.muted = true;
    video.volume = 1;
    return true;
  }

  video.muted = false;
  video.volume = 1;
  const audioTracks = video.srcObject?.getAudioTracks?.() || [];
  if (!audioTracks.length) return false;

  // WKWebView does not reliably reopen audio output when only `muted`
  // changes. Restarting the media element while the track is present makes
  // the existing WebRTC audio track audible without renegotiating the stream.
  if (!video.paused) video.pause();
  video.play().catch((error) => {
    log.error('Camera', `恢复声音播放失败：${name} ${error}`);
    $('#camHint').textContent = `声音已开启，但播放器没有开始播放：${error}`;
  });
  return true;
}

function attachCameraStream(video, stream, camera, generation, onStall) {
  const previous = state.videoPlayers.get(video);
  if (previous) {
    previous();
    state.streamCleanups.delete(previous);
  }
  const name = camera?.name || stream.id;
  if (!window.MiCameraPlayer) {
    video.src = stream.url;
    video.load();
    video.play().catch(() => {});
    return;
  }
  const transportCleanup = window.MiCameraPlayer.play(video, stream, {
    onMode: (mode, detail) => {
      log.info('Camera', `${name} 播放模式：${mode}${detail ? `（${detail}）` : ''}`);
    },
    onError: (mode, error) => {
      log.warn('Camera', `${name} ${mode} 播放失败：${error}`);
    },
    onStall: (mode, detail) => {
      log.warn('Camera', `${name} ${mode} 需要重建整条取流通道：${detail}`);
      onStall?.();
    },
    onDiagnostics: (mode, detail) => {
      const reason = detail?.reason || '';
      const importantAudio = mode === 'audio'
        && ['track', 'connected', 'enabled', 'playing', 'signal', 'play rejected', 'failed'].includes(reason);
      const importantVideo = mode === 'webrtc'
        && ['restart', 'resume-stalled', 'jitter-buffer', 'decode-stall', 'packet-stall', 'hard-stall'].includes(reason);
      const message = `${name} ${mode} 媒体诊断：${JSON.stringify(detail)}`;
      if (reason === 'failed' || reason === 'play rejected') {
        log.warn('Camera', message);
      } else if (importantAudio || importantVideo) {
        log.info('Camera', message);
      } else {
        log.debug('Camera', message);
      }
    },
  });
  const cleanup = () => {
    transportCleanup();
    state.streamCleanups.delete(cleanup);
  };
  state.videoPlayers.set(video, cleanup);
  state.streamCleanups.add(cleanup);
}

async function startAuth() {
  if (!invoke) {
    setStatus('请从 MiHome Mac 桌面应用打开这个页面', 'error');
    return;
  }
  state.loginRequest += 1;
  const request = state.loginRequest;
  state.polling = false;
  $('#startAuth').disabled = true;
  setStatus(state.loginMode === 'add' ? '正在为新增账号申请二维码…' : '正在向小米申请二维码…');
  log.info('Auth', '开始申请登录二维码');
  try {
    const result = await invoke('auth_start');
    if (request !== state.loginRequest) return;
    $('#qrBox').innerHTML = result.qr_svg;
    setStatus('等待扫码，二维码 5 分钟内有效');
    state.polling = true;
    pollAuth(request);
  } catch (error) {
    if (request !== state.loginRequest) return;
    log.error('Auth', `申请二维码失败：${error}`);
    setStatus(`申请二维码失败：${error}`, 'error');
    $('#startAuth').disabled = false;
  }
}

async function pollAuth(request) {
  while (state.polling) {
    try {
      const result = await invoke('auth_poll');
      if (request !== state.loginRequest || !state.polling) return;
      if (result.status === 'success') {
        state.polling = false;
        state.loggedIn = true;
        setStatus(`登录成功，用户 ${result.user_id}`);
        if (result.message) toast(result.message, true);
        await finishLogin(result.user_id);
        log.info('Auth', '扫码登录成功');
        return;
      }
      if (result.status === 'error') {
        log.error('Auth', `扫码登录失败：${result.message || '未知错误'}`);
        state.polling = false;
        setStatus(result.message || '登录失败', 'error');
        $('#startAuth').disabled = false;
        return;
      }
      setStatus('等待扫码中…');
    } catch (error) {
      const text = String(error);
      if (text.includes('没有进行中的登录') || text.includes('二维码已过期')) {
        log.warn('Auth', text);
        state.polling = false;
        setStatus(text.includes('过期') ? '二维码已过期，请重新生成' : '登录会话已结束，请重新生成二维码', 'error');
        $('#startAuth').disabled = false;
        return;
      }
      // A dropped long poll is not a failed login. Keep waiting until the QR expires.
      setStatus('连接中断，正在重试…');
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

function accountLabel(account) {
  if (account?.display_name) return account.display_name;
  const userId = String(account?.user_id || '');
  if (!userId) return '米家账号';
  const visible = userId.length > 10
    ? `${userId.slice(0, 4)}…${userId.slice(-4)}`
    : userId;
  return `米家账号 ${visible}`;
}

function activeAccount() {
  return state.accounts.find((account) => account.active) || null;
}

async function loadAccounts() {
  try {
    state.accounts = await invoke('auth_accounts');
    renderAccounts();
    updateAccount();
    return state.accounts;
  } catch (error) {
    log.warn('Auth', `读取账号列表失败：${error}`);
    return state.accounts;
  }
}

function renderAccounts() {
  const list = $('#accountList');
  if (!list) return;
  list.replaceChildren();
  if (!state.accounts.length) {
    list.append(el('div', 'account-pop-empty', '还没有保存的米家账号'));
    return;
  }
  for (const account of state.accounts) {
    const label = accountLabel(account);
    const card = el('button', `account-card${account.active ? ' active' : ''}`);
    card.type = 'button';
    card.dataset.account = account.user_id;
    card.setAttribute('aria-current', account.active ? 'true' : 'false');
    card.title = account.active ? '当前账号' : `切换到 ${label}`;
    const avatar = el('span', 'account-avatar', label.slice(0, 1) || '米');
    const copy = el('span', 'account-card-copy');
    copy.append(el('strong', '', label));
    copy.append(el('small', '', account.active ? '当前账号 · 数据已隔离' : '切换后重新加载该账号数据'));
    const stateDot = el('span', `account-card-state${account.active ? ' active' : ''}`);
    card.append(avatar, copy, stateDot);
    card.onclick = () => {
      if (!account.active) switchAccount(account.user_id);
    };
    list.append(card);
  }
}

function openAccountPop() {
  if (!state.loggedIn) return;
  renderAccounts();
  $('#accountPop').classList.add('open');
  $('#accountPop').setAttribute('aria-hidden', 'false');
}

function closeAccountPop() {
  $('#accountPop')?.classList.remove('open');
  $('#accountPop')?.setAttribute('aria-hidden', 'true');
}

function showLogin(mode = 'initial') {
  state.loginMode = mode;
  const adding = mode === 'add';
  $('#loginTitle').textContent = adding ? '添加米家账号' : '扫码登录';
  $('#loginSubtitle').textContent = adding
    ? '新账号会独立保存，家庭、设备、摄像头与自动化不会串到当前账号'
    : '打开米家 App，扫描下方二维码';
  $('#loginBack').hidden = !adding;
  $('#qrBox').innerHTML = '<div class="qr-placeholder">二维码准备中</div>';
  $('#loginLayer').style.display = 'grid';
  requestAnimationFrame(() => $('#loginLayer').classList.remove('hide'));
  setStatus(adding ? '正在添加账号…' : '未登录');
}

function hideLogin() {
  $('#loginLayer').classList.add('hide');
  $('#loginLayer').style.display = 'none';
  $('#loginBack').hidden = true;
  state.loginMode = 'initial';
}

function isAuthExpiredError(error) {
  return /\bHTTP\s*401\b|\b401\s*Unauthorized\b|\bUnauthorized\b/i.test(String(error || ''));
}

async function recoverExpiredSession(error) {
  if (!isAuthExpiredError(error)) return false;
  state.loggedIn = false;
  state.polling = false;
  $('#logout').hidden = true;
  setShellEnabled(false);
  showLogin('initial');
  if (!state.authRecovery) {
    state.authRecovery = startAuth().finally(() => {
      state.authRecovery = null;
    });
  }
  await state.authRecovery;
  return true;
}

function setShellEnabled(enabled) {
  for (const id of ['overviewNav', 'cameraNav', 'sceneNav', 'automationNav', 'devicesNav', 'settingsNav']) {
    const node = $('#' + id);
    if (node) node.disabled = !enabled;
  }
  $('#logout').hidden = !enabled || !state.loggedIn;
}

async function resetAccountScopedState(reason) {
  state.accountGeneration += 1;
  state.devicesRequest += 1;
  state.inspectorRequest += 1;
  state.scenesRequest += 1;
  state.camerasRequest += 1;
  state.automationsRequest += 1;
  state.cameraControlsRequest += 1;
  state.cardObserver?.disconnect();
  state.cardObserver = null;
  if (state.cardHydrationTimer) clearTimeout(state.cardHydrationTimer);
  state.cardHydrationTimer = null;
  state.cardHydrationQueue.clear();
  state.hydratedCards.clear();
  state.cardProps = new Map();
  state.environmentValues = new Map();
  state.environmentRequest += 1;
  state.environmentRevision += 1;
  state.environmentRefreshing = false;
  state.environmentSyncAt = 0;
  state.overviewSensorLoading.clear();
  state.overviewSensorHydrated.clear();
  state.sensorSeries = [];
  state.homes = [];
  state.homeId = null;
  state.devices = [];
  state.scenes = [];
  state.automations = [];
  state.cameras = [];
  state.selected = null;
  state.selectedCameraDid = null;
  state.roomFilter = 'all';
  state.deviceFilter = 'all';
  state.deviceQuery = '';
  state.cameraQuery = '';
  if ($('#camSearch')) $('#camSearch').value = '';
  state.lastPresenceSyncAt = 0;
  state.presenceSyncFailed = false;
  state.presenceRefreshing = false;
  if ($('#deviceSearch')) $('#deviceSearch').value = '';
  $('#homeSelect')?.replaceChildren();
  $('#deviceList')?.replaceChildren(el('div', 'empty', `正在${reason}…`));
  $('#sceneList')?.replaceChildren(el('div', 'empty', `正在${reason}…`));
  $('#autoList')?.replaceChildren(el('div', 'empty', `正在${reason}…`));
  $('#camList')?.replaceChildren(el('div', 'empty', `正在${reason}…`));
  setNavCount('devicesCount', 0);
  setNavCount('sceneCount', 0);
  setNavCount('automationCount', 0);
  setNavCount('cameraCount', 0);
  setNavCount('cameraCountNav', 0);
  closeInspector();
  closeAccountPop();
  await stopCamera();
  renderSidebarRooms();
  updateChrome();
}

async function finishLogin(userId) {
  state.loginRequest += 1;
  state.polling = false;
  state.loggedIn = true;
  log.info('Auth', `账号登录完成：${userId}`);
  await loadAccounts();
  await resetAccountScopedState('加载账号数据');
  await loadHomes();
  hideLogin();
}

async function switchAccount(userId) {
  if (state.accountTransition) return;
  const current = activeAccount();
  if (current?.user_id === userId) {
    closeAccountPop();
    return;
  }
  state.accountTransition = true;
  closeAccountPop();
  setShellEnabled(false);
  setStatus('正在切换账号，旧账号数据已隐藏…');
  await resetAccountScopedState('切换账号');
  try {
    await invoke('auth_switch_account', { userId });
    state.loggedIn = true;
    await loadAccounts();
    await loadHomes();
    toast('账号已切换，数据已隔离加载');
  } catch (error) {
    log.error('Auth', `切换账号失败：${error}`);
    toast(`切换账号失败：${error}`, true);
    await loadAccounts();
    await loadHomes().catch(() => {});
  } finally {
    state.accountTransition = false;
    setShellEnabled(state.loggedIn);
  }
}

async function cancelAddAccount() {
  if (state.loginMode !== 'add') return;
  state.polling = false;
  state.loginRequest += 1;
  try {
    await invoke('auth_cancel');
    hideLogin();
    setStatus('已取消添加账号');
  } catch (error) {
    log.warn('Auth', `取消登录失败：${error}`);
    setStatus(`取消登录失败，请重试：${error}`, 'error');
  }
}

async function loadHomes() {
  const generation = state.accountGeneration;
  setShellEnabled(false);
  try {
    const homes = await invoke('list_homes');
    if (generation !== state.accountGeneration) return;
    state.homes = homes;
    state.homeId = homes[0]?.id || null;
    if (state.homeId) localStorage.setItem('mihome-home-id', state.homeId);
    renderHomeTabs();
    log.info('Home', `已加载家庭 ${homes.length} 个`);
    hideLogin();
    $('#logout').hidden = false;
    setShellEnabled(true);
    updateAccount();
    $('#syncText').textContent = '已连接';
    if (!homes.length) {
      $('#overviewView').hidden = false;
      $('#overviewView').innerHTML = '<div class="page-head"><div><div class="eyebrow">当前账号</div><h1 class="page-title">还没有家庭</h1><p class="page-sub">请先在米家 App 中创建家庭并添加设备，然后刷新。</p></div><div class="head-actions"><button class="ghost-btn" data-empty-refresh>刷新</button></div></div>';
      $('#overviewView').querySelector('[data-empty-refresh]')?.addEventListener('click', loadHomes);
      setStatus('登录成功，但账号下没有家庭');
      return;
    }
    await loadDevices();
    if (generation !== state.accountGeneration) return;
    await showOverview();
    Promise.allSettled([loadScenes(), loadCameras(), loadAutomations()]).then(() => {
      if (state.page === 'overview') renderOverview(true);
    });
    await syncAccountLabel();
  } catch (error) {
    if (generation !== state.accountGeneration) return;
    log.error('Home', `读取家庭失败：${error}`);
    if (await recoverExpiredSession(error)) return;
    state.loggedIn = false;
    $('#logout').hidden = true;
    setStatus(`读取家庭失败：${error}`, 'error');
    $('#startAuth').disabled = false;
    setShellEnabled(false);
  }
}

async function syncAccountLabel() {
  const account = activeAccount();
  const home = state.homes[0];
  if (!account || account.display_name || !home?.name) return;
  try {
    await invoke('auth_set_account_label', { label: home.name });
    await loadAccounts();
    updateAccount();
  } catch (error) {
    log.debug('Auth', `保存账号显示名失败：${error}`);
  }
}

function renderHomeTabs() {
  const box = $('#homeSelect');
  if (!box) return;
  box.replaceChildren();
  for (const home of state.homes) {
    const option = document.createElement('option');
    option.value = home.id;
    option.textContent = home.name;
    option.selected = home.id === state.homeId;
    box.append(option);
  }
  box.onchange = async () => {
    state.homeId = box.value;
    localStorage.setItem('mihome-home-id', state.homeId);
    state.roomFilter = 'all';
    state.deviceFilter = 'all';
    state.deviceQuery = '';
    if ($('#deviceSearch')) $('#deviceSearch').value = '';
    state.selected = null;
    state.overviewSensorHydrated.clear();
    state.sensorSeries = [];
    renderHomeTabs();
    updateAccount();
    updateChrome();
    closeInspector();
    await loadDevices();
    await showOverview();
    Promise.allSettled([loadScenes(), loadCameras(), loadAutomations()]);
  };
}

function currentHome() {
  return state.homes.find((home) => home.id === state.homeId);
}

function updateAccount() {
  const home = currentHome();
  const currentAccount = activeAccount();
  const name = currentAccount?.display_name || home?.name || accountLabel(currentAccount);
  $('#accountName').textContent = name;
  $('#accountAvatar').textContent = name.slice(0, 1) || '米';
  const accountState = $('#accountState');
  if (accountState && state.loggedIn) {
    accountState.textContent = `${Math.max(1, state.accounts.length)} 个账号 · 已连接`;
  }
  const settingsAccount = $('#settingsAccount');
  if (settingsAccount) settingsAccount.textContent = name;
  const settingsState = $('#settingsAccountState');
  if (settingsState) {
    settingsState.textContent = state.accounts.length > 1
      ? `已连接 · ${state.accounts.length} 个账号`
      : '已连接';
  }
}

const PAGE_TITLES = {
  overview: '总览',
  devices: '全部设备',
  camera: '监控',
  scenes: '场景',
  automations: '自动化',
  access: '接入',
  settings: '设置',
};

function updateChrome() {
  document.querySelectorAll('#mainNav [data-nav], .sidebar-footer [data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === state.page);
  });
  const home = currentHome()?.name || 'MiHome';
  const room = state.roomFilter === 'all' ? '' : `${roomGroups().find((item) => item.id === state.roomFilter)?.name || ''} · `;
  const pageTitle = MihomeI18n?.t(PAGE_TITLES[state.page] || '总览') || PAGE_TITLES[state.page] || '总览';
  $('#windowTitle').textContent = `${room}${pageTitle} — ${home}`;
  const online = state.devices.filter((device) => device.online).length;
  const localCameras = state.cameras.filter((camera) => camera.online && camera.ip).length;
  const remoteCameras = state.cameras.filter((camera) => camera.online && !camera.ip).length;
  const remote = remoteCameras ? ` · ${uiText('仅远程 {0}', [remoteCameras])}` : '';
  $('#statusPath').textContent = state.loggedIn
    ? uiText('在线 {0}/{1} · 本地摄像头 {2}{3}', [online, state.devices.length, localCameras, remote])
    : uiText('等待连接');
  setNavCount('devicesCount', state.devices.length);
  setNavCount('cameraCountNav', state.cameras.length);
  updateCameraCount();
  $('#topnavCaption').textContent = localCameras
    ? uiText('本地摄像头可达：{0}', [localCameras])
    : uiText('本地优先 · 云端兜底');
  const statusSync = $('#statusSync');
  if (statusSync && state.loggedIn) {
    if (state.presenceSyncFailed) {
      statusSync.textContent = '状态同步失败，保留上次结果';
    } else if (state.lastPresenceSyncAt) {
      const time = new Intl.DateTimeFormat(uiLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(state.lastPresenceSyncAt));
      statusSync.textContent = `${time} 更新`;
    } else {
      statusSync.textContent = '等待首次同步';
    }
  }
  updateEnvironmentCapsule();
  updateSettingsSelection();
  scheduleFitTopnav();
}

function rectsOverlap(a, b, gap = 8) {
  return a.width > 0 && b.width > 0 && a.left < b.right + gap && b.left < a.right + gap;
}

// Collapses inactive top tabs to icons when their labels would collide with
// the brand or the context area. Driven by measurement instead of a fixed
// breakpoint because label width depends on the UI language.
function fitTopnav() {
  const nav = $('#mainNav');
  const tabs = nav?.querySelector('.topnav-tabs');
  if (!tabs) return;
  const levels = ['compact-caption', 'compact-tabs', 'compact-brand', 'compact-all'];
  nav.classList.remove(...levels);
  const collides = () => {
    const tabRect = tabs.getBoundingClientRect();
    return [
      nav.querySelector('.topnav-brand .brand-mark'),
      nav.querySelector('.topnav-brand .brand-text'),
      nav.querySelector('.topnav-context'),
    ].filter((node) => node?.offsetWidth)
      .some((node) => rectsOverlap(tabRect, node.getBoundingClientRect()));
  };
  // Each level is kept and the next one added until nothing collides. The
  // caption goes first: the status bar already shows the same camera count.
  for (const level of levels) {
    if (!collides()) return;
    nav.classList.add(level);
  }
}

let fitTopnavFrame = 0;

// Measuring forces layout, so run it once per frame after renders settle.
function scheduleFitTopnav() {
  cancelAnimationFrame(fitTopnavFrame);
  fitTopnavFrame = requestAnimationFrame(fitTopnav);
}

if ('ResizeObserver' in window && $('#mainNav')) {
  const observer = new ResizeObserver(scheduleFitTopnav);
  observer.observe($('#mainNav'));
  observer.observe($('#mainNav .topnav-context'));
}

function showView(page) {
  const started = performance.now();
  state.page = page;
  if (page !== 'access' && state.access.pollTimer) {
    clearInterval(state.access.pollTimer);
    state.access.pollTimer = null;
  }
  for (const [id, key] of [
    ['overviewView', 'overview'],
    ['devicesView', 'devices'],
    ['cameraView', 'camera'],
    ['sceneView', 'scenes'],
    ['automationView', 'automations'],
    ['accessView', 'access'],
    ['settingsView', 'settings'],
  ]) {
    $('#' + id).hidden = key !== page;
  }
  $('#main').scrollTop = 0;
  updateChrome();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    runtime.lastRenderMs = performance.now() - started;
  }));
}

function roomName(device) {
  if (device.room_name) return device.room_name;
  const room = currentHome()?.rooms?.find((item) => item.id === device.room_id);
  return room?.name || uiText('未分房间');
}

function roomGroups() {
  const home = currentHome();
  const rooms = home?.rooms || [];
  const known = new Set(rooms.map((room) => room.id));
  const groups = [];
  for (const room of rooms) {
    const devices = state.devices.filter((device) => device.room_id === room.id);
    if (devices.length) groups.push({ id: room.id, name: room.name, devices });
  }
  const unassigned = state.devices.filter((device) => !device.room_id || !known.has(device.room_id));
  if (unassigned.length) groups.push({ id: 'unassigned', name: '未分房间', devices: unassigned });
  return groups;
}

function setNavCount(id, count) {
  const node = $('#' + id);
  if (node) node.textContent = count ? String(count) : '';
}

function roomShortName(name) {
  const text = String(name || '未');
  const glyph = (key) => [...String(MihomeI18n?.t(key) || key).trim()][0] || key.slice(0, 1);
  if (/客厅/.test(text)) return glyph('客厅');
  if (/主卧|卧室/.test(text)) return glyph('卧室');
  if (/书房/.test(text)) return glyph('书房');
  if (/厨房/.test(text)) return glyph('厨房');
  if (/玄关/.test(text)) return glyph('玄关');
  if (/阳台/.test(text)) return glyph('阳台');
  if (/卫生间|浴室/.test(text)) return glyph('卫生间');
  return text.slice(0, 1);
}

function renderSidebarRooms() {
  const list = $('#roomList');
  if (!list) return;
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  const groups = roomGroups();
  const all = el('button', `room-item all-rooms ${state.roomFilter === 'all' ? 'active' : ''}`);
  all.type = 'button';
  all.dataset.room = 'all';
  const allRoomsLabel = uiText('全部房间');
  all.append(el('span', 'room-glyph', [...allRoomsLabel.trim()][0] || '全'), el('span', '', allRoomsLabel));
  if (state.devices.some((device) => device.online)) all.append(el('i', 'room-dot'));
  all.append(el('span', 'room-count', String(state.devices.length)));
  all.onclick = () => {
    state.roomFilter = 'all';
    showOverview();
  };
  fragment.append(all);
  for (const group of groups) {
    const label = group.id === 'unassigned' ? uiText(group.name) : group.name;
    const button = el('button', `room-item ${state.roomFilter === group.id ? 'active' : ''}`);
    button.type = 'button';
    button.dataset.room = group.id;
    button.append(el('span', 'room-glyph', roomShortName(label)), el('span', '', label));
    if (group.devices.some((device) => device.online)) button.append(el('i', 'room-dot'));
    button.append(el('span', 'room-count', String(group.devices.length)));
    button.onclick = () => {
      state.roomFilter = state.roomFilter === group.id ? 'all' : group.id;
      showOverview();
    };
    fragment.append(button);
  }
  list.append(fragment);
}

async function loadDevices() {
  const request = ++state.devicesRequest;
  const homeId = state.homeId;
  $('#deviceList').replaceChildren(el('div', 'empty', '正在读取设备…'));
  try {
    const devices = await invoke('list_devices', { homeId });
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    state.devices = devices;
    state.lastPresenceSyncAt = Date.now();
    state.presenceSyncFailed = false;
    state.cardProps = new Map();
    state.environmentValues = new Map();
    state.environmentRevision += 1;
    state.environmentSyncAt = 0;
    state.hydratedCards = new Set();
    state.overviewSensorHydrated.clear();
    state.sensorSeries = [];
    setNavCount('devicesCount', devices.length);
    renderDevices();
    renderSidebarRooms();
    closeInspector();
    renderOverview();
    updateChrome();
    loadDeviceSpecs(devices);
    refreshEnvironmentStatus();
  } catch (error) {
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    $('#deviceList').replaceChildren(el('div', 'empty error', `读取设备失败：${error}`));
    renderSidebarRooms();
  }
}

// list_cameras is only read when the camera page opens; carry the online flag
// from the periodic device sync so camera buttons and counts stay current.
function syncCameraPresence(devices) {
  if (!devices.length || !state.cameras.length) return false;
  const online = new Map(devices.map((device) => [device.did, Boolean(device.online)]));
  let changed = false;
  const cameras = state.cameras.map((camera) => {
    const value = online.get(camera.did);
    if (value === undefined || value === camera.online) return camera;
    changed = true;
    return { ...camera, online: value };
  });
  if (changed) state.cameras = cameras;
  return changed;
}

function clearCachedDeviceState(did) {
  state.hydratedCards.delete(did);
  const prefix = `${did}:`;
  for (const key of state.cardProps.keys()) {
    if (key.startsWith(prefix)) state.cardProps.delete(key);
  }
}

async function refreshDevicePresence() {
  if (!invoke || !state.loggedIn || !state.homeId || state.presenceRefreshing) return false;
  state.presenceRefreshing = true;
  const homeId = state.homeId;
  const request = ++state.devicesRequest;
  try {
    const devices = await invoke('list_devices', { homeId });
    if (request !== state.devicesRequest || homeId !== state.homeId) return false;
    const previous = new Map(state.devices.map((device) => [device.did, device]));
    const changed = devices.filter((device) => {
      const before = previous.get(device.did);
      return !before
        || before.online !== device.online
        || before.name !== device.name
        || before.model !== device.model
        || before.room_id !== device.room_id
        || before.room_name !== device.room_name
        || before.parent_id !== device.parent_id;
    });
    const onlineChanged = changed.filter((device) => {
      const before = previous.get(device.did);
      return !before || before.online !== device.online;
    });
    for (const device of onlineChanged) clearCachedDeviceState(device.did);
    state.devices = devices;
    state.lastPresenceSyncAt = Date.now();
    state.presenceSyncFailed = false;
    // Re-render even when the camera page is hidden: its next background
    // reload compares against this already-synced list and would otherwise
    // keep showing the old online state.
    if (syncCameraPresence(onlineChanged)) renderCameras();
    if (!changed.length && devices.length === previous.size) {
      updateChrome();
      return true;
    }
    setNavCount('devicesCount', devices.length);
    renderSidebarRooms();
    if (state.page === 'overview') renderOverview(true);
    if (state.page === 'devices') renderDevices();
    const selected = state.selected
      ? devices.find((device) => device.did === state.selected.did)
      : null;
    state.selected = selected || null;
    if (selected) renderInspector(selected);
    else if ($('#inspector').classList.contains('open')) closeInspector();
    updateChrome();
    if ($('#menubarPop').classList.contains('open')) renderQuickPanel();
    refreshEnvironmentStatus();
    for (const device of onlineChanged) {
      if (device.online) queueCardHydration(device);
    }
    if (changed.length) {
      log.info('Device', `设备状态刷新：${changed.length} 台发生变化`);
    }
    return true;
  } catch (error) {
    state.presenceSyncFailed = true;
    updateChrome();
    log.debug('Device', `在线状态刷新失败：${error}`);
    return false;
  } finally {
    state.presenceRefreshing = false;
  }
}

const DEVICE_ICONS = window.MiIcons.icons;
const deviceKind = window.MiIcons.kindFor;
const { profileFromSpec, summarizeCardMetrics, formatArrayValue } = window.MiCapabilities;

// Device rows and cards repeat the same few SVG icons hundreds of times.
// Parse each markup string once and clone it afterwards.
const htmlTemplates = new Map();

function setCachedHTML(node, html) {
  let template = htmlTemplates.get(html);
  if (!template) {
    if (htmlTemplates.size > 256) htmlTemplates.clear();
    template = document.createElement('template');
    template.innerHTML = html;
    htmlTemplates.set(html, template);
  }
  node.replaceChildren(template.content.cloneNode(true));
}

function deviceGlyph(device) {
  const kind = deviceKind(device);
  const body = DEVICE_ICONS[kind] || DEVICE_ICONS.generic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function propKey(did, siid, piid) {
  return `${did}:${siid}:${piid}`;
}

function cardValue(device, siid, piid) {
  return state.cardProps.get(propKey(device.did, siid, piid));
}

function specFor(device) {
  return device.spec_type ? state.specs.get(device.spec_type) : null;
}

function hasSpecAction(device, siid, aiid) {
  return Boolean(specFor(device)?.services?.some((service) =>
    service.iid === siid && service.actions?.some((action) => action.iid === aiid)));
}

// Parsing a MIoT spec is the hot path of every render: the environment capsule,
// device rows and overview all ask for it per device. Cache per spec object and
// UI locale; the cached profile is treated as read-only by every caller.
const specProfileCache = new WeakMap();

function specProfile(spec) {
  const locale = window.MihomeI18n?.locale || '';
  const cached = specProfileCache.get(spec);
  if (cached && cached.locale === locale) return cached.profile;
  const profile = profileFromSpec(spec);
  specProfileCache.set(spec, { locale, profile });
  return profile;
}

function cardProfile(device) {
  const kind = deviceKind(device);
  const spec = specFor(device);
  const specError = device.spec_type ? state.specErrors.get(device.spec_type) : null;
  const fallbackNote = device.spec_type && state.specPending.has(device.spec_type)
    ? '正在读取设备规格…'
    : specError
      ? `设备规格读取失败：${specError}`
      : '没有找到公开 MIoT-Spec，当前不提供写入控制。';
  const base = spec
    ? specProfile(spec)
    : { metrics: [], controls: [], actions: [], note: fallbackNote };
  let action = null;
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    action = { label: '查看监控', kind: 'camera' };
  } else if (kind === 'router' && hasSpecAction(device, 2, 1)) {
    action = { label: '重启', kind: 'reboot', top: true };
  } else if (kind === 'tv' && hasSpecAction(device, 2, 1)) {
    action = { label: '电源', kind: 'tv-power', top: true };
  }
  return { ...base, action };
}

async function loadDeviceSpecs(devices) {
  const types = [...new Set(devices.map((device) => device.spec_type).filter(Boolean))];
  const missing = types.filter((type) => !state.specs.has(type) && !state.specPending.has(type));
  // Nothing new to parse, so the environment summary is unchanged. Refreshing
  // it here re-read every device's power state (about 14 cloud requests at
  // 150 cameras) each time the camera list loaded.
  if (!missing.length) return;
  state.specLoading = true;
  for (const type of missing) state.specPending.add(type);
  let failedBatches = 0;
  try {
    for (let offset = 0; offset < missing.length; offset += SPEC_BATCH_SIZE) {
      const chunk = missing.slice(offset, offset + SPEC_BATCH_SIZE);
      try {
        const batch = await invoke('get_device_specs', { specTypes: chunk });
        for (const [type, spec] of Object.entries(batch.specs || {})) {
          state.specs.set(type, spec);
          state.specErrors.delete(type);
        }
        for (const error of batch.errors || []) {
          const type = chunk.find((candidate) => String(error).startsWith(candidate)) || String(error);
          state.specErrors.set(type, error);
          console.warn(error);
        }
      } catch (error) {
        failedBatches += 1;
        for (const type of chunk) state.specErrors.set(type, String(error));
      }
    }
    if (failedBatches) toast(`有 ${failedBatches} 批设备规格读取失败`, true);
  } finally {
    for (const type of missing) state.specPending.delete(type);
    state.specLoading = false;
    state.hydratedCards.clear();
    renderDevices();
    renderSidebarRooms();
    if (state.page === 'overview') renderOverview(true);
    if (!$('#cameraView').hidden) {
      renderCameras();
      if (state.activeCamera && state.cameraStreams.length) {
        renderCameraControls(state.activeCamera, state.remoteActive);
      }
    } else if (!$('#devicesView').hidden && state.selected) {
      const selected = state.devices.find((device) => device.did === state.selected.did);
      if (selected) selectDevice(selected);
    }
    refreshEnvironmentStatus();
  }
}

function ensureCardObserver() {
  if (state.cardObserver || !('IntersectionObserver' in window)) return state.cardObserver;
  state.cardObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const device = state.devices.find((item) => item.did === entry.target.dataset.did);
      if (device) queueCardHydration(device);
    }
  }, { rootMargin: '360px 0px' });
  return state.cardObserver;
}

function observeDeviceCard(card, device) {
  if (state.hydratedCards.has(device.did)) return;
  const observer = ensureCardObserver();
  if (observer) observer.observe(card);
  else queueCardHydration(device);
}

function queueCardHydration(device) {
  if (state.hydratedCards.has(device.did)) return;
  state.cardHydrationQueue.set(device.did, device);
  if (state.cardHydrationTimer) return;
  state.cardHydrationTimer = setTimeout(flushCardHydration, 90);
}

function propertyRequestsForDevice(device) {
  const profile = cardProfile(device);
  return [...profile.metrics, ...profile.controls]
    .filter((item) => item.readable !== false)
    .map((item) => ({ did: device.did, siid: item.siid, piid: item.piid }));
}

async function flushCardHydration() {
  state.cardHydrationTimer = null;
  const devices = [...state.cardHydrationQueue.values()];
  state.cardHydrationQueue.clear();
  if (!devices.length) return;
  const requests = devices.flatMap(propertyRequestsForDevice);
  const currentHome = state.homeId;
  // A device-list reload replaces cardProps; the 15 s presence sync does not,
  // so its request counter must not discard an in-flight hydration batch.
  const props = state.cardProps;
  const generation = state.accountGeneration;
  if (requests.length) {
    try {
      const result = await invoke('get_properties', { requests });
      if (
        currentHome !== state.homeId
        || props !== state.cardProps
        || generation !== state.accountGeneration
      ) return;
      for (const item of Array.isArray(result) ? result : []) {
        if (!item || !item.did || (item.code && item.code !== 0)) continue;
        state.cardProps.set(propKey(item.did, item.siid, item.piid), item.value);
      }
    } catch (_) {
      // Cards remain usable as shortcuts when a model exposes no readable properties.
    }
  }
  for (const device of devices) {
    state.hydratedCards.add(device.did);
    refreshDeviceCard(device);
  }
  updateChrome();
}

function formatCardValue(value, def) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) {
    return formatArrayValue(value);
  }
  if (typeof value === 'object') return '—';
  if (def.options) {
    const option = def.options.find(([key]) => String(key) === String(value));
    if (option) {
      const label = String(option[1] ?? '').trim();
      return /^-?\d+(?:\.\d+)?$/.test(label) ? '未知' : label;
    }
  }
  const numeric = typeof value === 'number'
    || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()));
  if (!numeric) return formatArrayValue([value]) || '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (def.suffix?.startsWith('storage-')) {
    const bytes = Math.max(0, number) * 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unit = units[0];
    for (let index = 1; index < units.length && amount >= 1024; index += 1) {
      amount /= 1024;
      unit = units[index];
    }
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${unit}`;
  }
  if (!def.unit && Math.abs(number) >= 1000) {
    return new Intl.NumberFormat(uiLocale()).format(number);
  }
  return `${number.toFixed(def.digits ?? 0)}${def.unit || ''}`;
}

async function setCardProp(device, siid, piid, value) {
  const result = await invoke('set_property', { did: device.did, siid, piid, value });
  const item = Array.isArray(result) ? result[0] : result;
  if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
  state.cardProps.set(propKey(device.did, siid, piid), value);
  state.environmentValues.set(propKey(device.did, siid, piid), value);
  state.environmentRevision += 1;
  refreshDeviceCard(device);
  updateChrome();
}

function cardReboot(device) {
  const button = el('button', 'card-power card-reboot');
  button.type = 'button';
  button.disabled = !device.online;
  button.title = '重启路由器';
  button.setAttribute('aria-label', '重启路由器');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.1M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!confirm(`重启「${device.name}」？网络会中断约 1 分钟。`)) return;
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('重启指令已发送');
    } catch (error) {
      toast(`重启失败：${error}`, true);
    } finally {
      button.disabled = !device.online;
    }
  };
  return button;
}

async function refreshAfterTvPower(device) {
  const request = ++state.devicesRequest;
  const homeId = state.homeId;
  try {
    const devices = await invoke('list_devices', { homeId });
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    state.devices = devices;
    state.cardProps = new Map();
    state.hydratedCards = new Set();
    setNavCount('devicesCount', devices.length);
    renderDevices();
    const updated = devices.find((item) => item.did === device.did);
    if (updated) selectDevice(updated);
  } catch (error) {
    toast(`刷新电视状态失败：${error}`, true);
  }
}

function cardTvPower(device) {
  const button = el('button', 'card-power off');
  button.type = 'button';
  button.title = device.online ? '关机' : '开机';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!device.online) {
      toast('电视当前离线，暂不支持远程开机；先用电视遥控开机。');
      return;
    }
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('已发送关机指令，几秒后电视会下线。');
      setTimeout(() => refreshAfterTvPower(device), 5000);
    } catch (error) {
      toast(`关机指令失败：${error}`, true);
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function cardPower(device, def) {
  const on = Boolean(cardValue(device, def.siid, def.piid));
  const button = el('button', `card-power ${on ? 'on' : 'off'}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.title = `${uiText(def.label)} ${uiText(on ? '已开启' : '已关闭')}`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(on));
  const bulb = def.label.includes('灯') || def.label.includes('照明');
  setCachedHTML(button, bulb
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.3 2.2h4.6c.2-1 .7-1.7 1.3-2.2A6 6 0 0 0 12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>');
  button.onclick = async (event) => {
    event.stopPropagation();
    const next = !on;
    button.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
    } catch (error) {
      button.disabled = false;
      toast(`设置失败：${error}`, true);
    }
  };
  return button;
}

function cardToggle(device, def) {
  const row = el('label', 'card-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(cardValue(device, def.siid, def.piid));
  input.disabled = !device.online;
  input.onclick = (event) => event.stopPropagation();
  input.onchange = async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
    } catch (error) {
      input.checked = !next;
      toast(`设置失败：${error}`, true);
    } finally {
      input.disabled = false;
    }
  };
  const copy = el('span', 'card-toggle-copy');
  copy.append(el('span', '', uiText(def.label)));
  copy.append(el('small', '', uiText(input.checked ? '已开启' : '已关闭')));
  const track = el('span', 'card-switch-track');
  track.append(el('span', 'card-switch-knob'));
  row.append(copy, input, track);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardRange(device, def) {
  const row = el('label', 'card-range');
  const head = el('span', 'card-range-head');
  head.append(el('span', '', uiText(def.label)));
  const current = cardValue(device, def.siid, def.piid);
  const step = Number(def.step) > 0 ? Number(def.step) : 1;
  const digits = Number.isFinite(Number(def.digits))
    ? Number(def.digits)
    : step < 1 ? 1 : 0;
  const displayValue = (value) => `${Number(value).toFixed(digits)}${def.suffix || ''}`;
  const output = el('small', '', current === undefined ? '—' : displayValue(current));
  head.append(output);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(def.min);
  range.max = String(def.max);
  range.step = String(step);
  range.value = String(current ?? def.min);
  range.disabled = !device.online;
  range.oninput = () => {
    output.textContent = displayValue(range.value);
  };
  range.onchange = async () => {
    const next = Number(range.value);
    range.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
      output.textContent = displayValue(next);
    } catch (error) {
      toast(`设置失败：${error}`, true);
    } finally {
      range.disabled = false;
    }
  };
  row.append(head, range);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardSegments(device, def) {
  const row = el('div', 'card-segments');
  row.append(el('span', 'card-segments-label', uiText(def.label)));
  const group = el('div', 'card-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', 'card-segment', uiText(label));
    button.type = 'button';
    button.classList.toggle('active', String(current) === String(value));
    button.disabled = !device.online;
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        await setCardProp(device, def.siid, def.piid, value);
      } catch (error) {
        toast(`设置失败：${error}`, true);
      }
    };
    group.append(button);
  }
  row.append(group);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardAction(device, action) {
  const button = el('button', 'card-action', uiText(action.label));
  button.type = 'button';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (action.kind === 'camera') {
      await showCameras();
      await startRemoteCamera(device);
    } else {
      await selectDevice(device);
    }
  };
  return button;
}

function cardSummary(device, profile) {
  if (!device.online) return uiText('设备离线');
  const summary = summarizeCardMetrics(
    profile,
    (def) => cardValue(device, def.siid, def.piid),
  );
  if (summary) return summary;
  if (profile.controls.length) {
    const range = profile.controls.find((item) => item.type === 'range');
    if (range && (range.suffix || range.unit)) {
      const value = cardValue(device, range.siid, range.piid);
      const number = Number(value);
      if (value !== undefined && value !== null && Number.isFinite(number)) {
        return `${uiText(range.label)} ${number.toFixed(0)}${range.suffix || range.unit || ''}`;
      }
    }
  }
  const primary = profile.controls.find((item) => item.primary);
  if (primary) {
    const value = cardValue(device, primary.siid, primary.piid);
    if (value !== undefined && value !== null) return uiText(value ? '已开启' : '已关闭');
  }
  return uiText('在线');
}

function deviceTone(kind) {
  const family = window.MiIcons.familyFor(kind);
  return ({
    lighting: 'warm',
    climate: 'cool',
    security: 'sage',
    curtain: 'sand',
    sensor: 'sage',
    plug: 'sand',
    network: 'cool',
    entertainment: 'ink',
  })[family] || 'sand';
}

function inlineDeviceSwitch(device, def) {
  const on = Boolean(cardValue(device, def.siid, def.piid));
  const button = el('button', `inline-switch ${on ? 'on' : ''}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(on));
  button.setAttribute('aria-label', `${device.name}${uiText(def.label)}`);
  button.onclick = async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, !on);
      if ($('#menubarPop')?.classList.contains('open')) renderQuickPanel();
    } catch (error) {
      toast(`设置失败：${error}`, true);
      button.disabled = !device.online;
    }
  };
  return button;
}

function openCameraDevice(device) {
  const camera = state.cameras.find((item) => item.did === device.did);
  if (camera) {
    state.selectedCameraDid = camera.did;
    showCameras();
  } else {
    showCameras();
  }
}

function cardCameraView(device) {
  const button = el('button', 'card-power card-camera');
  button.type = 'button';
  button.title = uiText('查看监控');
  button.setAttribute('aria-label', `${uiText('查看监控')}：${device.name}`);
  button.innerHTML = uiIcon('play');
  button.onclick = (event) => {
    event.stopPropagation();
    openCameraDevice(device);
  };
  return button;
}

function renderDeviceCard(device) {
  const profile = cardProfile(device);
  const kind = deviceKind(device);
  const family = window.MiIcons.familyFor(kind);
  const card = el(
    'article',
    `device-card ${state.selected?.did === device.did ? 'active' : ''} ${device.online ? '' : 'offline'}`,
  );
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${device.name}，${roomName(device)}`);
  card.dataset.family = family;
  card.dataset.did = device.did;

  const top = el('div', 'device-card-top');
  const glyph = el('span', 'device-glyph');
  glyph.dataset.kind = kind;
  glyph.dataset.family = family;
  setCachedHTML(glyph, deviceGlyph(device));
  top.append(glyph);

  const topActions = el('div', 'card-top-actions');
  const primary = profile.controls.find((item) => item.primary);
  if (primary) topActions.append(cardPower(device, primary));
  else if (profile.action?.kind === 'tv-power') topActions.append(cardTvPower(device));
  else if (profile.action?.kind === 'reboot') topActions.append(cardReboot(device));
  else if (profile.action?.kind === 'camera') topActions.append(cardCameraView(device));
  top.append(topActions);
  card.append(top);

  const title = el('div', 'device-card-title');
  title.append(el('strong', 'device-card-name', device.name));
  const subline = el('div', 'card-subline');
  subline.append(el('span', 'device-room', roomName(device)));
  subline.append(el('span', 'card-subline-sep', '·'));
  subline.append(el('span', 'card-summary', cardSummary(device, profile)));
  title.append(subline);
  card.append(title);

  card.onclick = () => selectDevice(device);
  card.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDevice(device);
    }
  };
  return card;
}

function renderDeviceRow(device) {
  const profile = cardProfile(device);
  const kind = deviceKind(device);
  const row = el('div', `device-row ${state.selected?.did === device.did ? 'active' : ''} ${device.online ? '' : 'off'}`);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `${device.name}，${roomName(device)}`);
  row.dataset.did = device.did;
  row.dataset.family = window.MiIcons.familyFor(kind);

  const glyph = el('span', 'device-icon');
  glyph.dataset.tone = deviceTone(kind);
  glyph.dataset.kind = kind;
  setCachedHTML(glyph, deviceGlyph(device));
  row.append(glyph);

  const copy = el('div', 'device-id');
  const name = el('div', 'device-name');
  name.append(document.createTextNode(device.name));
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    const camera = state.cameras.find((item) => item.did === device.did);
    name.append(el('span', camera?.ip ? 'tag lan' : 'tag cloud', camera?.ip ? '本地' : '远程'));
  }
  const meta = el('div', 'device-meta');
  if (document.body.dataset.style === 'classic') {
    meta.append(el('span', 'device-room-label', roomName(device)), el('span', 'device-meta-separator', ' · '));
  }
  meta.append(document.createTextNode(cardSummary(device, profile)));
  copy.append(name, meta);
  row.append(copy);

  const controls = el('div', 'device-control');
  const primary = profile.controls.find((item) => item.primary);
  if (primary) controls.append(inlineDeviceSwitch(device, primary));
  else if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    const view = el('button', 'mini-view', '查看');
    view.type = 'button';
    view.onclick = (event) => {
      event.stopPropagation();
      openCameraDevice(device);
    };
    controls.append(view);
  } else if (profile.action?.top) {
    controls.append(profile.action.kind === 'tv-power' ? cardTvPower(device) : cardReboot(device));
  }
  row.append(controls);

  const more = el('button', 'row-more');
  more.type = 'button';
  more.setAttribute('aria-label', `查看 ${device.name} 详情`);
  more.innerHTML = uiIcon('more');
  more.onclick = (event) => {
    event.stopPropagation();
    selectDevice(device);
  };
  row.append(more);

  row.onclick = () => selectDevice(device);
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDevice(device);
    }
  };
  return row;
}

// state.cameras is always replaced, never mutated, so its identity is a valid
// cache key. Rows look up their camera several times per render.
let cameraIndex = { list: null, byDid: new Map() };

function cameraForDevice(device) {
  if (cameraIndex.list !== state.cameras) {
    cameraIndex = {
      list: state.cameras,
      byDid: new Map(state.cameras.map((camera) => [camera.did, camera])),
    };
  }
  return cameraIndex.byDid.get(device.did) || null;
}

function deviceFilterState(device) {
  if (!device.online) return 'off';
  const camera = cameraForDevice(device);
  if (camera) return camera.ip ? 'local' : 'cloud';
  const primary = cardProfile(device).controls.find((item) => item.primary);
  if (primary && cardValue(device, primary.siid, primary.piid) === false) return 'off';
  return 'cloud';
}

function deviceConnection(device) {
  const camera = cameraForDevice(device);
  if (!camera) return { label: '云端', className: 'cloud' };
  if (!camera.online) return { label: '离线', className: 'local' };
  return camera.ip
    ? { label: '本地', className: 'lan' }
    : { label: '远程', className: 'cloud' };
}

function deviceState(device) {
  if (!device.online) return { label: '离线', className: 'off' };
  if (cameraForDevice(device)) return { label: '在线', className: 'live' };
  const primary = cardProfile(device).controls.find((item) => item.primary);
  if (!primary) return { label: '在线', className: '' };
  const value = cardValue(device, primary.siid, primary.piid);
  if (value === undefined || value === null) return { label: '在线', className: '' };
  return value
    ? { label: '开启', className: '' }
    : { label: '关闭', className: 'off' };
}

function renderDeviceTableRow(device) {
  const kind = deviceKind(device);
  const camera = cameraForDevice(device);
  const connection = deviceConnection(device);
  const status = deviceState(device);
  const row = el('div', `table-row ${state.selected?.did === device.did ? 'active' : ''}`);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.did = device.did;
  row.setAttribute('aria-label', `${device.name}，${roomName(device)}，${uiText(status.label)}`);

  const identity = el('div', 'table-device');
  const glyph = el('span', 'device-icon');
  glyph.dataset.tone = deviceTone(kind);
  glyph.dataset.kind = kind;
  setCachedHTML(glyph, deviceGlyph(device));
  identity.append(glyph, el('span', '', device.name));

  const connectionNode = el('span');
  connectionNode.append(el('span', `tag ${connection.className}`, connection.label));

  const action = el('button', 'row-more');
  action.type = 'button';
  if (camera) {
    action.innerHTML = uiIcon('play');
    action.setAttribute('aria-label', `打开 ${device.name} 监控`);
    action.title = '打开监控';
    action.onclick = (event) => {
      event.stopPropagation();
      openCameraDevice(device);
    };
  } else {
    action.innerHTML = uiIcon('more');
    action.setAttribute('aria-label', `查看 ${device.name} 详情`);
    action.onclick = (event) => {
      event.stopPropagation();
      selectDevice(device);
    };
  }

  row.append(
    identity,
    el('span', '', roomName(device)),
    connectionNode,
    el('span', `state-pill ${status.className}`, status.label),
    action,
  );
  row.onclick = () => selectDevice(device);
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDevice(device);
    }
  };
  return row;
}

function refreshDeviceCard(device) {
  const rows = [...document.querySelectorAll('.device-card, .device-row, .table-row')]
    .filter((node) => node.dataset.did === device.did);
  for (const old of rows) {
    state.cardObserver?.unobserve(old);
    const replacement = old.classList.contains('device-card')
      ? renderDeviceCard(device)
      : old.classList.contains('table-row')
        ? renderDeviceTableRow(device)
        : renderDeviceRow(device);
    old.replaceWith(replacement);
    observeDeviceCard(replacement, device);
  }
}

function renderDeviceFilters() {
  const bar = $('#deviceFilters');
  if (!bar) return;
  bar.replaceChildren();
  const counts = {
    all: state.devices.length,
    local: state.devices.filter((device) => deviceFilterState(device) === 'local').length,
    cloud: state.devices.filter((device) => deviceFilterState(device) === 'cloud').length,
    off: state.devices.filter((device) => deviceFilterState(device) === 'off').length,
  };
  for (const [key, label] of [
    ['all', '全部'],
    ['local', '本地直连'],
    ['cloud', '云端'],
    ['off', '已关闭'],
  ]) {
    const button = el('button', `filter-chip ${state.deviceFilter === key ? 'active' : ''}`, label);
    button.type = 'button';
    button.dataset.deviceFilter = key;
    button.setAttribute('aria-pressed', String(state.deviceFilter === key));
    button.append(el('span', 'filter-count', ` ${counts[key]}`));
    bar.append(button);
  }
}

function renderDevices() {
  const list = $('#deviceList');
  for (const row of list.querySelectorAll('.device-row, .table-row')) {
    state.cardObserver?.unobserve(row);
  }
  list.replaceChildren();
  if (!state.devices.length) {
    list.append(el('div', 'empty', '这个家庭没有设备'));
    renderDeviceFilters();
    $('#devicePageCount').textContent = '0';
    return;
  }
  renderDeviceFilters();
  const localCameras = state.devices.filter((device) => deviceFilterState(device) === 'local').length;
  const query = state.deviceQuery.trim().toLowerCase();
  const target = state.devices.filter((device) => {
    if (state.deviceFilter !== 'all' && deviceFilterState(device) !== state.deviceFilter) return false;
    if (!query) return true;
    return deviceSearchText(device).includes(query);
  });
  $('#devicesEyebrow').textContent = uiText('设备 {0} · 本地摄像头 {1}', [
    state.devices.length,
    localCameras,
  ]);
  $('#devicesSubtitle').textContent = state.deviceFilter === 'all' && !query
    ? '点任意一行查看属性、连接路径与最近状态。'
    : `当前筛选 ${target.length} 台设备；点击房间可回到总览继续按房间浏览。`;
  $('#devicePageCount').textContent = `${target.length} / ${state.devices.length}`;
  if (!target.length) {
    list.append(el('div', 'empty', '没有符合筛选条件的设备'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const device of target) {
    const row = renderDeviceTableRow(device);
    fragment.append(row);
    observeDeviceCard(row, device);
  }
  list.append(fragment);
  // Keep the first screen responsive even when IntersectionObserver callbacks are
  // delayed (for example while the WebView window is in the background).
  for (const device of target.slice(0, 12)) queueCardHydration(device);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function todayLabel() {
  return new Intl.DateTimeFormat(uiLocale(), {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

function overviewSensorValues(sensor) {
  if (!sensor) return { temperature: null, humidity: null };
  const profile = cardProfile(sensor);
  const findMetric = (pattern) => profile.metrics.find((item) =>
    pattern.test(`${item.label} ${item.suffix || ''} ${item.unit || ''}`));
  const temperatureDef = findMetric(/温度|temperature/i);
  const humidityDef = findMetric(/湿度|humidity/i);
  return {
    temperature: temperatureDef ? environmentValue(sensor, temperatureDef) : null,
    humidity: humidityDef ? environmentValue(sensor, humidityDef) : null,
  };
}

function overviewSensorDevice() {
  const sensors = state.devices.filter((device) =>
    deviceKind(device) === 'temp-humidity'
    || ['motion-sensor', 'sensor'].includes(deviceKind(device)));
  return sensors.find((device) => device.online) || sensors[0] || null;
}

function environmentValue(device, item) {
  if (!device || !item) return undefined;
  const key = propKey(device.did, item.siid, item.piid);
  return state.environmentValues.has(key)
    ? state.environmentValues.get(key)
    : cardValue(device, item.siid, item.piid);
}

const CONSUMABLE_PATTERN = /filter-life|filter-remaining|remaining-filter|cartridge|consumable|滤芯|耗材/i;

function deviceConsumables(device) {
  const profile = cardProfile(device);
  const seen = new Set();
  return [...profile.metrics, ...profile.controls].filter((item) => {
    const key = `${item.siid}:${item.piid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.readable !== false
      && CONSUMABLE_PATTERN.test(`${item.suffix || ''} ${item.label || ''}`);
  });
}

function consumableIsLow(item, value) {
  const numeric = typeof value === 'boolean' ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) return false;
  const max = Number(item?.max);
  const threshold = Number.isFinite(max)
    ? (max <= 1 ? 0.2 : Math.max(1, max * 0.2))
    : (item?.unit === '%' ? 20 : 20);
  return numeric <= threshold;
}

function environmentSnapshot() {
  const sensor = overviewSensorDevice();
  const sensorValues = overviewSensorValues(sensor);
  const online = state.devices.filter((device) => device.online).length;
  let powered = 0;
  let powerKnown = 0;
  let powerCapable = 0;
  let consumableTotal = 0;
  let consumableKnown = 0;
  let consumableLow = 0;

  for (const device of state.devices) {
    if (!device.online) continue;
    const primary = cardProfile(device).controls.find((item) => item.primary);
    if (primary) {
      powerCapable += 1;
      const value = environmentValue(device, primary);
      if (value !== undefined && value !== null) {
        powerKnown += 1;
        if (value === true) powered += 1;
      }
    }
    for (const item of deviceConsumables(device)) {
      const value = environmentValue(device, item);
      consumableTotal += 1;
      if (value === undefined || value === null) continue;
      consumableKnown += 1;
      if (consumableIsLow(item, value)) consumableLow += 1;
    }
  }

  return {
    sensor,
    temperature: Number(sensorValues.temperature),
    humidity: Number(sensorValues.humidity),
    online,
    total: state.devices.length,
    powered,
    powerKnown,
    powerCapable,
    consumableTotal,
    consumableKnown,
    consumableLow,
    syncAt: state.environmentSyncAt,
  };
}

function updateEnvironmentCapsule() {
  const capsule = $('#envCapsule');
  if (!capsule) return;
  const data = environmentSnapshot();
  const temperature = Number.isFinite(data.temperature) ? data.temperature : null;
  const humidity = Number.isFinite(data.humidity) ? data.humidity : null;
  const powered = data.powerKnown ? String(data.powered) : '—';
  const consumable = data.consumableKnown
    ? String(data.consumableLow)
    : data.consumableTotal ? '—' : '0';

  $('#envTempValue').textContent = temperature === null ? '—' : `${temperature.toFixed(1)}°`;
  $('#envHumidityValue').textContent = humidity === null ? '—' : `${humidity.toFixed(0)}%`;
  $('#envPoweredValue').textContent = powered;
  $('#envConsumableValue').textContent = consumable;

  $('#envTemperature').title = uiText('温度');
  $('#envHumidity').title = uiText('湿度');
  $('#envPowered').title = `${uiText('已开启')} ${powered} · ${uiText('在线 {0}/{1}', [
    data.online,
    data.total,
  ])}`;
  $('#envConsumable').title = `${uiText('耗材不足')} ${consumable}`;
  $('#envConsumable').classList.toggle('attention', data.consumableLow > 0);
  $('#envPopConsumableItem').classList.toggle('attention', data.consumableLow > 0);

  $('#envPopTemp').textContent = temperature === null ? '—' : `${temperature.toFixed(1)} °C`;
  $('#envPopHumidity').textContent = humidity === null ? '—' : `${humidity.toFixed(0)}%`;
  $('#envPopPowered').textContent = data.powerKnown
    ? `${data.powered} / ${data.powerCapable}`
    : '—';
  $('#envPopOnline').textContent = `${data.online} / ${data.total}`;
  $('#envPopConsumable').textContent = data.consumableKnown
    ? `${data.consumableLow} / ${data.consumableTotal}`
    : data.consumableTotal ? '—' : '0';
  $('#envPopSource').textContent = data.sensor
    ? `${roomName(data.sensor)} · ${data.sensor.name}`
    : uiText('家庭环境');
}

async function refreshEnvironmentStatus() {
  if (!invoke || !state.loggedIn || !state.homeId || state.environmentRefreshing) return false;
  const sensor = overviewSensorDevice();
  const requests = [];
  const seen = new Set();
  const addRequest = (device, item) => {
    if (!device || !item || item.readable === false) return;
    const key = propKey(device.did, item.siid, item.piid);
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ did: device.did, siid: item.siid, piid: item.piid });
  };

  if (sensor) {
    for (const item of cardProfile(sensor).metrics) addRequest(sensor, item);
  }
  for (const device of state.devices) {
    if (!device.online) continue;
    const primary = cardProfile(device).controls.find((item) => item.primary);
    addRequest(device, primary);
    for (const item of deviceConsumables(device)) addRequest(device, item);
  }
  if (!requests.length) {
    state.environmentSyncAt = Date.now();
    updateEnvironmentCapsule();
    return true;
  }

  const homeId = state.homeId;
  const generation = state.accountGeneration;
  const revision = state.environmentRevision;
  const request = ++state.environmentRequest;
  state.environmentRefreshing = true;
  try {
    const result = await invoke('get_properties', { requests });
    if (
      request !== state.environmentRequest
      || homeId !== state.homeId
      || generation !== state.accountGeneration
      || revision !== state.environmentRevision
    ) return false;
    const values = new Map(state.environmentValues);
    for (const item of Array.isArray(result) ? result : []) {
      if (!item || !item.did || (item.code && item.code !== 0)) continue;
      values.set(propKey(item.did, item.siid, item.piid), item.value);
    }
    state.environmentValues = values;
    state.environmentSyncAt = Date.now();
    return true;
  } catch (error) {
    log.debug('Overview', `读取设备状态失败：${error}`);
    return false;
  } finally {
    if (request === state.environmentRequest) {
      state.environmentRefreshing = false;
      updateChrome();
    }
  }
}

function sparkline(values, key = 'spark') {
  const points = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const w = 320;
  const h = 42;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points.map((value, index) => {
    const x = points.length === 1 ? w : (index / (points.length - 1)) * w;
    const y = h - 3 - ((value - min) / span) * (h - 6);
    return [x, y];
  });
  const line = coords.map((point, index) =>
    `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
  return `<svg class="hero-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${key}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${line} L${w},${h} L0,${h} Z" fill="url(#${key})"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="${coords.at(-1)[0]}" cy="${coords.at(-1)[1]}" r="2.4" fill="var(--accent)"/>
  </svg>`;
}

async function hydrateOverviewSensor(sensor) {
  if (!sensor || state.overviewSensorLoading.has(sensor.did) || state.overviewSensorHydrated.has(sensor.did)) return;
  const generation = state.accountGeneration;
  const homeId = state.homeId;
  const profile = cardProfile(sensor);
  const requests = profile.metrics
    .filter((item) => item.readable !== false)
    .map((item) => ({ did: sensor.did, siid: item.siid, piid: item.piid }));
  if (!requests.length) return;
  state.overviewSensorLoading.add(sensor.did);
  try {
    const result = await invoke('get_properties', { requests });
    if (generation !== state.accountGeneration || homeId !== state.homeId) return;
    for (const item of Array.isArray(result) ? result : []) {
      if (!item || item.did !== sensor.did || (item.code && item.code !== 0)) continue;
      const key = propKey(item.did, item.siid, item.piid);
      state.cardProps.set(key, item.value);
      state.environmentValues.set(key, item.value);
    }
    const values = overviewSensorValues(sensor);
    if (Number.isFinite(Number(values.temperature))) {
      state.sensorSeries.push(Number(values.temperature));
      state.sensorSeries = state.sensorSeries.slice(-18);
    }
  } catch (error) {
    log.debug('Overview', `温湿度状态暂不可读：${error}`);
  } finally {
    state.overviewSensorLoading.delete(sensor.did);
    if (generation === state.accountGeneration && homeId === state.homeId) {
      state.overviewSensorHydrated.add(sensor.did);
      updateChrome();
      if (state.page === 'overview') renderOverview(true);
    }
  }
}

function overviewCameraCard(camera) {
  const button = el('button', 'overview-cam');
  button.type = 'button';
  const art = el('div', 'cam-thumb-art');
  art.append(
    el('span', `live-dot${camera.online ? '' : ' muted'}`),
    el('span', 'cam-thumb-badge', camera.online ? 'LIVE' : 'OFFLINE'),
  );
  const info = el('div', 'overview-cam-info');
  info.append(el('strong', '', camera.name));
  info.append(el('span', '', camera.ip ? '局域网可达' : '仅远程通道'));
  button.append(art, info);
  button.onclick = () => {
    state.selectedCameraDid = camera.did;
    showCameras();
  };
  return button;
}

function overviewScenePill(scene, index) {
  const button = el('button', 'scene-pill');
  button.type = 'button';
  button.dataset.tone = ['amber', 'ink', 'blue', 'dusk'][index % 4];
  button.innerHTML = `<span class="sc-icon">${uiIcon(index % 2 ? 'moon' : 'spark')}</span>
    <span class="sc-text"><strong>${esc(scene.name)}</strong><small>手动场景 · 点击执行</small></span>`;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await invoke('run_scene', { sceneId: scene.id, homeId: state.homeId });
      toast(`「${scene.name}」已执行`);
    } catch (error) {
      toast(String(error), true);
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function renderOverview(preserveScroll = false) {
  const box = $('#overviewView');
  if (!box) return;
  const scroll = preserveScroll ? $('#main').scrollTop : 0;
  const groups = roomGroups();
  if (state.roomFilter !== 'all' && !groups.some((group) => group.id === state.roomFilter)) {
    state.roomFilter = 'all';
  }
  const visibleRooms = state.roomFilter === 'all'
    ? groups
    : groups.filter((group) => group.id === state.roomFilter);
  const sensor = state.devices.find((device) => deviceKind(device) === 'temp-humidity')
    || state.devices.find((device) => ['motion-sensor', 'sensor'].includes(deviceKind(device)));
  const sensorValues = overviewSensorValues(sensor);
  const temperature = Number(sensorValues.temperature);
  const humidity = Number(sensorValues.humidity);
  const online = state.devices.filter((device) => device.online).length;
  const localCameras = state.cameras.filter((camera) => camera.online && camera.ip).length;
  const title = state.roomFilter === 'all'
    ? greeting()
    : groups.find((group) => group.id === state.roomFilter)?.name || greeting();
  const homeName = currentHome()?.name || '我的家';
  const firstScene = state.scenes[0];
  box.innerHTML = `<div class="page-head">
    <div>
      <div class="eyebrow">${esc(todayLabel())} · ${esc(homeName)}</div>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-sub">${uiText('设备在线 {0}/{1} · 本地摄像头 {2} · 手动场景 {3}', [
        online,
        state.devices.length,
        localCameras,
        state.scenes.length,
      ])}</p>
    </div>
    <div class="head-actions">
      <button class="ghost-btn" data-overview-refresh>${uiIcon('history')} 刷新状态</button>
      ${firstScene ? `<button class="primary-btn" data-overview-scene="${esc(firstScene.id)}">${uiIcon('play')} ${esc(firstScene.name)}</button>` : ''}
    </div>
  </div>
  <div class="hero">
    <div class="hero-main">
      <div class="metric-label">${uiIcon('thermometer')} ${sensor ? `${esc(roomName(sensor))} · ${esc(sensor.name)}` : '家庭环境'}</div>
      <div class="hero-reading"><span class="big">${Number.isFinite(temperature) ? temperature.toFixed(1) : online}</span><span class="unit">${Number.isFinite(temperature) ? '°C' : '台在线'}</span></div>
      <div class="hero-sub">${Number.isFinite(humidity) ? `<b>湿度 ${humidity.toFixed(0)}%</b><span>·</span>` : ''}<span>${sensor && !Number.isFinite(temperature) ? '正在读取传感器状态' : '来自设备实时属性'}</span></div>
      ${sparkline(state.sensorSeries.length ? state.sensorSeries : [Number.isFinite(temperature) ? temperature : online], 'overviewSpark')}
    </div>
    <div class="hero-metrics">
      <div class="metric">
        <div class="metric-label">${uiIcon('drop')} 在线设备</div>
        <div class="metric-value">${online}<small>/ ${state.devices.length}</small></div>
        <div class="metric-foot good">${state.devices.length ? Math.round((online / state.devices.length) * 100) : 0}% 在线</div>
      </div>
      <div class="metric">
        <div class="metric-label">${uiIcon('camera')} 本地监控</div>
        <div class="metric-value">${localCameras}<small>/ ${state.cameras.length}</small></div>
        <div class="metric-foot ${localCameras ? 'good' : ''}">${localCameras ? '局域网可达' : '等待本地连接'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">${uiIcon('clock')} 定时任务</div>
        <div class="metric-value">${state.automations.filter((item) => item.enabled).length}<small>/ ${state.automations.length}</small></div>
        <div class="metric-foot">${state.automations.length ? '已启用' : '尚未创建'}</div>
      </div>
    </div>
  </div>`;

  const refresh = box.querySelector('[data-overview-refresh]');
  if (refresh) refresh.onclick = loadAll;
  const sceneRun = box.querySelector('[data-overview-scene]');
  if (sceneRun) {
    sceneRun.onclick = async () => {
      sceneRun.disabled = true;
      try {
        await invoke('run_scene', { sceneId: sceneRun.dataset.overviewScene, homeId: state.homeId });
        toast(`「${firstScene.name}」已执行`);
      } catch (error) {
        toast(String(error), true);
      } finally {
        sceneRun.disabled = false;
      }
    };
  }

  if (state.cameras.length) {
    const cams = el('section', 'overview-cams');
    const head = el('div', 'overview-cams-head');
    const copy = el('div');
    copy.append(el('div', 'eyebrow', '实时监控'), el('h3', '', uiText('摄像头：{0}', [state.cameras.length])));
    const openAll = el('button', 'text-btn', '打开监控台');
    openAll.type = 'button';
    openAll.onclick = showCameras;
    head.append(copy, openAll);
    const grid = el('div', 'overview-cam-grid');
    for (const camera of state.cameras.slice(0, 3)) grid.append(overviewCameraCard(camera));
    cams.append(head, grid);
    box.append(cams);
  }

  if (state.scenes.length) {
    const quick = el('div', 'quick-scenes');
    state.scenes.slice(0, 4).forEach((scene, index) => quick.append(overviewScenePill(scene, index)));
    box.append(quick);
  }

  if (!visibleRooms.length) {
    box.append(el('div', 'empty', '这个家庭还没有可显示的房间与设备'));
  }
  const renderRoomDevices = (devices, renderer = renderDeviceRow) => {
    const list = el('div', 'device-list');
    const fragment = document.createDocumentFragment();
    for (const device of devices) {
      const row = renderer(device);
      fragment.append(row);
      observeDeviceCard(row, device);
    }
    list.append(fragment);
    return list;
  };
  if (document.body.dataset.style === 'classic') {
    const section = el('section', 'room-block classic-room-block');
    section.append(renderRoomDevices(
      visibleRooms.flatMap((room) => room.devices),
      renderDeviceCard,
    ));
    box.append(section);
  } else {
    for (const room of visibleRooms) {
      const section = el('section', 'room-block');
      const head = el('div', 'room-head');
      head.append(el('span', 'room-title', room.name), el('span', 'room-count', `${room.devices.length} 台`), el('span', 'line'));
      section.append(head, renderRoomDevices(room.devices));
      box.append(section);
    }
  }
  if (sensor) hydrateOverviewSensor(sensor);
  $('#main').scrollTop = scroll;
}

function inspectorProfile(device) {
  const base = cardProfile(device);
  const metrics = [...base.metrics];
  const controls = base.controls.map((item) => ({ ...item, group: item.group || '控制' }));
  const note = base.note || (deviceKind(device) === 'tv' && !device.online
    ? '电视离线。云端不能远程开机；手机米家走的是本地通道。'
    : '');
  return { ...base, metrics, controls, note };
}

function inspectorRequests(device, profile) {
  const seen = new Set();
  const requests = [];
  for (const item of [...profile.metrics, ...profile.controls]) {
    if (item.readable === false) continue;
    const key = `${item.siid}:${item.piid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ did: device.did, siid: item.siid, piid: item.piid });
  }
  return requests;
}

async function selectDevice(device) {
  const request = ++state.inspectorRequest;
  state.selected = device;
  for (const row of document.querySelectorAll('.device-row')) {
    row.classList.toggle('active', row.dataset.did === device.did);
  }
  renderInspector(device, null, true);
  const profile = inspectorProfile(device);
  try {
    const result = await invoke('get_properties', { requests: inspectorRequests(device, profile) });
    if (request !== state.inspectorRequest || state.selected?.did !== device.did) return;
    for (const item of Array.isArray(result) ? result : []) {
      if (!item || !item.did || (item.code && item.code !== 0)) continue;
      state.cardProps.set(propKey(item.did, item.siid, item.piid), item.value);
    }
    renderInspector(device);
  } catch (error) {
    if (request !== state.inspectorRequest || state.selected?.did !== device.did) return;
    renderInspector(device, String(error));
  }
}

function detailMetric(value, def) {
  const card = el('div', 'detail-metric');
  card.append(el('span', 'detail-metric-label', uiText(def.label)));
  card.append(el('strong', '', formatCardValue(value, def)));
  return card;
}

function detailToggle(device, def) {
  const value = Boolean(cardValue(device, def.siid, def.piid));
  const row = el('div', `detail-control-row${def.primary ? ' primary' : ''}`);
  const copy = el('div', 'detail-control-copy');
  copy.append(el('span', 'detail-control-label', uiText(def.label)));
  copy.append(el('small', 'detail-control-state', uiText(value ? '已开启' : '已关闭')));
  const button = el('button', `detail-switch ${value ? 'on' : ''}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(value));
  button.setAttribute('aria-label', `${uiText(def.label)}${uiText(value ? '已开启' : '已关闭')}`);
  button.innerHTML = '<span></span>';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, !value);
      renderInspector(device);
    } catch (error) {
      toast(`设置失败：${error}`, true);
      button.disabled = false;
    }
  };
  row.append(copy, button);
  return row;
}

function detailRange(device, def) {
  const raw = cardValue(device, def.siid, def.piid);
  const row = el('label', 'detail-range');
  const head = el('div', 'detail-range-head');
  head.append(el('span', 'detail-control-label', uiText(def.label)));
  const step = Number(def.step) > 0 ? Number(def.step) : 1;
  const digits = Number.isFinite(Number(def.digits))
    ? Number(def.digits)
    : step < 1 ? 1 : 0;
  const displayValue = (value) => `${Number(value).toFixed(digits)}${def.suffix || ''}`;
  const output = el('strong', '', raw === undefined ? '—' : displayValue(raw));
  head.append(output);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(step);
  input.value = String(Number.isFinite(Number(raw)) ? raw : def.min);
  input.disabled = !device.online;
  input.oninput = () => { output.textContent = displayValue(input.value); };
  input.onchange = async () => {
    input.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, Number(input.value));
      output.textContent = displayValue(input.value);
    } catch (error) {
      toast(`设置失败：${error}`, true);
    } finally {
      input.disabled = false;
    }
  };
  row.append(head, input);
  return row;
}

function detailSegments(device, def) {
  const row = el('div', 'detail-segments');
  row.append(el('span', 'detail-control-label', uiText(def.label)));
  const group = el('div', 'detail-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', `detail-segment${String(current) === String(value) ? ' active' : ''}`, uiText(label));
    button.type = 'button';
    button.disabled = !device.online;
    button.onclick = async () => {
      try {
        await setCardProp(device, def.siid, def.piid, value);
        renderInspector(device);
      } catch (error) {
        toast(`设置失败：${error}`, true);
      }
    };
    group.append(button);
  }
  row.append(group);
  return row;
}

function detailControl(device, def) {
  if (def.type === 'toggle') return detailToggle(device, def);
  if (def.type === 'range') return detailRange(device, def);
  if (def.type === 'segments') return detailSegments(device, def);
  return null;
}

function detailAction(device) {
  const kind = deviceKind(device);
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    const button = el('button', 'detail-action', '查看实时画面');
    button.type = 'button';
    button.onclick = async () => { await showCameras(); await startRemoteCamera(device); };
    return button;
  }
  if (kind === 'router') {
    if (!hasSpecAction(device, 2, 1)) return null;
    const button = el('button', 'detail-action danger', '重启路由器');
    button.type = 'button';
    button.onclick = async () => {
      if (!confirm(`重启「${device.name}」？网络会中断约 1 分钟。`)) return;
      button.disabled = true;
      button.textContent = '正在发送…';
      try {
        await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
        toast('重启指令已发送');
      } catch (error) {
        toast(`重启失败：${error}`, true);
      } finally {
        button.disabled = false;
        button.textContent = '重启路由器';
      }
    };
    return button;
  }
  return null;
}

function detailSpecActions(device, profile, speakerShown = false) {
  const kind = deviceKind(device);
  const transport = speakerShown ? new Set(speakerActions(profile).transport) : new Set();
  const actions = (profile.actions || []).filter((action) =>
    !((kind === 'router' || kind === 'tv') && action.siid === 2 && action.aiid === 1)
    && ![...transport].some((item) => item.siid === action.siid && item.aiid === action.aiid));
  if (!actions.length) return null;
  const section = el('section', 'detail-section');
  section.append(el('h4', '', '设备动作'));
  const list = el('div', 'detail-actions');
  for (const action of actions) {
    const button = el('button', 'detail-action secondary', uiText(action.label));
    button.type = 'button';
    button.disabled = !device.online;
    button.onclick = async () => {
      if (!confirm(MihomeI18n?.t('执行「{0}」？', uiText(action.label)) || `执行「${action.label}」？`)) return;
      button.disabled = true;
      try {
        await invoke('call_action', {
          did: device.did, siid: action.siid, aiid: action.aiid, params: [],
        });
        toast(MihomeI18n?.t('已执行：{0}', uiText(action.label)) || `已执行：${action.label}`);
      } catch (error) {
        toast(`动作失败：${error}`, true);
      } finally {
        button.disabled = !device.online;
      }
    };
    list.append(button);
  }
  section.append(list);
  return section;
}

function tvActionButton(device, label, siid, aiid, className = '') {
  const button = el('button', `tv-key ${className}`.trim());
  button.type = 'button';
  button.textContent = label;
  const available = hasSpecAction(device, siid, aiid);
  button.disabled = !device.online || !available;
  button.hidden = !available;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.onclick = async () => {
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid, aiid, params: [] });
      toast(`已发送：${label}`);
    } catch (error) {
      toast(`操作失败：${error}`, true);
    } finally {
      button.disabled = !device.online;
    }
  };
  return button;
}

function detailTvRemote(device) {
  const section = el('section', 'detail-section tv-section');
  section.append(el('h4', '', '遥控'));
  const remote = el('div', 'tv-remote');
  const top = el('div', 'tv-remote-top');
  const power = el('button', `tv-power ${device.online ? 'on' : 'off'}`);
  power.type = 'button';
  power.hidden = !hasSpecAction(device, 2, 1);
  power.title = device.online ? '关机' : '电视离线，暂不支持远程开机';
  power.setAttribute('aria-label', power.title);
  power.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  power.onclick = async () => {
    if (!device.online) {
      toast('电视当前离线，暂不支持远程开机；先用电视遥控开机。');
      return;
    }
    power.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('已发送关机指令，几秒后电视会下线。');
      setTimeout(() => refreshAfterTvPower(device), 5000);
    } catch (error) {
      toast(`关机指令失败：${error}`, true);
    } finally {
      power.disabled = false;
    }
  };
  const volume = el('div', 'tv-volume');
  volume.append(tvActionButton(device, '−', 7, 11, 'tv-small'), el('span', 'tv-volume-label', '音量'), tvActionButton(device, '+', 7, 12, 'tv-small'));
  top.append(power, volume);
  remote.append(top);

  const dpad = el('div', 'tv-dpad');
  dpad.append(tvActionButton(device, '↑', 7, 8, 'tv-dir tv-up'));
  dpad.append(tvActionButton(device, '←', 7, 6, 'tv-dir tv-left'));
  dpad.append(tvActionButton(device, 'OK', 7, 10, 'tv-ok'));
  dpad.append(tvActionButton(device, '→', 7, 7, 'tv-dir tv-right'));
  dpad.append(tvActionButton(device, '↓', 7, 9, 'tv-dir tv-down'));
  remote.append(dpad);

  const bottom = el('div', 'tv-remote-bottom');
  bottom.append(
    tvActionButton(device, '⌂', 7, 2, 'tv-small'),
    tvActionButton(device, '↩', 7, 5, 'tv-small'),
    tvActionButton(device, '☰', 7, 3, 'tv-small'),
    tvActionButton(device, '⚙', 7, 4, 'tv-small')
  );
  remote.append(bottom);

  const extra = el('div', 'tv-extra');
  extra.append(
    tvActionButton(device, '播放', 3, 1),
    tvActionButton(device, '暂停', 3, 2),
    tvActionButton(device, '播放/暂停', 7, 13),
    tvActionButton(device, '截图', 7, 17)
  );
  remote.append(extra);
  section.append(remote);
  return section;
}

// Cloud statistics for energy-metering devices. The cloud keeps one record per
// day or month; ranges are aligned to local midnight / month start so each bar
// matches what the official app shows for that period.
const STATS_RANGES = {
  '7d': { label: '7 天', type: 'stat_day_v3', count: 7, unit: 'day' },
  '30d': { label: '30 天', type: 'stat_day_v3', count: 30, unit: 'day' },
  '12m': { label: '12 个月', type: 'stat_month_v3', count: 12, unit: 'month' },
};
const STATS_CACHE_MS = 10 * 60 * 1000;
const statsInflight = new Map();

function statsSlots(rangeId, now = new Date()) {
  const range = STATS_RANGES[rangeId] || STATS_RANGES['7d'];
  const slots = [];
  for (let offset = range.count - 1; offset >= 0; offset -= 1) {
    const start = range.unit === 'month'
      ? new Date(now.getFullYear(), now.getMonth() - offset, 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    slots.push(start);
  }
  return slots;
}

function statsSlotKey(date, unit) {
  return unit === 'month'
    ? `${date.getFullYear()}-${date.getMonth()}`
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatStatValue(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return Number(value.toFixed(digits)).toLocaleString(window.MihomeI18n?.locale || undefined);
}

async function loadDeviceStatistics(device, stat, rangeId, { force = false } = {}) {
  const range = STATS_RANGES[rangeId] || STATS_RANGES['7d'];
  const cacheKey = `${state.accountGeneration}|${device.did}|${stat.key}|${rangeId}`;
  const cached = state.statsCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < STATS_CACHE_MS) return cached.points;
  const slots = statsSlots(rangeId);
  const query = {
    did: device.did,
    key: stat.key,
    data_type: range.type,
    time_start: Math.floor(slots[0].getTime() / 1000),
    time_end: Math.floor(Date.now() / 1000) + 60,
    limit: range.count,
  };
  // The inspector renders twice while it loads properties; both renders share
  // one request instead of asking the cloud twice.
  if (statsInflight.has(cacheKey)) return statsInflight.get(cacheKey);
  const request = invoke('device_statistics', { query })
    .then((points) => {
      const list = Array.isArray(points) ? points : [];
      state.statsCache.set(cacheKey, { at: Date.now(), points: list });
      if (state.statsCache.size > 200) state.statsCache.delete(state.statsCache.keys().next().value);
      return list;
    })
    .finally(() => statsInflight.delete(cacheKey));
  statsInflight.set(cacheKey, request);
  return request;
}

function renderStatsChart(body, stat, rangeId, points) {
  const range = STATS_RANGES[rangeId] || STATS_RANGES['7d'];
  const slots = statsSlots(rangeId);
  const values = new Map();
  for (const point of points) {
    const key = statsSlotKey(new Date(point.time * 1000), range.unit);
    values.set(key, (values.get(key) || 0) + Number(point.value || 0));
  }
  const bars = slots.map((date) => ({ date, value: values.get(statsSlotKey(date, range.unit)) }));
  const recorded = bars.filter((bar) => Number.isFinite(bar.value));
  body.replaceChildren();
  if (!recorded.length) {
    body.append(el('p', 'stats-empty', '这段时间没有用电记录'));
    return;
  }
  const total = recorded.reduce((sum, bar) => sum + bar.value, 0);
  const unit = stat.unit ? ` ${stat.unit}` : '';
  const summary = el('div', 'stats-summary');
  const totalBox = el('div', 'stats-figure');
  totalBox.append(el('span', '', '合计'), el('strong', '', `${formatStatValue(total)}${unit}`));
  const averageBox = el('div', 'stats-figure');
  averageBox.append(
    el('span', '', range.unit === 'month' ? '月均' : '日均'),
    el('strong', '', `${formatStatValue(total / recorded.length)}${unit}`),
  );
  summary.append(totalBox, averageBox);
  const max = Math.max(...recorded.map((bar) => bar.value), 0);
  const locale = window.MihomeI18n?.locale || undefined;
  const dayFormat = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short' });
  const chart = el('div', `stats-chart${bars.length > 12 ? ' dense' : ''}`);
  chart.setAttribute('role', 'img');
  bars.forEach((bar, index) => {
    const column = el('div', 'stats-bar');
    const label = range.unit === 'month' ? monthFormat.format(bar.date) : dayFormat.format(bar.date);
    const valueText = Number.isFinite(bar.value) ? `${formatStatValue(bar.value)}${unit}` : '—';
    column.title = `${label} · ${valueText}`;
    const fill = el('span', `stats-fill${Number.isFinite(bar.value) ? '' : ' missing'}`);
    fill.style.height = Number.isFinite(bar.value) && max > 0
      ? `${Math.max(2, Math.round((bar.value / max) * 100))}%`
      : '2%';
    column.append(fill);
    // Thirty daily bars only label every fifth day to keep the axis legible.
    const showLabel = bars.length <= 12 || index % 5 === (bars.length - 1) % 5;
    column.append(el('small', 'stats-label', showLabel ? label : ''));
    chart.append(column);
  });
  chart.setAttribute('aria-label', bars.map((bar, index) => chart.children[index].title).join('，'));
  body.append(summary, chart);
}

function detailStatistics(device, profile) {
  const stat = profile.statistics?.[0];
  if (!stat) return null;
  const section = el('section', 'detail-section stats-section');
  const head = el('div', 'stats-head');
  head.append(el('h4', '', '用电统计'));
  const tabs = el('div', 'stats-tabs');
  tabs.setAttribute('role', 'tablist');
  head.append(tabs);
  const body = el('div', 'stats-body');
  section.append(head, body);
  const request = { id: 0 };
  const show = async (rangeId, options = {}) => {
    state.statsRange = rangeId;
    localStorage.setItem('mihome-stats-range', rangeId);
    for (const tab of tabs.children) {
      const active = tab.dataset.range === rangeId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    const id = ++request.id;
    body.replaceChildren(el('p', 'stats-empty', '正在读取用电记录…'));
    try {
      const points = await loadDeviceStatistics(device, stat, rangeId, options);
      if (id !== request.id || !section.isConnected) return;
      renderStatsChart(body, stat, rangeId, points);
    } catch (error) {
      if (id !== request.id || !section.isConnected) return;
      const failure = el('div', 'stats-error');
      failure.append(el('span', '', `读取失败：${error}`));
      const retry = el('button', 'stats-retry', '重试');
      retry.type = 'button';
      retry.onclick = () => show(rangeId, { force: true });
      failure.append(retry);
      body.replaceChildren(failure);
    }
  };
  for (const [rangeId, range] of Object.entries(STATS_RANGES)) {
    const tab = el('button', 'stats-tab', range.label);
    tab.type = 'button';
    tab.dataset.range = rangeId;
    tab.setAttribute('role', 'tab');
    tab.onclick = () => show(rangeId);
    tabs.append(tab);
  }
  show(STATS_RANGES[state.statsRange] ? state.statsRange : '7d');
  return section;
}

// Xiao AI speakers declare `execute-text-directive` (text + silent flag) and
// `play-text` (text) in their intelligent-speaker service. Both take inputs,
// so the generic action list skips them; this panel fills them in.
const SPEAKER_TRANSPORT = [
  ['previous', 'prev', '上一首'],
  ['play', 'play', '播放'],
  ['pause', 'pause', '暂停'],
  ['stop', 'stop', '停止'],
  ['next', 'next', '下一首'],
];

function speakerActions(profile) {
  const textAction = (name) => profile.inputActions?.find((action) =>
    action.name === name && action.inputs.some((input) => input.format === 'string'));
  const transport = SPEAKER_TRANSPORT
    .map(([name, iconName, label]) => {
      const action = profile.actions?.find((item) => item.service === 'play-control' && item.name === name);
      return action && { ...action, iconName, label };
    })
    .filter(Boolean);
  return { directive: textAction('execute-text-directive'), speak: textAction('play-text'), transport };
}

function actionInputs(action, text, silent) {
  return action.inputs.map((input) => {
    if (input.format === 'string') return text;
    if (input.format === 'bool') return Boolean(silent);
    return 0;
  });
}

function detailSpeaker(device, profile) {
  const { directive, speak, transport } = speakerActions(profile);
  if (!directive && !speak && !transport.length) return null;
  const section = el('section', 'detail-section speaker-section');
  section.append(el('h4', '', '小爱同学'));
  if (transport.length) {
    const row = el('div', 'speaker-transport');
    for (const action of transport) {
      const button = el('button', 'speaker-key');
      button.type = 'button';
      button.innerHTML = uiIcon(action.iconName);
      button.title = action.label;
      button.setAttribute('aria-label', action.label);
      button.disabled = !device.online;
      button.onclick = async () => {
        button.disabled = true;
        try {
          await invoke('call_action', { did: device.did, siid: action.siid, aiid: action.aiid, params: [] });
        } catch (error) {
          toast(`操作失败：${error}`, true);
        } finally {
          button.disabled = !device.online;
        }
      };
      row.append(button);
    }
    section.append(row);
  }
  if (directive || speak) {
    const form = el('form', 'speaker-form');
    const input = el('input', 'speaker-input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = directive ? '让小爱执行，例如：打开客厅灯' : '输入要播报的文字';
    input.setAttribute('aria-label', input.placeholder);
    input.disabled = !device.online;
    const buttons = el('div', 'speaker-buttons');
    const silentInput = directive?.inputs.some((item) => item.format === 'bool');
    let silentBox = null;
    if (silentInput) {
      const label = el('label', 'speaker-silent');
      silentBox = el('input');
      silentBox.type = 'checkbox';
      silentBox.checked = localStorage.getItem('mihome-speaker-silent') === '1';
      silentBox.disabled = !device.online;
      silentBox.onchange = () => localStorage.setItem('mihome-speaker-silent', silentBox.checked ? '1' : '0');
      label.append(silentBox, el('span', '', '不出声'));
      buttons.append(label);
    }
    const send = async (action, button) => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      for (const item of form.querySelectorAll('button, input')) item.disabled = true;
      try {
        await invoke('call_action', {
          did: device.did,
          siid: action.siid,
          aiid: action.aiid,
          params: actionInputs(action, text, silentBox?.checked),
        });
        toast(MihomeI18n?.t('已发送给{0}', device.name) || `已发送给${device.name}`);
        input.value = '';
      } catch (error) {
        toast(`发送失败：${error}`, true);
      } finally {
        for (const item of form.querySelectorAll('button, input')) item.disabled = !device.online;
        if (button === document.activeElement || !document.activeElement) input.focus();
      }
    };
    if (speak) {
      const speakButton = el('button', 'speaker-send secondary', '播报');
      speakButton.type = 'button';
      speakButton.disabled = !device.online;
      speakButton.onclick = () => send(speak, speakButton);
      buttons.append(speakButton);
    }
    if (directive) {
      const runButton = el('button', 'speaker-send', '执行');
      runButton.type = 'submit';
      runButton.disabled = !device.online;
      buttons.append(runButton);
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      send(directive || speak, form.querySelector('button[type="submit"]') || null);
    };
    input.addEventListener('keydown', (event) => {
      // Enter that confirms an IME candidate must not send the text.
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    if (!directive) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          send(speak, null);
        }
      });
    }
    form.append(input, buttons);
    section.append(form);
  }
  return section;
}

function renderInspector(device, error, loading = false) {
  const box = $('#inspector');
  const profile = inspectorProfile(device);
  const kind = deviceKind(device);
  const family = window.MiIcons.familyFor(kind);
  box.replaceChildren();
  box.scrollTop = 0;
  box.classList.add('open');
  box.setAttribute('aria-hidden', 'false');

  const head = el('div', 'detail-head');
  const icon = el('span', 'detail-icon');
  icon.dataset.family = family;
  icon.innerHTML = deviceGlyph(device);
  head.append(icon);
  const heading = el('div', 'detail-heading');
  heading.append(el('h3', '', device.name));
  const sub = el('p', 'detail-sub');
  sub.append(el('span', '', roomName(device)));
  sub.append(el('span', 'detail-dot', '·'));
  sub.append(el('span', `detail-online ${device.online ? 'on' : ''}`, device.online ? '在线' : '离线'));
  heading.append(sub);
  head.append(heading);
  const close = el('button', 'insp-close');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭详情');
  close.innerHTML = uiIcon('close');
  close.onclick = closeInspector;
  head.append(close);
  box.append(head);

  if (error) box.append(el('p', 'detail-error', `读取设备状态失败：${error}`));
  else if (loading) box.append(el('p', 'detail-loading', '正在读取设备状态…'));

  const metrics = profile.metrics.filter((item) => !item.secondary || item.label === '电量' || kind === 'door-lock');
  if (metrics.length) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', '状态'));
    const grid = el('div', 'detail-metrics');
    for (const def of metrics) grid.append(detailMetric(cardValue(device, def.siid, def.piid), def));
    section.append(grid);
    box.append(section);
  }

  if (profile.note) box.append(el('p', 'detail-note', profile.note));

  if (kind === 'tv' && specFor(device)) box.append(detailTvRemote(device));
  const speaker = detailSpeaker(device, profile);
  if (speaker) box.append(speaker);
  const statistics = detailStatistics(device, profile);
  if (statistics) box.append(statistics);

  const groups = new Map();
  for (const def of profile.controls) {
    const group = def.group || '控制';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(def);
  }
  for (const [name, items] of groups) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', uiText(name)));
    for (const def of items) {
      const control = detailControl(device, def);
      if (control) section.append(control);
    }
    box.append(section);
  }

  const action = detailAction(device);
  if (action) {
    const section = el('section', 'detail-section');
    section.append(action);
    box.append(section);
  }
  const specActions = detailSpecActions(device, profile, Boolean(speaker));
  if (specActions) box.append(specActions);

  if (!metrics.length && !profile.controls.length && !action && !specActions && !speaker && !statistics) {
    box.append(el('p', 'detail-empty', device.online ? '这台设备当前没有可读写的属性。' : '设备离线，暂时读不到状态。'));
  }

}

function closeInspector() {
  state.selected = null;
  state.inspectorRequest += 1;
  const box = $('#inspector');
  box.classList.remove('open');
  box.setAttribute('aria-hidden', 'true');
  box.replaceChildren();
  for (const row of document.querySelectorAll('.device-row.active')) row.classList.remove('active');
}

async function setPower(device, value) {
  try {
    await setCardProp(device, 2, 1, value);
    renderInspector(device);
  } catch (error) {
    renderInspector(device, String(error));
  }
}

async function showDevices() {
  await stopCamera();
  showView('devices');
  renderDevices();
  renderSidebarRooms();
  updateChrome();
}

async function showOverview() {
  if (!state.loggedIn) return;
  await stopCamera();
  showView('overview');
  renderSidebarRooms();
  renderOverview();
  updateChrome();
}

function sceneTone(index) {
  return ['amber', 'ink', 'blue', 'dusk'][index % 4];
}

function sceneIcon(name) {
  const text = String(name);
  const kind = /夜|晚安|睡眠/.test(text) ? 'night-light' : /影|电视|观影|影音/.test(text) ? 'tv' : /帘|窗/.test(text) ? 'curtain' : /离家|外出|离开/.test(text) ? 'smart-button' : 'light';
  const body = DEVICE_ICONS[kind] || DEVICE_ICONS.generic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function sceneListHTML() {
  if (!state.scenes.length) {
    return `<div class="empty">还没有手动场景。先在米家 App 的“智能 → 手动控制”里创建一个。</div>`;
  }
  return state.scenes
    .map((scene, index) => {
      const tone = sceneTone(index);
      const icon = sceneIcon(scene.name);
      return `<article class="scene-card" data-tone="${tone}">
        <div class="scene-art"><span class="orb a"></span><span class="orb b"></span><span class="orb c"></span><span class="sc-ic">${icon}</span><span class="sc-time">手动场景</span></div>
        <div class="scene-info">
          <div class="txt"><strong>${esc(scene.name)}</strong><small>${scene.id ? `ID ${esc(String(scene.id).slice(0, 12))}` : '手动场景'}</small></div>
          <button class="run-btn" data-run-scene="${esc(scene.id)}">${uiIcon('play')} 执行</button>
        </div>
      </article>`;
    })
    .join('');
}

async function loadScenes() {
  if (!state.homeId) return;
  const request = ++state.scenesRequest;
  const homeId = state.homeId;
  const box = $('#sceneList');
  state.scenes = [];
  setNavCount('sceneCount', 0);
  box.innerHTML = '<div class="empty">读取场景…</div>';
  try {
    const scenes = await invoke('list_scenes', { homeId });
    if (request !== state.scenesRequest || homeId !== state.homeId) return;
    state.scenes = scenes;
    setNavCount('sceneCount', state.scenes.length);
    box.innerHTML = sceneListHTML();
    if (state.page === 'overview') renderOverview(true);
  } catch (error) {
    if (request !== state.scenesRequest || homeId !== state.homeId) return;
    box.innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showScenes() {
  if (!state.loggedIn) return;
  await stopCamera();
  showView('scenes');
  await loadScenes();
}

function fillSceneSelect() {
  const select = $('#autoScene');
  if (!select) return;
  select.innerHTML = state.scenes.length
    ? state.scenes.map((scene) => `<option value="${esc(scene.id)}">${esc(scene.name)}</option>`).join('')
    : '<option value="">没有手动场景</option>';
  select.disabled = !state.scenes.length;
}

function renderAutomations() {
  const box = $('#autoList');
  if (!state.automations.length) {
    box.innerHTML = '<div class="empty">还没有定时任务。选一个时间，绑一个手动场景。</div>';
    return;
  }
  const dayNames = MihomeI18n?.weekdayNames?.() || ['一', '二', '三', '四', '五', '六', '日'];
  box.innerHTML = state.automations.map((item) => {
    const days = item.days.map((day) => dayNames[day - 1] || '').join('、');
    const sceneName = state.scenes.find((scene) => scene.id === item.scene_id)?.name || item.scene_id;
    return `<article class="auto-row">
      <time>${esc(item.time)}</time>
      <div class="auto-body"><div class="auto-name">${esc(item.name)}</div><div class="auto-target">${days} · ${esc(sceneName)}</div></div>
      <span class="auto-days">${days}</span>
      <label class="switch ${item.enabled ? 'on' : ''}"><input type="checkbox" data-toggle-auto="${esc(item.id)}" ${item.enabled ? 'checked' : ''}><span></span></label>
      <button class="ghost-btn" data-delete-auto="${esc(item.id)}">删除</button>
    </article>`;
  }).join('');
}

async function loadAutomations() {
  const request = ++state.automationsRequest;
  const generation = state.accountGeneration;
  try {
    const automations = await invoke('list_automations');
    if (request !== state.automationsRequest || generation !== state.accountGeneration) return;
    state.automations = automations;
    setNavCount('automationCount', state.automations.length);
    renderAutomations();
    if (state.page === 'overview') renderOverview(true);
  } catch (error) {
    if (request !== state.automationsRequest || generation !== state.accountGeneration) return;
    $('#autoList').innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showAutomations() {
  if (!state.loggedIn) return;
  await stopCamera();
  showView('automations');
  await loadScenes();
  fillSceneSelect();
  await loadAutomations();
}

async function showCameras() {
  if (!state.loggedIn) return;
  showView('camera');
  await loadCameras({ background: true });
}

async function showSettings() {
  await stopCamera();
  showView('settings');
  updateSettingsSelection();
  refreshQuickPrefsLabels();
}

// ---------- 菜单栏面板的常用设备与场景 ----------

const QUICK_DEVICE_LIMIT = 12;
const QUICK_SCENE_LIMIT = 3;

function quickPickLayer() {
  return $('#quickPickLayer');
}

// 设备与场景都从后端现取：设置页可能先于「设备」页打开，缓存的列表可能是别的
// 家庭或还没读过。
async function quickPickListing(kind) {
  if (!state.homeId) return [];
  const searchable = window.MiPinyin?.searchable;
  if (kind === 'scenes') {
    const scenes = await invoke('list_scenes', { homeId: state.homeId });
    return (Array.isArray(scenes) ? scenes : []).map((scene) => ({
      id: scene.id,
      name: scene.name,
      meta: '手动场景',
      search: searchable ? searchable([scene.name]) : String(scene.name).toLowerCase(),
    }));
  }
  const devices = await invoke('list_devices', { homeId: state.homeId });
  return (Array.isArray(devices) ? devices : []).map((device) => ({
    id: device.did,
    name: device.name,
    meta: device.online ? '在线' : '离线',
    search: searchable
      ? searchable([device.name, device.model || '', roomName(device)])
      : `${device.name} ${device.model || ''} ${roomName(device)}`.toLowerCase(),
  }));
}

function quickPickLimit(kind) {
  return kind === 'scenes' ? QUICK_SCENE_LIMIT : QUICK_DEVICE_LIMIT;
}

function renderQuickPickList() {
  const list = $('#quickPickList');
  const { kind, listing, selected } = state.quickPick;
  const limit = quickPickLimit(kind);
  list.replaceChildren();
  if (!listing.length) {
    list.append(el('div', 'quick-pick-empty', kind === 'scenes' ? '当前家庭还没有手动场景' : '还没有读取到设备'));
    $('#quickPickCount').textContent = '';
    return;
  }
  const query = state.quickPick.query.trim().toLowerCase();
  const visible = query
    ? listing.filter((item) => (item.search || item.name.toLowerCase()).includes(query))
    : listing;
  if (!visible.length) {
    list.append(el('div', 'quick-pick-empty', '没有匹配的设备或操作'));
  }
  const chosen = new Set(selected);
  for (const item of visible) {
    const checked = chosen.has(item.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-pick-item';
    button.setAttribute('role', 'checkbox');
    button.setAttribute('aria-checked', String(checked));
    // 选满后其余项不可再选，避免点了没反应。
    button.setAttribute('aria-disabled', String(!checked && selected.length >= limit));
    button.innerHTML = `<span class="pick-mark">✓</span>
      <span class="pick-name">${esc(item.name)}</span>
      <span class="pick-meta">${esc(item.meta || '')}</span>`;
    button.onclick = () => {
      const index = state.quickPick.selected.indexOf(item.id);
      if (index >= 0) state.quickPick.selected.splice(index, 1);
      else if (state.quickPick.selected.length < limit) state.quickPick.selected.push(item.id);
      else return;
      renderQuickPickList();
    };
    list.append(button);
  }
  const full = selected.length >= limit;
  $('#quickPickCount').textContent = full
    ? `已选 ${selected.length}/${limit}，最多 ${limit} 个`
    : `已选 ${selected.length}/${limit}`;
}

async function openQuickPick(kind) {
  if (!state.loggedIn) {
    toast('先登录米家账号再挑选');
    return;
  }
  const layer = quickPickLayer();
  const title = $('#quickPickTitle');
  title.textContent = kind === 'scenes' ? '选择常用场景' : '选择常用设备';
  $('#quickPickList').innerHTML = '<div class="quick-pick-empty">正在读取…</div>';
  layer.hidden = false;
  state.quickPick.kind = kind;
  state.quickPick.saving = false;
  state.quickPick.query = '';
  $('#quickPickSearch').value = '';
  try {
    const [prefs, listing] = await Promise.all([
      invoke('quick_prefs'),
      quickPickListing(kind),
    ]);
    if (layer.hidden) return;
    const saved = kind === 'scenes' ? prefs?.scenes : prefs?.devices;
    // 只保留仍在当前家庭里的条目，免得已删除的设备占着格子。
    const known = new Set(listing.map((item) => item.id));
    state.quickPick.listing = listing;
    state.quickPick.selected = (Array.isArray(saved) ? saved : []).filter((id) => known.has(id));
    renderQuickPickList();
  } catch (error) {
    if (layer.hidden) return;
    $('#quickPickList').innerHTML = `<div class="quick-pick-empty">读取失败：${esc(String(error))}</div>`;
  }
}

function closeQuickPick() {
  quickPickLayer().hidden = true;
  state.quickPick.saving = false;
  state.quickPick.query = '';
}

async function saveQuickPick() {
  if (state.quickPick.saving) return;
  const button = $('#quickPickSave');
  state.quickPick.saving = true;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const next = await invoke('quick_prefs');
    const payload = {
      devices: Array.isArray(next?.devices) ? next.devices : [],
      scenes: Array.isArray(next?.scenes) ? next.scenes : [],
    };
    payload[state.quickPick.kind] = state.quickPick.selected;
    await invoke('save_quick_prefs', payload);
    closeQuickPick();
    toast('菜单栏面板已更新');
    refreshQuickPrefsLabels();
  } catch (error) {
    toast(String(error), true);
  } finally {
    state.quickPick.saving = false;
    button.disabled = false;
    button.textContent = '保存';
  }
}

// 设置页上的按钮直接显示已选数量，不用点进去才知道有没有配过。
async function refreshQuickPrefsLabels() {
  const devices = $('#settingsQuickDevices');
  const scenes = $('#settingsQuickScenes');
  if (!devices || !scenes) return;
  if (!state.loggedIn) {
    devices.textContent = '选择';
    scenes.textContent = '选择';
    return;
  }
  try {
    const prefs = await invoke('quick_prefs');
    const deviceCount = Array.isArray(prefs?.devices) ? prefs.devices.length : 0;
    const sceneCount = Array.isArray(prefs?.scenes) ? prefs.scenes.length : 0;
    devices.textContent = deviceCount ? `已选 ${deviceCount} 个` : '选择';
    scenes.textContent = sceneCount ? `已选 ${sceneCount} 个` : '选择';
  } catch (_) {
    devices.textContent = '选择';
    scenes.textContent = '选择';
  }
}

function accessPlatformConfig(snapshot = state.access.snapshot) {
  return snapshot?.settings?.[state.access.platform] || {};
}

function fillAccessHomes() {
  const select = $('#pairHome');
  if (!select) return;
  const current = select.value || state.homeId;
  select.innerHTML = state.homes.length
    ? state.homes.map((home) => `<option value="${esc(home.id)}">${esc(home.name)}</option>`).join('')
    : '<option value="">请先登录米家账号</option>';
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function setSignal(id, stateName, text) {
  const node = $('#' + id);
  if (!node) return;
  node.classList.remove('good', 'warn', 'bad');
  if (stateName) node.classList.add(stateName);
  const label = node.querySelector('strong');
  if (label) label.textContent = text;
}

const accessPlatforms = {
  feishu: {
    label: '飞书',
    idLabel: 'App ID',
    secretLabel: 'App Secret',
    idPlaceholder: 'cli_xxxxxxxxxxxxxxxx',
    secretPlaceholder: 'App Secret',
    docs: 'https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN',
  },
  wecom: {
    label: '企业微信',
    idLabel: 'Bot ID',
    secretLabel: 'Bot Secret',
    idPlaceholder: '企业微信智能机器人 Bot ID',
    secretPlaceholder: '企业微信智能机器人 Secret',
    docs: 'https://developer.work.weixin.qq.com/document/path/101463',
  },
  dingtalk: {
    label: '钉钉',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    idPlaceholder: '钉钉应用 Client ID（原 AppKey）',
    secretPlaceholder: '钉钉应用 Client Secret（原 AppSecret）',
    docs: 'https://open.dingtalk.com/document/orgapp/stream',
  },
};

function accessPlatformLabel(platform) {
  return accessPlatforms[platform]?.label || platform;
}

function platformCredentialAdvice(platform) {
  if (platform === 'wecom') {
    return '确认 Bot ID 和 Bot Secret 属于同一个智能机器人，并在企业微信后台开启 API 接收消息。';
  }
  if (platform === 'dingtalk') {
    return '确认 Client ID 和 Client Secret 属于同一个企业内部应用，机器人能力已添加，应用已发布且当前登录用户在可用范围内。';
  }
  return '确认 App ID 和 App Secret 属于同一个飞书应用，机器人能力与消息权限已发布，当前登录用户在应用可用范围内。';
}

function platformErrorAdvice(platform, error) {
  const text = String(error || '').toLowerCase();
  if (!text) return null;
  if (/heartbeat|timed out|timeout|超时/.test(text)) {
    return {
      title: '长连接心跳超时',
      hint: '电脑可能刚唤醒或网络已经切换。先检查网络和代理，再点“重新连接”；反复失败时重新保存一次凭据。',
    };
  }
  if (/401|403|unauthorized|forbidden|invalid.*(app|credential|secret)|authentication|auth failed|认证失败|凭据/.test(text)) {
    return {
      title: '凭据或应用权限校验失败',
      hint: platformCredentialAdvice(platform),
    };
  }
  if (/permission|scope|not published|not available|权限|发布|可用范围/.test(text)) {
    return {
      title: '应用权限尚未生效',
      hint: '检查事件订阅、机器人能力和消息权限是否已申请通过；修改权限后需要重新发布应用。',
    };
  }
  if (/websocket|handshake|connection refused|network|dns|tls|certificate|connect|连接/.test(text)) {
    return {
      title: '暂时无法建立安全连接',
      hint: '检查本机网络、DNS 和代理设置，确认没有拦截 WebSocket；恢复网络后再点“重新连接”。',
    };
  }
  if (/replaced|替换/.test(text)) {
    return {
      title: '连接已被新会话替换',
      hint: '同一套凭据可能正在另一台电脑上运行。关闭另一台电脑的连接，或在这里重新连接。',
    };
  }
  return {
    title: '平台连接未就绪',
    hint: '保留上方原始错误，检查网络和应用配置后重新连接；仍失败时重新保存凭据以刷新连接。',
  };
}

function accessConnectionGuidance({ platform, websocketMode, enabled, configured, gateway, connection }) {
  if (!enabled) return null;
  if (!websocketMode) {
    if (!gateway?.running) {
      return {
        title: '本地网关未启动',
        hint: '先启动本地网关，再把公网 HTTPS 隧道映射到同一个端口。',
      };
    }
    if (!configured) {
      return {
        title: '应用凭据不完整',
        hint: '补齐 App ID、Secret 和 Verification Token 后保存并启用。',
      };
    }
    return null;
  }
  if (connection?.last_error) {
    return platformErrorAdvice(platform, connection.last_error);
  }
  if (connection?.state === 'replaced') {
    return platformErrorAdvice(platform, 'replaced');
  }
  return null;
}

function webhookCallbackUrl(baseUrl, platform) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/v1/platform/${platform}`;
}

function renderAccessBindings(settings) {
  const box = $('#accessBindings');
  if (!box) return;
  const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
  if (!bindings.length) {
    box.innerHTML = '<div class="empty compact-empty">还没有已绑定的平台会话</div>';
    return;
  }
  const homeNames = new Map(state.homes.map((home) => [home.id, home.name]));
  box.innerHTML = bindings.map((binding) => {
    const createdAt = binding.created_at
      ? new Date(binding.created_at * 1000).toLocaleString(uiLocale(), { hour12: false })
      : '未知';
    return `<div class="binding-row">
      <span class="binding-platform">${esc(uiText(accessPlatformLabel(binding.platform)))}</span>
      <strong>${esc(homeNames.get(binding.home_id) || binding.home_id)}</strong>
      <small>${esc(binding.chat_id_masked || '')} · ${esc(createdAt)}</small>
      <button type="button" data-revoke-binding="${esc(binding.id)}">解除</button>
    </div>`;
  }).join('');
}

function renderAccessPairing(settings, hydrate) {
  const platform = state.access.platform;
  if (hydrate || !state.access.pairing) {
    const active = (settings?.active_pairing_codes || [])
      .find((pairing) => pairing.platform === platform);
    state.access.pairing = active || state.access.pairing;
    if (state.access.pairing?.platform !== platform) state.access.pairing = null;
  }
  const pairing = state.access.pairing;
  const value = $('#pairCodeValue');
  const command = $('#pairCommand');
  const hint = $('#pairCodeHint');
  if (!pairing) {
    value.textContent = '------';
    command.textContent = '配对 ------';
    hint.textContent = '尚未生成配对码';
    return;
  }
  value.textContent = pairing.code;
  command.textContent = `配对 ${pairing.code}`;
  updatePairingCountdown();
}

function updatePairingCountdown() {
  const pairing = state.access.pairing;
  if (!pairing) return;
  const remaining = Math.max(0, Number(pairing.expires_at || 0) - Math.floor(Date.now() / 1000));
  const hint = $('#pairCodeHint');
  if (hint) {
    hint.textContent = remaining > 0
      ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} 后过期 · 单次有效`
      : '已过期，请重新生成';
  }
  if (remaining <= 0) {
    state.access.pairing = null;
    const value = $('#pairCodeValue');
    const command = $('#pairCommand');
    if (value) value.textContent = '------';
    if (command) command.textContent = '配对 ------';
  }
}

function renderAccess(snapshot, hydrate = false) {
  if (snapshot) state.access.snapshot = snapshot;
  snapshot = state.access.snapshot;
  const settings = snapshot?.settings || {};
  const gateway = snapshot?.gateway || {};
  const connections = snapshot?.connections || {};
  const platform = accessPlatformConfig(snapshot);
  const platformName = uiText(accessPlatformLabel(state.access.platform));
  const platformKey = state.access.platform;
  const platformMeta = accessPlatforms[platformKey] || accessPlatforms.feishu;
  const mode = state.access.draftMode || platform.mode || 'websocket';
  const websocketMode = mode === 'websocket';
  const connection = websocketMode ? (connections[`${platformKey}_ws`] || {}) : {};
  const feishu = settings.feishu || {};
  const wecom = settings.wecom || {};
  const dingtalk = settings.dingtalk || {};
  const stateLabels = {
    connected: '已连接', connecting: '连接中', reconnecting: '重连中',
    error: '连接失败', replaced: '已被新连接替换', stopped: '未启动',
  };
  const connectionState = connection.state || 'stopped';
  const connectionLabel = stateLabels[connectionState] || connectionState;

  $('#accessConnectionMode').value = mode;
  $('#accessConnectionMode').querySelector('[value="webhook"]').disabled =
    platformKey === 'wecom' || platformKey === 'dingtalk';
  $('#accessVerificationTokenField').hidden = websocketMode;
  $('#accessEncryptKeyField').hidden = websocketMode;
  $('#accessAppIdLabel').textContent = platformMeta.idLabel;
  $('#accessAppSecretLabel').textContent = platformMeta.secretLabel;
  $('#platformModeHint').textContent = websocketMode
    ? `${platformName} · ${uiText('长连接：保存后自动连接，不需要公网回调。')}`
    : `${platformName} · ${uiText('Webhook：需要把公网 HTTPS 隧道映射到本机网关。')}`;
  $('#accessCredentialState').textContent = platform.configured
    ? `${platformName} · ${uiText('凭据已保存')}${uiText(platform.enabled ? '，平台已启用' : '，当前未启用')}`
    : `${platformName} · ${uiText('尚未配置完整凭据')}`;
  $('#accessCredentialState').style.color = platform.configured ? 'var(--green)' : '';
  $('#accessAppId').placeholder = platform.app_id
    ? `当前 ${platform.app_id}（留空不修改）`
    : platformMeta.idPlaceholder;
  $('#accessAppSecret').placeholder = platform.secret_configured
    ? '已保存，留空表示不修改'
    : platformMeta.secretPlaceholder;
  $('#accessVerificationToken').placeholder = platform.verification_configured
    ? '已保存，留空表示不修改'
    : '事件订阅校验令牌';
  $('#accessEncryptKey').placeholder = platform.encryption_configured
    ? '已保存，留空表示不修改'
    : '可选，建议启用';

  if (hydrate) {
    state.access.draftMode = null;
    state.access.snapshot = snapshot;
    $('#accessConnectionMode').value = platform.mode || 'websocket';
    $('#accessPlatformEnabled').checked = Boolean(platform.enabled);
    $('#accessGatewayEnabled').checked = Boolean(gateway.running);
    $('#accessGatewayPort').value = String(gateway.port || settings.gateway_port || 17666);
    $('#llmEnabled').checked = Boolean(settings.llm_enabled);
    $('#llmBaseUrl').value = settings.llm_base_url || 'https://api.openai.com/v1';
    $('#llmModel').value = settings.llm_model || '';
    $('#llmApiKey').placeholder = settings.llm_key_configured ? '已保存，留空表示不修改' : 'API Key';
    $('#asrEnabled').checked = settings.asr_enabled !== false;
    $('#asrProvider').value = settings.asr_provider || 'whisper_cpp';
    $('#asrCommand').value = settings.asr_command || 'whisper-cli';
    $('#asrModelPath').value = settings.asr_model_path || '';
    $('#asrBaseUrl').value = settings.asr_base_url || 'https://api.openai.com/v1';
    $('#asrModel').value = settings.asr_model || 'whisper-1';
    $('#asrLanguage').value = settings.asr_language || 'zh-CN';
    $('#asrApiKey').placeholder = settings.asr_key_configured ? '已保存，留空表示不修改' : 'API Key';
    updateAsrProviderFields();
  }

  const endpoint = gateway.base_url || `http://127.0.0.1:${gateway.port || settings.gateway_port || 17666}`;
  $('#accessGatewayEndpoint').value = endpoint;
  $('#accessGatewayState').textContent = gateway.running
    ? `运行中 · ${Math.floor((gateway.uptime_seconds || 0) / 60)} 分钟`
    : gateway.error || '未启动';
  $('#accessGatewayState').classList.toggle('on', Boolean(gateway.running));
  if (!state.access.token) {
    $('#accessGatewayToken').textContent = settings.gateway_token_masked || '••••';
  }
  $('#revealGatewayToken').textContent = state.access.token ? '隐藏令牌' : '显示令牌';

  const connectionNode = $('#accessConnectionState');
  const connectionDetail = $('#accessConnectionDetail');
  connectionNode.classList.remove('on', 'warn');
  if (websocketMode) {
    connectionNode.textContent = platform.enabled ? connectionLabel : '未启用';
    connectionNode.classList.toggle('on', platform.enabled && connectionState === 'connected');
    connectionNode.classList.toggle('warn', platform.enabled
      && ['connecting', 'reconnecting', 'error', 'replaced'].includes(connectionState));
    const seconds = Number(connection.connected_seconds || 0);
    connectionDetail.textContent = !platform.enabled
      ? '打开启用开关并保存后自动连接'
      : connection.last_error
        ? connection.last_error
        : connectionState === 'connected'
          ? `已稳定连接 ${Math.max(1, Math.floor(seconds / 60))} 分钟`
          : '正在建立安全 WebSocket 连接';
  } else {
    const webhookReady = platform.enabled && platform.configured && gateway.running;
    connectionNode.textContent = webhookReady ? '等待平台回调' : '未就绪';
    connectionNode.classList.toggle('on', webhookReady);
    connectionNode.classList.toggle('warn', platform.enabled && !webhookReady);
    connectionDetail.textContent = !gateway.running
      ? '先启动本地网关并配置公网隧道'
      : !platform.configured
        ? '先补齐应用凭据与事件校验信息'
        : 'Webhook 已启用，等待平台事件';
  }
  const reconnectNode = $('#accessReconnect');
  const canReconnect = websocketMode
    && platform.enabled
    && platform.configured
    && ['error', 'replaced', 'stopped'].includes(connectionState);
  reconnectNode.hidden = !canReconnect;
  if (canReconnect) {
    reconnectNode.disabled = false;
    reconnectNode.textContent = '重新连接';
  }

  const guidance = accessConnectionGuidance({
    platform: platformKey,
    websocketMode,
    enabled: platform.enabled,
    configured: platform.configured,
    gateway,
    connection,
  });
  const helpNode = $('#accessConnectionHelp');
  helpNode.hidden = !guidance;
  if (guidance) {
    $('#accessConnectionHelpTitle').textContent = uiText(guidance.title);
    $('#accessConnectionHelpHint').textContent = uiText(guidance.hint);
  }

  const webhookPath = `/v1/platform/${platformKey}`;
  const callbackUrl = webhookCallbackUrl(endpoint, platformKey);
  $('#accessWebhookLabel').textContent = websocketMode ? '当前接入' : `${platformName}回调路径`;
  $('#accessWebhookPath').textContent = websocketMode ? '长连接' : callbackUrl;
  $('#accessWebhookPath').dataset.url = websocketMode ? '' : callbackUrl;
  $('#copyWebhookUrl').hidden = websocketMode;
  $('#accessWebhookHint').textContent = websocketMode
    ? '无需公网回调'
    : `本机回调；公网配置时请替换为 HTTPS 域名（路径 ${webhookPath}）`;

  const apiReady = websocketMode
    ? platform.enabled && connectionState === 'connected'
    : platform.enabled && platform.configured && gateway.running;
  $('#generatePairCode').disabled = !apiReady;
  $('#generatePairCode').title = apiReady ? '' : '等待平台连接就绪后再生成配对码';
  setSignal('accessSignalAi', settings.llm_enabled ? 'good' : 'warn',
    settings.llm_enabled ? (settings.llm_model || '已启用') : '本地规则');
  setSignal('accessSignalPlatform', apiReady ? 'good' : (platform.configured ? 'warn' : ''),
    websocketMode
      ? `${platformName} · ${uiText(platform.enabled ? connectionLabel : '未启用')}`
      : `${platformName} · ${uiText(apiReady ? '等待回调' : '未就绪')}`);
  setSignal('accessSignalGateway', gateway.running ? 'good' : (gateway.error ? 'bad' : ''),
    gateway.running ? `127.0.0.1:${gateway.port}` : (gateway.error ? '启动失败' : '未启动'));
  const bindingCount = (settings.bindings || []).length;
  setSignal('accessSignalBinding', bindingCount ? 'good' : '', `${bindingCount} 个会话`);

  const platformRailText = (config, connectionStatus, label) => {
    if (!config.configured) return '未配置';
    if (!config.enabled) return '已保存';
    if ((config.mode || 'websocket') === 'webhook') return 'Webhook';
    return stateLabels[connectionStatus?.state] || label;
  };
  $('#railFeishuState').textContent = platformRailText(feishu, connections.feishu_ws, '未启动');
  $('#railFeishuState').className = feishu.configured ? 'good' : '';
  $('#railWecomState').textContent = platformRailText(wecom, connections.wecom_ws, '未启动');
  $('#railWecomState').className = wecom.configured ? 'good' : '';
  $('#railDingtalkState').textContent = platformRailText(dingtalk, connections.dingtalk_ws, '未启动');
  $('#railDingtalkState').className = dingtalk.configured ? 'good' : '';
  $('#railGatewayState').textContent = gateway.running ? '运行中' : (gateway.error ? '启动失败' : '未启动');
  $('#railGatewayState').className = gateway.running ? 'good' : (gateway.error ? 'warn' : '');
  $('#railLlmState').textContent = settings.llm_enabled ? (settings.llm_model || '已启用') : '规则解析';
  $('#railLlmState').className = settings.llm_enabled ? 'good' : '';
  const asrProviderLabels = {
    whisper_cpp: 'Whisper.cpp',
    openai_compatible: '云端 ASR',
    apple: 'macOS 语音',
  };
  $('#railAsrState').textContent = settings.asr_enabled
    ? (asrProviderLabels[settings.asr_provider] || '已启用')
    : '已关闭';
  $('#railAsrState').className = settings.asr_enabled ? 'good' : '';

  $('#pairingInstruction').textContent = !platform.enabled
    ? '先启用平台并保存连接设置。'
    : websocketMode && connectionState !== 'connected'
      ? '等待长连接建立后再生成配对码。'
      : '生成后发送给机器人。10 分钟过期，只可认领一次。';
  renderAccessBindings(settings);
  renderAccessPairing(settings, hydrate);
}

async function loadAccess(hydrate = false) {
  if (!invoke || state.access.loading) return;
  state.access.loading = true;
  try {
    const snapshot = await invoke('integration_snapshot');
    renderAccess(snapshot, hydrate);
  } catch (error) {
    if (hydrate) toast(`读取接入状态失败：${error}`, true);
  } finally {
    state.access.loading = false;
  }
}

async function showAccess() {
  await stopCamera();
  fillAccessHomes();
  showView('access');
  await loadAccess(true);
  if (state.access.pollTimer) clearInterval(state.access.pollTimer);
  state.access.pollTimer = setInterval(() => {
    if (state.page === 'access') loadAccess(false);
  }, 5000);
}

async function copyText(text, label = '内容') {
  if (!text) return toast(`没有可复制的${label}`, true);
  if (invoke) {
    try {
      await invoke('copy_text', { text });
      toast(`${label}已复制`);
      return;
    } catch (_) {}
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`);
  } catch (_) {
    toast(`复制失败，请重试`, true);
  }
}

async function saveAccessPlatform() {
  const platform = state.access.platform;
  const mode = $('#accessConnectionMode').value;
  const appId = $('#accessAppId').value.trim();
  const appSecret = $('#accessAppSecret').value.trim();
  const verificationToken = $('#accessVerificationToken').value.trim();
  const encryptKey = $('#accessEncryptKey').value.trim();
  const enabled = $('#accessPlatformEnabled').checked;
  try {
    const snapshot = await invoke('integration_save_platform', {
      platform,
      enabled,
      mode,
      appId,
      appSecret: appSecret || null,
      verificationToken: verificationToken || null,
      encryptKey: encryptKey || null,
    });
    $('#accessAppSecret').value = '';
    $('#accessVerificationToken').value = '';
    $('#accessEncryptKey').value = '';
    $('#accessAppId').value = '';
    state.access.draftMode = null;
    renderAccess(snapshot, true);
    toast(mode === 'websocket'
      ? `${accessPlatformLabel(platform)}长连接配置已保存${enabled ? '，正在连接' : ''}`
      : `${accessPlatformLabel(platform)} Webhook 配置已保存`);
  } catch (error) {
    toast(String(error), true);
  }
}

async function testAccessPlatform() {
  const button = $('#testPlatform');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const platformTests = {
      feishu: {
        command: 'integration_test_feishu',
        args: {
          appId: $('#accessAppId').value.trim() || null,
          appSecret: $('#accessAppSecret').value.trim() || null,
        },
      },
      wecom: {
        command: 'integration_test_wecom',
        args: {
          appId: $('#accessAppId').value.trim() || null,
          appSecret: $('#accessAppSecret').value.trim() || null,
        },
      },
      dingtalk: {
        command: 'integration_test_dingtalk',
        args: {
          clientId: $('#accessAppId').value.trim() || null,
          clientSecret: $('#accessAppSecret').value.trim() || null,
        },
      },
    };
    const test = platformTests[state.access.platform] || platformTests.feishu;
    const message = await invoke(test.command, test.args);
    toast(message);
  } catch (error) {
    const advice = platformErrorAdvice(state.access.platform, error);
    toast(advice ? `${String(error)}。${uiText(advice.hint)}` : String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = '测试凭据';
  }
}

async function toggleGateway() {
  const enabled = $('#accessGatewayEnabled').checked;
  const port = Number($('#accessGatewayPort').value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    $('#accessGatewayEnabled').checked = !enabled;
    return toast('端口需要在 1024–65535 之间', true);
  }
  try {
    const snapshot = await invoke('integration_set_gateway', { enabled, port });
    renderAccess(snapshot, true);
    toast(enabled ? '本地控制网关已启动' : '本地控制网关已停止');
  } catch (error) {
    $('#accessGatewayEnabled').checked = !enabled;
    toast(String(error), true);
  }
}

async function revealGatewayToken() {
  if (state.access.token) {
    state.access.token = '';
    $('#accessGatewayToken').textContent = state.access.snapshot?.settings?.gateway_token_masked || '••••';
    $('#revealGatewayToken').textContent = '显示令牌';
    return;
  }
  try {
    state.access.token = await invoke('integration_reveal_gateway_token');
    $('#accessGatewayToken').textContent = state.access.token;
    $('#revealGatewayToken').textContent = '隐藏令牌';
  } catch (error) {
    toast(String(error), true);
  }
}

async function generateAccessPairCode() {
  const button = $('#generatePairCode');
  button.disabled = true;
  try {
    const pairing = await invoke('integration_generate_pair_code', {
      platform: state.access.platform,
      homeId: $('#pairHome').value || state.homeId || null,
    });
    state.access.pairing = pairing;
    renderAccessPairing(state.access.snapshot?.settings, false);
    toast('配对码已生成，10 分钟内有效');
  } catch (error) {
    toast(String(error), true);
  } finally {
    button.disabled = false;
  }
}

function renderAssistantTest(response) {
  const box = $('#assistantTestResult');
  if (!box) return;
  const failed = ['error', 'not_found'].includes(response?.status);
  box.classList.toggle('error', failed);
  const candidates = Array.isArray(response?.candidates) && response.candidates.length
    ? response.candidates.map((item) =>
      `<span class="candidate-line">${esc(item.home)} / ${esc(item.room)} / ${esc(item.device)}</span>`).join('')
    : '';
  box.innerHTML = `<span class="console-prompt">${esc(String(response?.status || 'unknown').toUpperCase())}</span>
    <p>${esc(response?.reply || '没有返回结果')}${candidates}</p>`;
}

async function sendAssistantTest() {
  const input = $('#assistantTestInput');
  const text = input.value.trim();
  if (!text) return;
  const button = $('#assistantTestSend');
  button.disabled = true;
  button.textContent = '执行中';
  try {
    const response = await invoke('assistant_command', {
      request: {
        text,
        home_id: state.homeId || null,
        source: 'desktop-test',
        event_id: `desktop-${Date.now()}`,
      },
    });
    renderAssistantTest(response);
    input.select();
  } catch (error) {
    renderAssistantTest({ status: 'error', reply: String(error) });
  } finally {
    button.disabled = false;
    button.textContent = '执行';
  }
}

async function saveLlmSettings() {
  const enabled = $('#llmEnabled').checked;
  try {
    const snapshot = await invoke('integration_save_llm', {
      enabled,
      baseUrl: $('#llmBaseUrl').value.trim(),
      model: $('#llmModel').value.trim(),
      apiKey: $('#llmApiKey').value.trim() || null,
    });
    $('#llmApiKey').value = '';
    renderAccess(snapshot, true);
    toast(enabled ? '大模型意图解析已启用' : '已切换为本地规则解析');
  } catch (error) {
    renderAccess(state.access.snapshot, true);
    toast(String(error), true);
  }
}

async function testLlmConnection() {
  const button = $('#testLlm');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const message = await invoke('integration_test_llm', {
      baseUrl: $('#llmBaseUrl').value.trim() || null,
      model: $('#llmModel').value.trim() || null,
      apiKey: $('#llmApiKey').value.trim() || null,
    });
    toast(message);
  } catch (error) {
    toast(String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

function updateAsrProviderFields() {
  const provider = $('#asrProvider')?.value || 'whisper_cpp';
  const local = provider === 'whisper_cpp';
  const cloud = provider === 'openai_compatible';
  $('#asrLocalFields').hidden = !local;
  $('#asrCloudFields').hidden = !cloud;
  $('#asrAppleHint').hidden = provider !== 'apple';
}

async function saveAsrSettings() {
  const enabled = $('#asrEnabled').checked;
  try {
    const snapshot = await invoke('integration_save_asr', {
      enabled,
      provider: $('#asrProvider').value,
      baseUrl: $('#asrBaseUrl').value.trim(),
      model: $('#asrModel').value.trim(),
      apiKey: $('#asrApiKey').value.trim() || null,
      language: $('#asrLanguage').value.trim(),
      command: $('#asrCommand').value.trim(),
      modelPath: $('#asrModelPath').value.trim(),
    });
    $('#asrApiKey').value = '';
    renderAccess(snapshot, true);
    toast(enabled ? '语音识别设置已保存' : '语音识别已关闭');
  } catch (error) {
    renderAccess(state.access.snapshot, true);
    toast(String(error), true);
  }
}

async function testAsrConnection() {
  const button = $('#testAsr');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const message = await invoke('integration_test_asr', {
      provider: $('#asrProvider').value,
      baseUrl: $('#asrBaseUrl').value.trim() || null,
      model: $('#asrModel').value.trim() || null,
      apiKey: $('#asrApiKey').value.trim() || null,
      language: $('#asrLanguage').value.trim() || null,
      command: $('#asrCommand').value.trim() || null,
      modelPath: $('#asrModelPath').value.trim() || null,
    });
    toast(message);
  } catch (error) {
    toast(String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = '测试语音识别';
  }
}

function adminChecklist() {
  if (state.access.platform === 'wecom') {
    return [
      '企业微信接入清单',
      '1. 使用企业管理员进入「应用管理 → 智能机器人」。',
      '2. 创建智能机器人并开启 API 接收消息。',
      '3. 记录 Bot ID 与 Bot Secret。',
      '4. 在 MiHome Mac 选择「企业微信 → 长连接」，填写凭据并启用。',
      '5. 看到连接状态为「已连接」后生成配对码。',
      '6. 在机器人单聊或群里发送「配对 123456」。',
    ].join('\n');
  }
  if (state.access.platform === 'dingtalk') {
    return [
      '钉钉接入清单',
      '1. 管理员打开 open.dingtalk.com，进入「应用开发 → 企业内部应用」。',
      '2. 创建应用并添加「机器人」能力，消息接收选择 Stream 模式。',
      '3. 在凭证与基础信息页记录 Client ID（AppKey）和 Client Secret（AppSecret）。',
      '4. 发布应用，并把可用范围设置为测试成员或目标部门。',
      '5. 在 MiHome Mac 选择「钉钉 → 长连接」，填写凭据并启用。',
      '6. 连接状态显示「已连接」后生成配对码。',
      '7. 在机器人单聊发送「配对 123456」。',
    ].join('\n');
  }
  const feishuWebhook = $('#accessConnectionMode')?.value === 'webhook';
  const feishuEventStep = feishuWebhook
    ? '4. 事件订阅选择 Webhook，添加 im.message.receive_v1、im.chat.access_event.bot_p2p_chat_entered_v1 和 im.chat.member.bot.added_v1。'
    : '4. 事件订阅选择「长连接」，添加 im.message.receive_v1、im.chat.access_event.bot_p2p_chat_entered_v1 和 im.chat.member.bot.added_v1。';
  const feishuConnectionStep = feishuWebhook
    ? '6. 把接入页复制的回调地址替换为公网 HTTPS 域名，填入飞书事件订阅。'
    : '6. 打开 MiHome Mac → 接入，选择长连接、填写凭据并启用。';
  return [
    '飞书接入清单',
    '1. 管理员打开 open.feishu.cn，创建「企业自建应用」。',
    '2. 在凭证页记录 App ID 与 App Secret。',
    '3. 开启机器人能力，并配置消息接收、发送和资源下载权限。',
    feishuEventStep,
    '5. 发布应用并把可用范围设置为测试成员。',
    feishuConnectionStep,
    '7. 生成配对码，在机器人会话发送「配对 123456」。',
  ].join('\n');
}

function userOnboardingText() {
  const platform = accessPlatformLabel(state.access.platform);
  const code = state.access.pairing?.code || '在桌面端生成';
  return [
    `【MiHome Mac × ${platform} 内测接入】`,
    `1. 打开 ${platform}，添加管理员发给你的智能机器人。`,
    '2. 单聊机器人，或把它拉进家庭群。',
    `3. 发送：配对 ${code}`,
    '4. 配对成功后直接说：打开客厅灯 / 打开空调并调至24度 / 关闭所有灯，除了客厅灯 / 执行回家模式。',
    '',
    '注意：桌面端 MiHome Mac 需要保持运行并联网。',
  ].join('\n');
}

// background: keep the current list on screen while the account's camera list
// is re-read, and only rebuild it when something changed. Opening the camera
// page uses this so large accounts do not flash and rebuild every visit.
async function loadCameras(options = {}) {
  const background = options.background === true && state.cameras.length > 0;
  const request = ++state.camerasRequest;
  const list = $('#camList');
  if (!background) list.replaceChildren(el('div', 'empty', '正在读取摄像头…'));
  try {
    const cameras = await invoke('list_cameras');
    if (request !== state.camerasRequest) return;
    const changed = !background || JSON.stringify(cameras) !== JSON.stringify(state.cameras);
    state.cameras = cameras;
    setNavCount('cameraCount', state.cameras.length);
    if (changed) {
      log.info('Camera', `摄像头列表已加载：${cameras.length} 台`);
      renderCameras();
      renderSidebarRooms();
      if (state.page === 'overview') renderOverview(true);
    }
    updateChrome();
    loadDeviceSpecs(cameras);
  } catch (error) {
    log.error('Camera', `读取摄像头列表失败：${error}`);
    if (request !== state.camerasRequest) return;
    if (background) return;
    state.cameras = [];
    setNavCount('cameraCount', 0);
    list.replaceChildren(el('div', 'empty error', `读取摄像头失败：${error}`));
    updateChrome();
  }
}

const CAMERA_COMPACT_THRESHOLD = 12;

function deviceSearchText(device) {
  const parts = [device.name, device.model || '', roomName(device)];
  return window.MiPinyin?.searchable(parts) ?? parts.join(' ').toLowerCase();
}

function cameraSearchText(camera, devices) {
  const device = devices.get(camera.did);
  const parts = [camera.name, camera.model || '', camera.ip || '', device ? roomName(device) : ''];
  return window.MiPinyin?.searchable(parts) ?? parts.join(' ').toLowerCase();
}

function cameraQuery() {
  return state.cameraQuery.trim().toLowerCase();
}

function devicesByDid() {
  return new Map(state.devices.map((device) => [device.did, device]));
}

// Cameras matching the side-panel search; the grid pages through this set.
function filteredCameras() {
  const query = cameraQuery();
  if (!query) return state.cameras;
  const devices = devicesByDid();
  return state.cameras.filter((camera) => cameraSearchText(camera, devices).includes(query));
}

function updateCameraCount() {
  const node = $('#camSideCount');
  if (!node) return;
  node.textContent = cameraQuery() && Number.isFinite(state.cameraVisible)
    ? `${state.cameraVisible} / ${state.cameras.length}`
    : String(state.cameras.length);
}

// Filters by toggling cards instead of rebuilding the list.
function applyCameraFilter() {
  const list = $('#camList');
  const query = cameraQuery();
  let visible = 0;
  for (const card of list.querySelectorAll('.cam-card')) {
    const match = !query || card.dataset.search.includes(query);
    card.hidden = !match;
    if (match) visible += 1;
  }
  let empty = list.querySelector('.cam-side-empty');
  if (!visible && state.cameras.length) {
    if (!empty) {
      empty = el('div', 'cam-side-empty', '没有匹配的摄像头');
      list.append(empty);
    }
  } else {
    empty?.remove();
  }
  state.cameraVisible = visible;
  updateCameraCount();
}

function renderCameras() {
  const list = $('#camList');
  const scroll = list.scrollTop;
  list.replaceChildren();
  list.classList.toggle('compact', state.cameras.length > CAMERA_COMPACT_THRESHOLD);
  $('#camSearch').hidden = state.cameras.length <= CAMERA_COMPACT_THRESHOLD;
  updateCameraCount();
  if (!state.cameras.length) {
    list.append(el('div', 'empty', '账号下没有识别到摄像头'));
    $('#camEmpty').textContent = '没有可用摄像头';
    $('#camTitle').textContent = uiText('监控台');
    $('#camSubtitle').textContent = uiText('账号下没有识别到摄像头');
    $('#camSpec').textContent = '无可用通道';
    return;
  }
  if (!state.cameras.some((camera) => camera.did === state.selectedCameraDid)) {
    state.selectedCameraDid = state.cameras[0].did;
  }
  const fragment = document.createDocumentFragment();
  const devices = devicesByDid();
  for (const camera of state.cameras) {
    const card = el('div', `cam-card ${state.selectedCameraDid === camera.did ? 'active' : ''}${camera.online ? '' : ' offline'}`);
    card.dataset.did = camera.did;
    card.dataset.search = cameraSearchText(camera, devices);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.onclick = () => {
      state.selectedCameraDid = camera.did;
      markSelectedCamera();
      if (state.selectedCameraDid === camera.did) {
        $('#camEmpty').textContent = `已选择 ${camera.name}，点击“本地”或“远程”打开。`;
        updateCameraStage(camera, null, false);
      }
    };
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        card.click();
      }
    };
    const art = el('div', 'cam-thumb-art');
    art.append(
      el('span', `live-dot${camera.online ? '' : ' muted'}`),
      el('span', 'cam-thumb-badge', camera.online ? (camera.ip ? '本地可达' : '仅远程') : '离线'),
    );
    card.append(art);
    const copy = el('div', 'cam-card-info');
    copy.append(el('strong', '', camera.name));
    copy.append(el('span', '', camera.ip ? `局域网 · ${camera.ip}` : '远程通道'));
    copy.title = camera.model;
    card.append(copy);
    const actions = el('div', 'cam-actions');
    const local = el('button', 'pill', '本地');
    local.type = 'button';
    local.disabled = !camera.online || !camera.ip;
    local.onclick = (event) => {
      event.stopPropagation();
      state.selectedCameraDid = camera.did;
      markSelectedCamera();
      startCameraSet([camera], false);
    };
    const remote = el('button', 'pill remote', '远程');
    remote.type = 'button';
    remote.disabled = !camera.online;
    remote.onclick = (event) => {
      event.stopPropagation();
      state.selectedCameraDid = camera.did;
      markSelectedCamera();
      startRemoteCamera(camera);
    };
    actions.append(local, remote);
    card.append(actions);
    fragment.append(card);
  }
  list.append(fragment);
  applyCameraFilter();
  list.scrollTop = scroll;
  const selected = state.cameras.find((camera) => camera.did === state.selectedCameraDid)
    || state.cameras[0];
  if (!state.activeCamera) {
    state.selectedCameraDid = selected?.did || null;
    $('#camEmpty').textContent = '选择一个摄像头';
    if (selected) updateCameraStage(selected, null, false);
  }
}

function markSelectedCamera() {
  for (const card of $('#camList').querySelectorAll('.cam-card')) {
    card.classList.toggle('active', card.dataset.did === state.selectedCameraDid);
  }
}

function updateCameraStage(camera, stream, remote) {
  if (!camera) return;
  $('#camTitle').textContent = camera.name;
  const cameraDevice = state.devices.find((device) => device.did === camera.did);
  const cameraFallback = MihomeI18n?.t('摄像头') || '摄像头';
  const modelFallback = MihomeI18n?.t('米家摄像头') || '米家摄像头';
  $('#camSubtitle').textContent = `${cameraDevice ? roomName(cameraDevice) : cameraFallback} · ${camera.model || modelFallback}`;
  $('#camSpec').textContent = camera.ip ? '局域网通道' : '远程通道';
  $('#camLatency').textContent = remote ? '远程' : camera.ip ? '本地' : '等待连接';
  $('#camTransport').textContent = stream ? '通道已建立' : '未连接';
  $('#camLocalButton').classList.toggle('active', !remote && Boolean(camera.ip));
  $('#camRemoteButton').classList.toggle('active', Boolean(remote));
  $('#camLivePill').classList.toggle('replay', !camera.online);
  $('#camLivePill').innerHTML = `<i></i>${camera.online ? 'LIVE' : 'OFFLINE'}`;
  const ptz = $('#camPtzOverlay');
  const supportsPtz = !String(camera.model || '').includes('039a01');
  ptz.hidden = !remote || !supportsPtz;
  ptz.setAttribute('aria-hidden', String(ptz.hidden));
  for (const button of ptz.querySelectorAll('[data-ptz-dir]')) {
    button.disabled = !stream;
  }
  updateCameraToolState();
  renderCameraTimeline();
}

function renderCameraTimeline() {
  const box = $('#camTimeline');
  if (!box) return;
  const camera = state.cameras.find((item) => item.did === state.selectedCameraDid)
    || state.activeCamera;
  const active = Boolean(
    state.activeCamera
    && state.cameraStreams.some((stream) => stream.id === state.activeCamera.did),
  );
  const now = new Date();
  const date = new Intl.DateTimeFormat(uiLocale(), {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now);
  const clock = new Intl.DateTimeFormat(uiLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  const playhead = ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400) * 100;
  const started = state.cameraSessionStartedAt
    ? new Intl.DateTimeFormat(uiLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(state.cameraSessionStartedAt))
    : null;
  const mode = state.remoteActive ? '远程通道' : '本地直连';
  box.innerHTML = `<div class="timeline-head">
    <div><div class="eyebrow">今天 · ${esc(date)}</div><h3>事件时间线</h3></div>
    <div class="timeline-head-actions">
      <span class="timeline-legend"><i class="legend-motion"></i>移动 <i class="legend-record"></i>录制</span>
      <button class="ghost-btn" type="button" data-timeline-refresh>${uiIcon('history')} 刷新</button>
    </div>
  </div>
  <div class="timeline-ruler"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>24:00</span></div>
  <div class="timeline-track">
    ${active ? '<span class="timeline-live" style="left:96%;width:4%"></span>' : ''}
    <span class="timeline-playhead" id="timelinePlayhead" style="left:${playhead.toFixed(3)}%"></span>
  </div>
  <div class="timeline-list">
    ${active
      ? `<div class="timeline-event timeline-session">
          <time>${esc(started || clock)}</time><span class="timeline-event-dot scene"></span>
          <span class="timeline-event-copy"><strong>本次实时查看</strong><small>${esc(camera?.name || '摄像头')} · ${mode} · 画面只在本机解码</small></span>
          <span class="timeline-event-play">${uiIcon('play')}</span>
        </div>`
      : `<div class="timeline-empty">${uiIcon('clock')}<span><strong>当前没有可读取的录像事件</strong><small>米家接口未向第三方客户端开放云存储事件列表；实时画面和本机诊断不受影响。</small></span></div>`}
  </div>`;
  box.querySelector('[data-timeline-refresh]')?.addEventListener('click', renderCameraTimeline);
}

async function startRemoteCamera(camera) {
  return startRemoteCameraSet([camera], false);
}

function startRemoteCameraSet(cameras, grid) {
  return queueCameraOperation(() => startRemoteCameraSetNow(cameras, grid));
}

async function startRemoteCameraSetNow(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线摄像头';
    return;
  }
  await stopCameraNow('切换到远程画面');
  log.info('Camera', `开始远程画面：count=${usable.length} grid=${grid}`);
  const generation = state.cameraGeneration;
  state.cameraStreams = [];
  state.cameraGrid = grid;
  state.remoteAudio.clear();
  state.activeCamera = usable[0];
  state.cameraSessionStartedAt = Date.now();
  state.selectedCameraDid = usable[0].did;
  state.remoteActive = true;
  markSelectedCamera();
  updateCameraStage(usable[0], null, true);
  $('#camLayout').hidden = grid;
  $('#camGrid').hidden = !grid;
  $('#camEmpty').hidden = false;
  $('#camEmpty').textContent = '正在连接远程画面…首次约 10–20 秒';
  const selected = grid ? usable.slice(0, MAX_REMOTE_STREAMS) : usable;
  $('#camHint').textContent = grid ? `正在建立 ${selected.length} 路远程画面` : `正在建立远程通道：${usable[0].name}`;
  $('#camGridToggle').textContent = grid ? '单画面' : '宫格';
  updateCameraGridPager();

  let tiles = null;
  let singleVideo = null;
  if (grid) {
    $('#camGrid').replaceChildren();
    $('#camGrid').toggleAttribute('data-dense', selected.length > 4);
    $('#camControls').hidden = true;
    tiles = new Map();
    for (const camera of selected) {
      const tile = el('div', 'cam-tile');
      bindGridTile(tile, camera, true);
      tile.append(el('span', 'cam-tile-title', camera.name));
      const status = el('span', 'cam-tile-status', '正在连接…');
      tile.append(status);
      $('#camGrid').append(tile);
      tiles.set(camera.did, { tile, status, video: null });
    }
  } else {
    singleVideo = $('#camVideo');
    singleVideo.hidden = false;
    $('#camEmpty').hidden = true;
  }

  let readyCount = 0;
  const failures = [];
  const starts = runLimited(selected, MAX_REMOTE_START_CONCURRENCY, async (camera) => {
    // After paging or stopping, cameras still waiting for a start slot are
    // skipped; otherwise every page flip would still open all of its relays.
    if (generation !== state.cameraGeneration) return null;
    try {
      // Prewarm audio on its own low-latency channel. Playback stays muted
      // until the user enables it, so toggling sound never rebuilds video.
      const stream = await invoke('camera_remote_start', {
        did: camera.did, quality: 1, audio: !grid,
      });
      if (generation !== state.cameraGeneration) return null;
      state.cameraStreams = [
        ...state.cameraStreams.filter((item) => item.id !== stream.id),
        stream,
      ];
      readyCount += 1;
      if (grid) {
        const target = tiles.get(camera.did);
        if (!target) return stream;
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.onerror = () => {
          log.error('Camera', `远程宫格播放失败：${camera.name}`);
          target.status.textContent = '播放失败';
          target.status.hidden = false;
        };
        target.status.hidden = true;
        target.video = video;
        target.tile.append(video);
        attachCameraStream(
          video,
          stream,
          camera,
          generation,
          () => restartRemoteCamera(camera, video, generation),
        );
        watchRemote(video, camera, () => restartRemoteCamera(camera, video, generation), generation);
      } else {
        updateCameraStage(camera, stream, true);
        $('#camTransport').textContent = '远程通道已建立';
        $('#camLatency').textContent = '远程';
        renderCameraControls(camera, true).catch((error) => {
          log.error('Camera', `渲染远程控制项失败：${error}`);
        });
        singleVideo.muted = state.remoteAudio.get(camera.did) !== true;
        singleVideo.volume = 1;
        attachCameraStream(
          singleVideo,
          stream,
          camera,
          generation,
          () => restartRemoteCamera(camera, singleVideo, generation),
        );
        $('#camHint').textContent = `${camera.name} · 远程连接`;
        if (state.remoteWatch) clearInterval(state.remoteWatch);
        watchRemote(singleVideo, camera, () => restartRemoteCamera(camera, singleVideo, generation), generation);
        setTimeout(() => {
          if (generation === state.cameraGeneration && !singleVideo.videoWidth) {
            log.warn('Camera', `远程播放器 12 秒无首帧：${camera.name}`);
            $('#camHint').textContent = `远程流已建立，但播放器还没有首帧：${camera.name}。请重试，或导出诊断日志后查看媒体通道状态。`;
          }
        }, 12000);
      }
      return stream;
    } catch (error) {
      failures.push(error);
      if (grid) {
        const target = tiles.get(camera.did);
        if (target) {
          target.status.textContent = '连接失败';
          target.status.hidden = false;
        }
      }
      log.error('Camera', `远程画面失败：${camera.name} ${String(error)}`);
      return null;
    }
  });

  // The camera queue is released here instead of after every relay handshake
  // (2–30 s each), so paging, leaving the page or stopping is not stuck behind
  // a slow camera. Each start checks the generation before it touches the UI,
  // and the backend drops starts that finish after a stop.
  finishRemoteCameraSet(starts, { generation, grid, selected, failures, ready: () => readyCount });
}

async function finishRemoteCameraSet(starts, { generation, grid, selected, failures, ready }) {
  try {
    await starts;
    if (generation !== state.cameraGeneration) {
      return;
    }
    const readyCount = ready();
    if (!readyCount) throw failures[0] || new Error('远程通道没有启动');
    if (failures.length) toast(`${failures.length} 路摄像头取流失败`, true);
    log.info('Camera', `远程画面通道已建立：count=${readyCount} failed=${failures.length}`);
    if (grid) {
      $('#camHint').textContent = `${readyCount}/${selected.length} 路远程画面已启动${failures.length ? ` · ${failures.length} 路失败` : ''}`;
    }
  } catch (error) {
    log.error('Camera', `远程画面失败：${String(error)}`);
    if (generation !== state.cameraGeneration) return;
    let stopped = false;
    await queueCameraOperation(async () => {
      if (generation !== state.cameraGeneration) return;
      await stopCameraNow('远程启动失败');
      stopped = true;
    });
    // Only explain the failure if nothing else started in the meantime.
    if (!stopped || state.cameraGeneration !== generation + 1) return;
    const text = String(error);
    const busy = /没有返回画面|no authentication|no frames|End of file|提前退出|peer closed/.test(text);
    $('#camEmpty').hidden = false;
    $('#camEmpty').textContent = busy
      ? '摄像头没有返回画面。若米家 App 正在看同一台摄像头，先在手机上退出直播，再点“远程”重试。'
      : `远程取流失败：${text}`;
    $('#camHint').textContent = busy
      ? '同一台摄像头通常只允许一台设备查看实时画面。'
      : '远程通道初始化失败。应用内置转码组件未就绪，请重启应用并查看诊断日志。';
  }
}

async function setCameraProp(camera, def, value) {
  try {
    await invoke('set_property', { did: camera.did, siid: def.siid, piid: def.piid, value });
    state.cardProps.set(propKey(camera.did, def.siid, def.piid), value);
    refreshDeviceCard(camera);
    log.info('Camera', `设置已提交：${camera.name} ${def.label}=${value}`);
    return true;
  } catch (error) {
    log.error('Camera', `设置失败：${camera.name} ${def.label} ${error}`);
    toast(`${def.label}设置失败：${error}`, true);
    await renderCameraControls(camera, state.remoteActive);
    return false;
  }
}

async function renderCameraControls(camera, remote) {
  const request = ++state.cameraControlsRequest;
  const generation = state.cameraGeneration;
  const box = $('#camControls');
  if (!camera) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const supportsPtz = !String(camera.model || '').includes('039a01');

  const video = $('#camVideo');
  {
    const sound = el('div', 'cam-settings');
    const soundRow = el('div', 'cam-control');
    soundRow.append(el('span', '', '声音'));
    const soundToggle = el('label', 'switch');
    const soundInput = document.createElement('input');
    soundInput.type = 'checkbox';
    soundInput.checked = state.remoteAudio.get(camera.did) === true;
    soundInput.disabled = !camera;
    soundInput.onchange = async () => {
      if (!video || !camera) return;
      if (!soundInput.checked) {
        state.remoteAudio.set(camera.did, false);
        setCameraAudio(video, false, camera.name);
        log.info('Camera', `声音已关闭：${camera.name}`);
        $('#camHint').textContent = `${camera.name} · 声音已关闭`;
        return;
      }
      state.remoteAudio.set(camera.did, true);
      if (setCameraAudio(video, true, camera.name) && window.MiCameraPlayer?.setAudio) {
        log.info('Camera', `声音已打开（独立低延迟音轨）：${camera.name}`);
        $('#camHint').textContent = `${camera.name} · 声音已打开`;
        return;
      }
      const audioTracks = video.srcObject?.getAudioTracks?.() || [];
      if (audioTracks.length) {
        setCameraAudio(video, true, camera.name);
        log.info('Camera', `声音已打开：${camera.name} tracks=${audioTracks.length}`);
        $('#camHint').textContent = `${camera.name} · 声音已打开`;
        return;
      }
      if (!remote) {
        state.remoteAudio.set(camera.did, false);
        soundInput.checked = false;
        setCameraAudio(video, false, camera.name);
        $('#camHint').textContent = `${camera.name} · 本地音轨暂不可用，请重新打开摄像头`;
        log.warn('Camera', `本地音轨不可用：${camera.name}`);
        return;
      }
      soundInput.disabled = true;
      $('#camHint').textContent = `${camera.name} 正在打开声音…`;
      try {
        await invoke('camera_remote_stop', { did: camera.did }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (generation !== state.cameraGeneration) return;
        const stream = await invoke('camera_remote_start', { did: camera.did, quality: 1, audio: true });
        if (generation !== state.cameraGeneration) return;
        state.cameraStreams = state.cameraStreams.map((item) => item.id === camera.did ? stream : item);
        video.muted = false;
        video.volume = 1;
        attachCameraStream(
          video,
          stream,
          camera,
          generation,
          () => restartRemoteCamera(camera, video, generation),
        );
        log.info('Camera', `声音通道已建立：${camera.name}`);
        $('#camHint').textContent = `${camera.name} · 声音已打开`;
      } catch (error) {
        log.error('Camera', `打开声音失败：${camera.name} ${error}`);
        state.remoteAudio.set(camera.did, false);
        soundInput.checked = false;
        setCameraAudio(video, false, camera.name);
        $('#camHint').textContent = `打开声音失败：${error}`;
      } finally {
        soundInput.disabled = false;
      }
    };
    soundInput.addEventListener('change', () => setTimeout(updateCameraToolState, 0));
    soundToggle.append(soundInput, el('span'));
    soundRow.append(soundToggle);
    sound.append(soundRow);
    box.append(sound);
  }

  const settingsSection = el('section', 'cam-settings-section');
  settingsSection.append(el('p', 'eyebrow', '摄像头设置'));
  const settings = el('div', 'cam-settings');
  settingsSection.append(settings);
  box.append(settingsSection);
  const profile = inspectorProfile(camera);
  const controls = profile.controls.filter((def) =>
    def.type === 'toggle' || def.type === 'segments' || def.type === 'range');
  const requests = controls
    .filter((def) => def.readable !== false)
    .map((def) => ({ did: camera.did, siid: def.siid, piid: def.piid }));
  let values = new Map();
  log.info('Camera', `渲染控制项：${camera.name} controls=${controls.length} remote=${remote}`);
  if (requests.length) {
    try {
      const result = await invoke('get_properties', { requests });
      if (request !== state.cameraControlsRequest
        || generation !== state.cameraGeneration
        || state.activeCamera?.did !== camera.did) return;
      for (const item of Array.isArray(result) ? result : []) {
        if (!item || item.did !== camera.did || (item.code && item.code !== 0)) continue;
        values.set(`${item.siid}:${item.piid}`, item.value);
        state.cardProps.set(propKey(camera.did, item.siid, item.piid), item.value);
      }
    } catch (error) {
      log.error('Camera', `读取摄像头设置失败：${camera.name} ${error}`);
      if (request !== state.cameraControlsRequest) return;
      toast(`读取摄像头设置失败：${error}`, true);
    }
  }
  for (const def of controls) {
    const value = values.get(`${def.siid}:${def.piid}`);
    const row = el('div', 'cam-control');
    row.title = def.group || '摄像头设置';
    const label = el('span', '', def.label);
    row.append(label);
    if (def.type === 'toggle') {
      const toggle = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.onchange = () => setCameraProp(camera, def, input.checked);
      toggle.append(input, el('span'));
      row.append(toggle);
    } else if (def.type === 'segments') {
      const select = document.createElement('select');
      for (const [optionValue, optionLabel] of def.options || []) {
        const option = document.createElement('option');
        option.value = String(optionValue);
        option.textContent = optionLabel;
        option.selected = Number(value) === Number(optionValue);
        select.append(option);
      }
      select.onchange = () => setCameraProp(camera, def, Number(select.value));
      row.append(select);
    } else {
      const wrap = el('div', 'cam-range-wrap');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(def.min);
      range.max = String(def.max);
      const step = Number(def.step) > 0 ? Number(def.step) : 1;
      const digits = Number.isFinite(Number(def.digits))
        ? Number(def.digits)
        : step < 1 ? 1 : 0;
      range.step = String(step);
      range.value = String(value ?? def.min);
      const displayValue = (next) => `${Number(next).toFixed(digits)}${def.suffix || ''}`;
      const readout = el('small', 'muted cam-range-value', displayValue(range.value));
      range.oninput = () => { readout.textContent = displayValue(range.value); };
      range.onchange = () => setCameraProp(camera, def, Number(range.value));
      wrap.append(range, readout);
      row.append(wrap);
    }
    settings.append(row);
  }
  if (!settings.children.length) {
    settings.append(el('p', 'cam-control-note', profile.note || '这台摄像头没有返回可用的控制项。'));
  } else {
    settings.append(el('p', 'cam-control-note', !supportsPtz ? '该机型不支持云台，其他设置在云端生效。' : remote ? '云台为单步控制，每次点击转动一步。' : '云台需要先打开远程画面。'));
  }
}

async function diagnoseLocalTimeout(camera, video, generation) {
  if (generation !== state.cameraGeneration || state.remoteActive || video.videoWidth) return;
  let detail = '本地通道长时间没有收到视频。请确认摄像头未被其他设备占用后重试，或切换到远程画面。';
  try {
    const diagnostics = await invoke('camera_diagnostics');
    if (generation !== state.cameraGeneration || state.remoteActive || video.videoWidth) return;
    if (diagnostics?.detail) detail = diagnostics.detail;
    log.warn('Camera', `本地取流诊断：${JSON.stringify(diagnostics)}`);
    if (diagnostics && !diagnostics.alive) {
      detail = '本地取流服务已退出。请重新打开摄像头页，或重启应用后重试。';
    } else if (diagnostics && !diagnostics.api_ready) {
      detail = '本地取流服务没有正常响应。请重启应用后重试。';
    }
  } catch (error) {
    log.error('Camera', `读取本地诊断失败：${error}`);
    detail = `无法读取本地取流状态：${error}`;
  }
  if (generation === state.cameraGeneration && !state.remoteActive && !video.videoWidth) {
    $('#camHint').textContent = `没有首帧：${camera.name}（${camera.ip}）。${detail}`;
  }
}

// Clicking a grid tile opens that camera alone over the same transport.
function bindGridTile(tile, camera, remote) {
  tile.classList.add('openable');
  tile.title = camera.name;
  tile.tabIndex = 0;
  const open = () => {
    state.selectedCameraDid = camera.did;
    markSelectedCamera();
    if (remote) startRemoteCameraSet([camera], false);
    else startCameraSet([camera], false);
  };
  tile.onclick = (event) => {
    if (event.target.closest('button')) return;
    open();
  };
  tile.onkeydown = (event) => {
    if (event.target !== tile || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    open();
  };
}

function startCameraSet(cameras, grid) {
  return queueCameraOperation(() => startCameraSetNow(cameras, grid));
}

async function startCameraSetNow(cameras, grid) {
  const usable = cameras
    .filter((camera) => camera.online && camera.ip)
    .slice(0, grid ? MAX_LOCAL_GRID_STREAMS : 1);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线且带局域网地址的摄像头';
    return;
  }
  let generation;
  try {
    await stopCameraNow('切换到本地画面');
    generation = state.cameraGeneration;
    log.info('Camera', `开始本地画面：count=${usable.length} grid=${grid}`);
    const streams = await invoke('camera_start', { dids: usable.map((camera) => camera.did) });
    if (generation !== state.cameraGeneration) {
      return;
    }
    state.cameraStreams = streams;
    state.cameraGrid = grid;
    state.activeCamera = usable[0];
    state.cameraSessionStartedAt = Date.now();
    state.selectedCameraDid = usable[0].did;
    state.remoteActive = false;
    markSelectedCamera();
    updateCameraStage(usable[0], streams[0], false);
    log.info('Camera', `本地画面地址已返回：count=${streams.length}`);
    renderCameraControls(usable[0], false).catch((error) => {
      log.error('Camera', `渲染本地控制项失败：${error}`);
    });
    if (grid) {
      $('#camLayout').hidden = true;
      $('#camGrid').hidden = false;
      $('#camGrid').replaceChildren();
      $('#camGrid').toggleAttribute('data-dense', streams.length > 4);
      // One go2rtc process serves the whole local grid, so a restart rebuilds
      // every tile. A single silent camera only marks its own tile; the grid
      // restarts by itself only when every tile has stalled (the process is
      // gone), or when the user clicks a stalled tile.
      const stalled = new Set();
      const onTileStall = (camera, tile, video) => {
        if (generation !== state.cameraGeneration) return;
        stalled.add(camera.did);
        let status = tile.querySelector('.cam-tile-status');
        if (!status) {
          status = el('button', 'cam-tile-status', '没有画面，点击重试');
          status.type = 'button';
          status.onclick = () => restartLocalCamera(camera, generation);
          tile.append(status);
        }
        status.hidden = false;
        // A slow camera can still come up on the same transcoder: clear the
        // overlay and resume stall detection once frames arrive.
        video.addEventListener('playing', () => {
          if (generation !== state.cameraGeneration) return;
          stalled.delete(camera.did);
          status.hidden = true;
          watchRemote(video, camera, () => onTileStall(camera, tile, video), generation);
        }, { once: true });
        if (stalled.size >= streams.length) restartLocalCamera(camera, generation);
      };
      for (const stream of streams) {
        const camera = usable.find((item) => item.did === stream.id);
        const tile = el('div', 'cam-tile');
        if (camera) bindGridTile(tile, camera, false);
        tile.append(el('span', 'cam-tile-title', camera?.name || stream.id));
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.onerror = () => {
          log.error('Camera', `本地宫格播放失败：${camera?.name || stream.id}`);
          tile.append(el('span', 'error', '播放失败'));
        };
        tile.append(video);
        $('#camGrid').append(tile);
        const tileCamera = camera || usable[0];
        attachCameraStream(video, stream, tileCamera, generation, () => onTileStall(tileCamera, tile, video));
        watchRemote(video, tileCamera, () => onTileStall(tileCamera, tile, video), generation);
      }
      $('#camHint').textContent = `${streams.length} 路画面正在建立本地连接`;
      updateCameraGridPager();
    } else {
      const stream = streams[0];
      $('#camLayout').hidden = false;
      $('#camGrid').hidden = true;
      const video = $('#camVideo');
      video.hidden = false;
      $('#camEmpty').hidden = true;
      video.onloadeddata = () => {
        if (generation === state.cameraGeneration && !state.remoteActive) {
          log.info('Camera', `本地首帧已加载：${usable[0].name}`);
          $('#camHint').textContent = `${usable[0].name} · ${usable[0].ip} · 本地实时画面`;
          $('#camTransport').textContent = '本地首帧已加载';
          $('#camLatency').textContent = '本地';
        }
      };
      video.muted = state.remoteAudio.get(usable[0].did) !== true;
      video.volume = 1;
      attachCameraStream(
        video,
        stream,
        usable[0],
        generation,
        () => restartLocalCamera(usable[0], generation),
      );
      $('#camHint').textContent = `${usable[0].name} · ${usable[0].ip} · 正在建立本地连接`;
      $('#camTransport').textContent = '正在建立本地通道';
      $('#camLatency').textContent = '本地';
      watchRemote(video, usable[0], () => restartLocalCamera(usable[0], generation), generation);
      setTimeout(() => {
        if (generation === state.cameraGeneration && !state.remoteActive && !video.videoWidth) {
          log.warn('Camera', `本地画面 8 秒无首帧：${usable[0].name}`);
          $('#camHint').textContent = `${usable[0].name} · 本地画面仍在连接，正在等待摄像头响应…`;
        }
      }, 8000);
      setTimeout(async () => {
        if (
          generation !== state.cameraGeneration
          || state.remoteActive
          || video.videoWidth
          || state.activeCamera?.did !== usable[0].did
        ) return;
        log.warn('Camera', `本地画面 15 秒无首帧，自动切换远程：${usable[0].name}`);
        toast('本地画面未出画，已自动切换远程');
        $('#camHint').textContent = `${usable[0].name} · 本地未出画，正在切换远程连接…`;
        await startRemoteCamera(usable[0]);
      }, 15000);
      setTimeout(() => diagnoseLocalTimeout(usable[0], video, generation), 25000);
    }
    $('#camGridToggle').textContent = grid ? '单画面' : '宫格';
  } catch (error) {
    log.error('Camera', `本地画面启动失败：${error}`);
    if (generation !== undefined && generation !== state.cameraGeneration) return;
    await stopCameraNow('本地启动失败');
    $('#camHint').textContent = `启动摄像头失败：${error}`;
  }
}

function watchRemote(video, camera, onStall, generation) {
  const previousTimer = state.cameraWatches.get(camera.did);
  if (previousTimer) {
    clearInterval(previousTimer);
    state.remoteWatches = state.remoteWatches.filter((item) => item !== previousTimer);
  }
  let lastTime = -1;
  let lastFrames = -1;
  let stalled = 0;
  let hadFrames = false;
  const startedAt = Date.now();
  const firstFrameTimeout = state.remoteActive ? REMOTE_FIRST_FRAME_TIMEOUT : 30000;
  const removeWatch = () => {
    clearInterval(timer);
    state.remoteWatches = state.remoteWatches.filter((item) => item !== timer);
    if (state.cameraWatches.get(camera.did) === timer) {
      state.cameraWatches.delete(camera.did);
    }
    if (state.remoteWatch === timer) state.remoteWatch = null;
  };
  const triggerRestart = (reason) => {
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? 'unknown';
    log.warn(
      'Camera',
      `${reason}，准备重连：${camera.name} `
      + `(ready=${video.readyState}, paused=${video.paused}, width=${video.videoWidth}, `
      + `time=${video.currentTime}, frames=${frames})`,
    );
    removeWatch();
    onStall();
  };
  const timer = setInterval(() => {
    if (generation !== state.cameraGeneration || !state.cameraStreams.some((stream) => stream.id === camera.did)) {
      removeWatch();
      return;
    }
    if (video.videoWidth) hadFrames = true;
    if (!hadFrames && Date.now() - startedAt >= firstFrameTimeout) {
      triggerRestart('画面长时间没有首帧');
      return;
    }
    // MSE may briefly drop out of HAVE_CURRENT_DATA while it trims its live
    // buffer. Judge stalls by decoded progress instead of readyState alone.
    if (video.paused) {
      stalled = 0;
      return;
    }
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality ? quality.totalVideoFrames : video.webkitDecodedFrameCount;
    const useFrames = typeof frames === 'number' && frames > 0;
    const frozen = useFrames
      ? lastFrames >= 0 && frames <= lastFrames
      : Math.abs(video.currentTime - lastTime) < 0.05;
    if (frozen) {
      stalled += 1;
      if (stalled >= CAMERA_STALL_INTERVALS) {
        triggerRestart('画面停滞');
      }
    } else {
      stalled = 0;
      lastTime = video.currentTime;
      if (useFrames) lastFrames = frames;
    }
  }, 1800);
  state.cameraWatches.set(camera.did, timer);
  state.remoteWatches.push(timer);
  state.remoteWatch = timer;
  return timer;
}

async function restartRemoteCamera(camera, video, generation) {
  if (!camera || generation !== state.cameraGeneration || state.restartingCameras.has(camera.did)) return;
  const existingTimer = state.restartTimers.get(camera.did);
  if (existingTimer) clearTimeout(existingTimer);
  state.restartTimers.delete(camera.did);
  state.restartingCameras.add(camera.did);
  log.warn('Camera', `远程画面重连：${camera.name}`);
  $('#camHint').textContent = `${camera.name} 画面停住，正在重连…`;
  try {
    await invoke('camera_remote_stop', { did: camera.did }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (generation !== state.cameraGeneration) return;
    const stream = await invoke('camera_remote_start', {
      did: camera.did, quality: 1, audio: !state.cameraGrid,
    });
    if (generation !== state.cameraGeneration) return;
    state.cameraStreams = state.cameraStreams.map((item) => item.id === camera.did ? stream : item);
    video.muted = state.remoteAudio.get(camera.did) !== true;
    attachCameraStream(
      video,
      stream,
      camera,
      generation,
      () => restartRemoteCamera(camera, video, generation),
    );
    $('#camHint').textContent = `${camera.name} · 已自动重连`;
    state.restartAttempts.delete(camera.did);
    watchRemote(video, camera, () => restartRemoteCamera(camera, video, generation), generation);
  } catch (error) {
    log.error('Camera', `远程画面重连失败：${camera.name} ${error}`);
    $('#camHint').textContent = `自动重连失败：${error}`;
    // Back off 5 s, 10 s, 20 s … up to 60 s so an unreachable camera in a
    // grid does not hit the relay every few seconds for as long as it is open.
    const attempts = (state.restartAttempts.get(camera.did) || 0) + 1;
    state.restartAttempts.set(camera.did, attempts);
    const delay = Math.min(60000, 5000 * 2 ** (attempts - 1));
    const timer = setTimeout(() => {
      state.restartTimers.delete(camera.did);
      if (generation === state.cameraGeneration && state.remoteActive) {
        restartRemoteCamera(camera, video, generation);
      }
    }, delay);
    state.restartTimers.set(camera.did, timer);
  } finally {
    state.restartingCameras.delete(camera.did);
  }
}

async function restartLocalCamera(camera, generation) {
  const key = `local:${camera.did}`;
  if (generation !== state.cameraGeneration || state.restartingCameras.has(key)) return;
  state.restartingCameras.add(key);
  log.warn('Camera', `本地画面重连：${camera.name}`);
  $('#camHint').textContent = `${camera.name} 画面停住，正在重建本地通道…`;
  try {
    const activeDids = new Set(state.cameraStreams.map((stream) => stream.id));
    const cameras = state.cameras.filter((item) => activeDids.has(item.did));
    await startCameraSet(cameras.length ? cameras : [camera], state.cameraGrid);
  } finally {
    state.restartingCameras.delete(key);
  }
}

function stopCamera() {
  return queueCameraOperation(() => stopCameraNow('页面或账号切换'));
}

async function stopCameraNow(reason = '未知') {
  const requestId = ++state.cameraStopSequence;
  log.debug('Camera', `停止摄像头页面：${reason} request=${requestId}`);
  state.cameraGeneration += 1;
  if (state.remoteWatch) { clearInterval(state.remoteWatch); state.remoteWatch = null; }
  for (const timer of state.remoteWatches) clearInterval(timer);
  state.remoteWatches = [];
  state.cameraWatches.clear();
  state.cameraStreams = [];
  state.activeCamera = null;
  state.cameraSessionStartedAt = null;
  state.cameraPaused = false;
  state.remoteActive = false;
  state.remoteAudio.clear();
  state.cameraControlsRequest += 1;
  for (const cleanup of state.streamCleanups) cleanup();
  state.streamCleanups = new Set();
  state.videoPlayers = new WeakMap();
  for (const timer of state.restartTimers.values()) clearTimeout(timer);
  state.restartTimers.clear();
  state.restartAttempts.clear();
  state.restartingCameras.clear();
  $('#camControls').hidden = true;
  const video = $('#camVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  $('#camEmpty').hidden = false;
  $('#camGrid').hidden = true;
  $('#camGrid').replaceChildren();
  $('#camLayout').hidden = false;
  updateCameraGridPager();
  $('#camClock').textContent = '--:--:--';
  $('#camTransport').textContent = '已停止';
  document.querySelector('.camera-frame.theater')?.classList.remove('theater');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  updateCameraToolState();
  const selected = state.cameras.find((camera) => camera.did === state.selectedCameraDid);
  if (selected) updateCameraStage(selected, null, false);
  if (invoke) {
    try { await invoke('camera_stop', { requestId }); } catch (_) {}
  }
}

$('#overviewNav').onclick = showOverview;
$('#devicesNav').onclick = showDevices;
$('#cameraNav').onclick = showCameras;
$('#sceneNav').onclick = showScenes;
$('#automationNav').onclick = showAutomations;
$('#accessNav').onclick = showAccess;
$('#settingsNav').onclick = showSettings;
$('#accountButton').onclick = (event) => {
  event.stopPropagation();
  if ($('#accountPop').classList.contains('open')) closeAccountPop();
  else openAccountPop();
};
$('#settingsAccounts').onclick = (event) => {
  event.stopPropagation();
  openAccountPop();
};
$('#settingsAccess').onclick = showAccess;
$('#settingsQuickDevices').onclick = () => openQuickPick('devices');
$('#settingsQuickScenes').onclick = () => openQuickPick('scenes');
$('#quickPickClose').onclick = closeQuickPick;
$('#quickPickSave').onclick = saveQuickPick;
$('#quickPickClear').onclick = () => {
  state.quickPick.selected = [];
  renderQuickPickList();
};
$('#quickPickSearch').addEventListener('input', (event) => {
  state.quickPick.query = event.target.value;
  renderQuickPickList();
});
quickPickLayer().addEventListener('click', (event) => {
  if (event.target === quickPickLayer()) closeQuickPick();
});
$('#accessRefresh').onclick = () => loadAccess(true);
$('#accessReconnect').onclick = async () => {
  const button = $('#accessReconnect');
  button.disabled = true;
  button.textContent = '重连中…';
  try {
    const snapshot = await invoke('integration_reconnect_platform', {
      platform: state.access.platform,
    });
    renderAccess(snapshot, false);
    toast('已发起重连');
  } catch (error) {
    toast(String(error), true);
    button.disabled = false;
    button.textContent = '重新连接';
  }
};
document.querySelectorAll('[data-access-platform]').forEach((button) => {
  button.onclick = () => {
    state.access.platform = button.dataset.accessPlatform;
    state.access.pairing = null;
    state.access.draftMode = null;
    document.querySelectorAll('[data-access-platform]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    renderAccess(state.access.snapshot, true);
  };
});
$('#accessConnectionMode').onchange = () => {
  state.access.draftMode = $('#accessConnectionMode').value;
  renderAccess(state.access.snapshot, false);
};
$('#accessPlatformForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveAccessPlatform();
});
$('#testPlatform').onclick = testAccessPlatform;
$('#accessGatewayEnabled').onchange = toggleGateway;
$('#accessGatewayPort').onchange = () => {
  if ($('#accessGatewayEnabled').checked) toggleGateway();
};
$('#revealGatewayToken').onclick = revealGatewayToken;
$('#copyGatewayToken').onclick = async () => {
  if (!state.access.token) {
    try {
      state.access.token = await invoke('integration_reveal_gateway_token');
    } catch (error) {
      return toast(String(error), true);
    }
  }
  copyText(state.access.token, '网关令牌');
};
$('#copyGatewayEndpoint').onclick = () => copyText($('#accessGatewayEndpoint').value, '网关地址');
$('#copyWebhookUrl').onclick = () => {
  const url = $('#accessWebhookPath').dataset.url;
  copyText(url, '完整回调地址');
};
$('#generatePairCode').onclick = generateAccessPairCode;
$('#pairCommand').onclick = () => {
  if (state.access.pairing) copyText(`配对 ${state.access.pairing.code}`, '配对命令');
};
$('#accessBindings').onclick = async (event) => {
  const button = event.target.closest('[data-revoke-binding]');
  if (!button) return;
  try {
    const snapshot = await invoke('integration_revoke_binding', { id: button.dataset.revokeBinding });
    renderAccess(snapshot, true);
    toast('已解除会话绑定');
  } catch (error) {
    toast(String(error), true);
  }
};
$('#assistantTestSend').onclick = sendAssistantTest;
$('#assistantTestInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) sendAssistantTest();
});
$('#llmForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveLlmSettings();
});
$('#llmEnabled').onchange = () => saveLlmSettings();
$('#testLlm').onclick = testLlmConnection;
$('#asrForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveAsrSettings();
});
$('#asrProvider').onchange = updateAsrProviderFields;
$('#asrEnabled').onchange = () => saveAsrSettings();
$('#testAsr').onclick = testAsrConnection;
$('#openPlatformDocs').onclick = () => {
  const url = (accessPlatforms[state.access.platform] || accessPlatforms.feishu).docs;
  invoke?.('open_external_url', { url }).catch((error) => toast(String(error), true));
};
$('#copyAdminChecklist').onclick = () => copyText(adminChecklist(), '管理员清单');
$('#copyUserOnboarding').onclick = () => copyText(userOnboardingText(), '用户引导');
$('#accountPopClose').onclick = closeAccountPop;
$('#addAccountButton').onclick = (event) => {
  event.stopPropagation();
  closeAccountPop();
  showLogin('add');
  startAuth();
};
$('#removeAccountButton').onclick = () => logoutAccount();
$('#loginBack').onclick = cancelAddAccount;
document.addEventListener('click', (event) => {
  const pop = $('#accountPop');
  if (!pop.classList.contains('open')) return;
  if (pop.contains(event.target) || event.target.closest('#accountButton, #settingsAccounts')) return;
  closeAccountPop();
});
$('#refreshScenes').onclick = loadScenes;
$('#autoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const days = [...document.querySelectorAll('#autoDays input:checked')].map((input) => Number(input.value));
  if (!days.length) return toast('至少选择一个星期', true);
  const automation = {
    id: '',
    name: $('#autoName').value.trim(),
    time: $('#autoTime').value,
    days,
    scene_id: $('#autoScene').value,
    home_id: state.homeId,
    enabled: true,
    last_run: null,
  };
  try {
    state.automations = await invoke('save_automation', { automation });
    renderAutomations();
    $('#autoName').value = '';
    toast('定时任务已保存');
    renderOverview(true);
  } catch (error) {
    toast(String(error), true);
  }
});
document.addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle-auto]');
  if (toggle) {
    try { state.automations = await invoke('toggle_automation', { id: toggle.dataset.toggleAuto, enabled: toggle.checked }); renderAutomations(); }
    catch (error) { toast(String(error), true); }
    return;
  }
  const remove = event.target.closest('[data-delete-auto]');
  if (remove) {
    try { state.automations = await invoke('delete_automation', { id: remove.dataset.deleteAuto }); renderAutomations(); }
    catch (error) { toast(String(error), true); }
  }
});
document.addEventListener('click', async (event) => {
  const run = event.target.closest('[data-run-scene]');
  if (!run) return;
  run.disabled = true;
  run.textContent = '执行中';
  try {
    await invoke('run_scene', { sceneId: run.dataset.runScene, homeId: state.homeId });
    toast('场景已执行');
  } catch (error) {
    toast(String(error), true);
  } finally {
    run.disabled = false;
    run.textContent = '执行';
  }
});
$('#camReload').onclick = loadCameras;
$('#camRemoteGrid').onclick = () => startCameraGrid(true);
$('#camLocalButton').onclick = () => {
  const camera = state.cameras.find((item) => item.did === state.selectedCameraDid);
  if (!camera) return toast('先选择一台摄像头', true);
  startCameraSet([camera], false);
};
$('#camRemoteButton').onclick = () => {
  const camera = state.cameras.find((item) => item.did === state.selectedCameraDid);
  if (!camera) return toast('先选择一台摄像头', true);
  startRemoteCamera(camera);
};

function activeCameraVideo() {
  if (!state.cameraGrid) return $('#camVideo');
  return [...document.querySelectorAll('#camGrid video')]
    .find((video) => video.videoWidth > 0)
    || document.querySelector('#camGrid video');
}

function updateCameraToolState() {
  const pause = $('#camPause');
  const sound = $('#camSound');
  const camera = state.activeCamera;
  const soundOn = Boolean(camera && state.remoteAudio.get(camera.did));
  pause.classList.toggle('active', state.cameraPaused);
  sound.classList.toggle('active', soundOn);
  pause.innerHTML = `${uiIcon(state.cameraPaused ? 'play' : 'pause')}${state.cameraPaused ? '继续' : '暂停'}`;
  sound.innerHTML = `${uiIcon('volume')}${soundOn ? '静音' : '声音'}`;
}

$('#camPause').onclick = () => {
  const videos = state.cameraGrid
    ? [...document.querySelectorAll('#camGrid video')]
    : [$('#camVideo')];
  if (!videos.length) return;
  state.cameraPaused = !state.cameraPaused;
  for (const video of videos) {
    if (state.cameraPaused) video.pause();
    else video.play().catch((error) => log.warn('Camera', `继续播放失败：${error}`));
  }
  updateCameraToolState();
  $('#camHint').textContent = state.cameraPaused ? '画面已暂停，取流通道保持连接' : '画面已继续播放';
};

$('#camSound').onclick = () => {
  const camera = state.activeCamera;
  const video = activeCameraVideo();
  if (!camera || !video) return toast('先打开一路摄像头画面', true);
  const next = !state.remoteAudio.get(camera.did);
  if (next && !setCameraAudio(video, true, camera.name)) {
    state.remoteAudio.set(camera.did, false);
    updateCameraToolState();
    toast('当前通道没有可用音轨；本地播放通常只有视频。', true);
    return;
  }
  if (!next) setCameraAudio(video, false, camera.name);
  state.remoteAudio.set(camera.did, next);
  updateCameraToolState();
  $('#camHint').textContent = `${camera.name} · 声音${next ? '已打开' : '已关闭'}`;
  renderCameraControls(camera, state.remoteActive).catch(() => {});
};

$('#camSnapshot').onclick = () => {
  const video = activeCameraVideo();
  const camera = state.activeCamera;
  if (!video || !camera || !video.videoWidth || !video.videoHeight) {
    return toast('画面还没有首帧，暂时无法截图', true);
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return toast('截图生成失败', true);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `${camera.name.replace(/[\\/:*?"<>|]/g, '-')}-${stamp}.png`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('截图已生成');
  }, 'image/png');
};

$('#camFullScreen').onclick = async () => {
  const frame = document.querySelector('#cameraFrame, .camera-frame');
  if (!frame) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (frame.requestFullscreen) {
      await frame.requestFullscreen();
    } else {
      frame.classList.toggle('theater');
    }
  } catch (error) {
    frame.classList.toggle('theater');
    log.warn('Camera', `原生全屏不可用，已切换窗口内全屏：${error}`);
  }
};

$('#camPtzOverlay').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ptz-dir]');
  const camera = state.activeCamera;
  if (!button || !camera) return;
  const direction = button.dataset.ptzDir;
  button.disabled = true;
  try {
    await invoke('camera_remote_ptz', { did: camera.did, direction });
    toast(`云台${button.getAttribute('aria-label').replace('云台', '')}指令已发送`);
  } catch (error) {
    log.error('Camera', `云台命令失败：${camera.name} ${direction} ${error}`);
    toast(`云台命令失败：${error}`, true);
  } finally {
    button.disabled = state.remoteActive !== true;
  }
});

function gridCandidates(remote) {
  return filteredCameras().filter((camera) => camera.online && (remote || camera.ip));
}

function gridPageInfo(remote, page) {
  const candidates = gridCandidates(remote);
  const size = remote ? MAX_REMOTE_STREAMS : MAX_LOCAL_GRID_STREAMS;
  const pages = Math.max(1, Math.ceil(candidates.length / size));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  return {
    cameras: candidates.slice(current * size, current * size + size),
    page: current,
    pages,
    size,
  };
}

// Opens one page of the grid. Without an explicit page it starts from the page
// that contains the selected camera.
function startCameraGrid(remote, page) {
  let target = page;
  if (target === undefined) {
    const index = gridCandidates(remote).findIndex((camera) => camera.did === state.selectedCameraDid);
    target = index > 0 ? Math.floor(index / (remote ? MAX_REMOTE_STREAMS : MAX_LOCAL_GRID_STREAMS)) : 0;
  }
  const info = gridPageInfo(remote, target);
  if (!info.cameras.length) {
    $('#camHint').textContent = remote ? '没有在线摄像头' : '没有在线且带局域网地址的摄像头';
    return null;
  }
  state.cameraGridPage = info.page;
  return remote ? startRemoteCameraSet(info.cameras, true) : startCameraSet(info.cameras, true);
}

function updateCameraGridPager() {
  const pager = $('#camGridPager');
  if (!pager) return;
  const info = gridPageInfo(state.remoteActive, state.cameraGridPage);
  pager.hidden = !state.cameraGrid || $('#camGrid').hidden || info.pages < 2;
  $('#camGridPageLabel').textContent = `${info.page + 1} / ${info.pages}`;
  $('#camGridPrev').disabled = info.page <= 0;
  $('#camGridNext').disabled = info.page >= info.pages - 1;
}

$('#camGridPrev').onclick = () => startCameraGrid(state.remoteActive, state.cameraGridPage - 1);
$('#camGridNext').onclick = () => startCameraGrid(state.remoteActive, state.cameraGridPage + 1);

$('#camGridToggle').onclick = () => {
  if (state.cameraGrid) {
    const remote = state.remoteActive;
    const candidates = gridCandidates(remote);
    const camera = candidates.find((item) => item.did === state.selectedCameraDid) || candidates[0];
    if (!camera) return;
    if (remote) startRemoteCameraSet([camera], false);
    else startCameraSet([camera], false);
  } else {
    startCameraGrid(state.remoteActive);
  }
};

$('#startAuth').onclick = startAuth;
$('#reload').onclick = loadDevices;
$('#camSearch').addEventListener('input', (event) => {
  state.cameraQuery = event.target.value;
  applyCameraFilter();
  updateCameraGridPager();
});
$('#deviceSearch').addEventListener('input', (event) => {
  state.deviceQuery = event.target.value;
  renderDevices();
});
document.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-device-filter]');
  if (!filter) return;
  state.deviceFilter = filter.dataset.deviceFilter;
  renderDevices();
});
async function exportDiagnostics(button = $('#exportLog')) {
  if (!invoke) return;
  button.disabled = true;
  log.info('Log', '用户请求导出诊断日志');
  try {
    await invoke('log_export');
    toast('诊断日志已导出，并已在访达中显示');
  } catch (error) {
    log.error('Log', `导出诊断日志失败：${error}`);
    toast(`导出诊断日志失败：${error}`, true);
  } finally {
    button.disabled = false;
  }
}
$('#exportLog').onclick = () => exportDiagnostics($('#exportLog'));
$('#settingsExportLog').onclick = () => exportDiagnostics($('#settingsExportLog'));
$('#logout').onclick = async () => {
  await logoutAccount();
};
$('#settingsLogout').onclick = async () => {
  await logoutAccount();
};

async function logoutAccount() {
  if (state.accountTransition) return;
  const previous = activeAccount();
  state.accountTransition = true;
  state.polling = false;
  closeAccountPop();
  setShellEnabled(false);
  setStatus('正在退出当前账号，旧账号数据已隐藏…');
  await resetAccountScopedState('退出账号');
  let logoutError = null;
  let result = null;
  try {
    result = await invoke('auth_logout');
  } catch (error) {
    logoutError = error;
  }
  if (!logoutError && result) {
    state.accounts = Array.isArray(result.accounts) ? result.accounts : state.accounts;
    if (result.active_user_id) {
      state.loggedIn = true;
      await loadHomes();
      toast(previous ? `已退出 ${accountLabel(previous)}，已切换到其他账号` : '已切换到其他账号');
    } else {
      state.loggedIn = false;
      state.accounts = [];
      renderAccounts();
      showLogin('initial');
      $('#startAuth').disabled = false;
      setStatus('未登录');
    }
  } else {
    state.loggedIn = true;
    await loadAccounts();
    await loadHomes().catch(() => {});
    if (logoutError) toast(`退出当前账号失败：${logoutError}`, true);
  }
  state.accountTransition = false;
  setShellEnabled(state.loggedIn);
}

function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem('mihome-theme', theme);
  const button = $('#btnTheme');
  if (button) {
    button.innerHTML = uiIcon(theme === 'light' ? 'moon' : 'sun');
    button.setAttribute('aria-label', theme === 'light' ? '切换到深色外观' : '切换到浅色外观');
    button.title = theme === 'light' ? '切换到深色外观' : '切换到浅色外观';
  }
  updateSettingsSelection();
}

function applyStyle(style) {
  state.style = style === 'classic' ? 'classic' : 'modern';
  document.body.dataset.style = state.style;
  localStorage.setItem('mihome-style', state.style);
  updateSettingsSelection();
  if (state.page === 'overview' && $('#overviewView .device-row')) renderOverview(true);
}

function updateSettingsSelection() {
  document.querySelectorAll('[data-theme-set]').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeSet === state.theme);
  });
  document.querySelectorAll('[data-style-set]').forEach((button) => {
    button.classList.toggle('active', button.dataset.styleSet === state.style);
  });
  document.querySelectorAll('[data-density-set]').forEach((button) => {
    button.classList.toggle('active', button.dataset.densitySet === state.density);
  });
}

function toggleEnvironmentPopover(force) {
  const capsule = $('#envCapsule');
  const popover = $('#envPopover');
  if (!capsule || !popover) return;
  const open = force ?? popover.hidden;
  popover.hidden = !open;
  capsule.setAttribute('aria-expanded', String(open));
}

document.addEventListener('click', (event) => {
  const environmentCapsule = event.target.closest('#envCapsule');
  if (environmentCapsule) {
    toggleEnvironmentPopover();
    return;
  }
  if (!event.target.closest('#envWrap')) toggleEnvironmentPopover(false);
  const themeButton = event.target.closest('[data-theme-set]');
  if (themeButton) {
    applyTheme(themeButton.dataset.themeSet);
    return;
  }
  const styleButton = event.target.closest('[data-style-set]');
  if (styleButton) {
    applyStyle(styleButton.dataset.styleSet);
    return;
  }
  const densityButton = event.target.closest('[data-density-set]');
  if (densityButton) {
    state.density = densityButton.dataset.densitySet;
    document.body.dataset.density = state.density;
    localStorage.setItem('mihome-density', state.density);
    updateSettingsSelection();
    if (state.page === 'overview') renderOverview(true);
  }
});

function toggleQuickPanel(force) {
  const panel = $('#menubarPop');
  if (!panel) return;
  const open = force ?? !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', String(!open));
  if (open) renderQuickPanel();
}

function renderQuickPanel() {
  const sensor = state.devices.find((device) => deviceKind(device) === 'temp-humidity');
  const values = overviewSensorValues(sensor);
  const temperature = Number(values.temperature);
  const humidity = Number(values.humidity);
  const online = state.devices.filter((device) => device.online).length;
  $('#popEnv').textContent = Number.isFinite(temperature) ? `${temperature.toFixed(1)}°` : `${online}`;
  $('#popEnvSub').textContent = Number.isFinite(temperature)
    ? `${uiText('湿度 {0}', [Number.isFinite(humidity) ? `${humidity.toFixed(0)}%` : '—'])}\n${uiText('在线 {0}/{1}', [online, state.devices.length])}`
    : uiText('设备在线 {0}', [state.devices.length]);

  const grid = $('#popGrid');
  grid.replaceChildren();
  // Quick controls: online devices with a switch first, cameras last, so an
  // account with 100+ cameras still shows lights and plugs here.
  const rank = (device) => {
    const switchable = cardProfile(device).controls.some((item) => item.primary);
    return (device.online ? 4 : 0) + (switchable ? 2 : 0) + (cameraForDevice(device) ? 0 : 1);
  };
  const candidates = state.devices
    .map((device, index) => ({ device, index, rank: rank(device) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .slice(0, 4)
    .map((item) => item.device);
  for (const device of candidates) {
    const row = el('div', 'pop-device');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `打开 ${device.name}`);
    const glyph = el('span', 'pop-device-icon');
    glyph.innerHTML = uiIcon('sliders');
    row.append(glyph, el('span', 'pop-device-label', device.name));
    const primary = cardProfile(device).controls.find((item) => item.primary);
    if (primary && device.online) row.append(inlineDeviceSwitch(device, primary));
    const openDevice = () => {
      toggleQuickPanel(false);
      selectDevice(device);
    };
    row.onclick = (event) => {
      if (event.target.closest('button')) return;
      openDevice();
    };
    row.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDevice();
      }
    };
    grid.append(row);
  }
  if (!candidates.length) grid.append(el('div', 'palette-empty', '暂无设备'));

  const scenes = $('#popScenes');
  scenes.replaceChildren();
  for (const scene of state.scenes.slice(0, 3)) {
    const button = el('button', '', scene.name);
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await invoke('run_scene', { sceneId: scene.id, homeId: state.homeId });
        toast(`「${scene.name}」已执行`);
      } catch (error) {
        toast(String(error), true);
      } finally {
        button.disabled = false;
      }
    };
    scenes.append(button);
  }
}

const hud = { on: false, frames: [], last: 0, raf: 0, timer: 0 };

function toggleHud(force) {
  const panel = $('#hud');
  if (!panel) return;
  hud.on = force ?? !hud.on;
  panel.classList.toggle('show', hud.on);
  panel.setAttribute('aria-hidden', String(!hud.on));
  if (hud.on) {
    hud.last = 0;
    runtimeLog('性能面板已打开');
    updateHud();
    hud.raf = requestAnimationFrame(hudLoop);
    hud.timer = setInterval(updateHud, 500);
  } else {
    cancelAnimationFrame(hud.raf);
    clearInterval(hud.timer);
    hud.raf = 0;
    hud.timer = 0;
  }
}

function updateHud() {
  const frame = hud.frames.length ? hud.frames[hud.frames.length - 1] : 0;
  const heap = performance.memory?.usedJSHeapSize;
  $('#hudFrame').textContent = frame ? `${(1000 / frame).toFixed(1)} ms` : '--';
  $('#hudRender').textContent = runtime.lastRenderMs ? `${runtime.lastRenderMs.toFixed(1)} ms` : '--';
  $('#hudHeap').textContent = heap ? `${(heap / 1048576).toFixed(1)} MB` : '—';
  $('#hudInflight').textContent = String(runtime.inflight);
  $('#hudLastRequest').textContent = runtime.lastRequestMs ? `${runtime.lastRequestMs.toFixed(0)} ms` : '--';
  $('#hudDom').textContent = String(document.querySelectorAll('*').length);
}

function hudLoop(timestamp) {
  if (!hud.on) return;
  if (hud.last) {
    const elapsed = timestamp - hud.last;
    if (elapsed > 0) {
      hud.frames.push(1000 / elapsed);
      hud.frames = hud.frames.slice(-60);
      $('#hudFps').textContent = String(Math.round(1000 / elapsed));
    }
  }
  hud.last = timestamp;
  drawHudGraph();
  updateHud();
  hud.raf = requestAnimationFrame(hudLoop);
}

function drawHudGraph() {
  const canvas = $('#hudGraph');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (hud.frames.length < 2) return;
  const min = 30;
  const max = Math.max(144, ...hud.frames);
  ctx.beginPath();
  hud.frames.forEach((fps, index) => {
    const x = (index / Math.max(1, hud.frames.length - 1)) * width;
    const y = height - ((Math.max(min, Math.min(max, fps)) - min) / (max - min)) * height;
    if (index) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#7f9b8a';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

async function loadAll() {
  await loadDevices();
  await Promise.allSettled([loadScenes(), loadCameras(), loadAutomations()]);
  renderOverview(true);
  updateChrome();
}

function paletteSource() {
  const items = state.devices.map((device) => {
    const camera = cameraForDevice(device);
    return {
      group: '设备',
      label: device.name,
      sub: `${roomName(device)} · ${device.online ? '在线' : '离线'}`,
      icon: camera ? 'camera' : 'sliders',
      // Cameras open the monitor page with that camera selected.
      run: () => (camera ? openCameraDevice(device) : selectDevice(device)),
    };
  });
  for (const scene of state.scenes) {
    items.push({
      group: '场景',
      label: scene.name,
      sub: '执行手动场景',
      icon: 'spark',
      run: () => invoke('run_scene', { sceneId: scene.id, homeId: state.homeId })
        .then(() => toast(`「${scene.name}」已执行`))
        .catch((error) => toast(String(error), true)),
    });
  }
  items.push({
    group: '操作',
    label: '刷新全部状态',
    sub: '家庭、设备、场景、摄像头与自动化',
    icon: 'history',
    run: loadAll,
  }, {
    group: '操作',
    label: '导出诊断日志',
    sub: '打开访达中的日志文件',
    icon: 'gear',
    run: () => exportDiagnostics($('#exportLog')),
  });
  return items;
}

function renderPalette(query = '') {
  const needle = query.trim().toLowerCase();
  const all = paletteSource();
  state.paletteItems = needle
    ? all.filter((item) => `${item.group} ${item.label} ${item.sub}`.toLowerCase().includes(needle))
    : all;
  state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, state.paletteItems.length - 1));
  const box = $('#paletteResults');
  if (!state.paletteItems.length) {
    box.innerHTML = '<div class="palette-empty">没有匹配的设备或操作</div>';
    return;
  }
  const groups = new Map();
  state.paletteItems.forEach((item, index) => {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push({ ...item, index });
  });
  box.innerHTML = [...groups.entries()].map(([group, items]) =>
    `<div class="palette-group">${esc(group)}</div>${items.map((item) =>
      `<button class="palette-item ${item.index === state.paletteIndex ? 'active' : ''}" data-palette-index="${item.index}">
        ${uiIcon(item.icon)}<span>${esc(item.label)}</span><span class="sub">${esc(item.sub)}</span>
      </button>`).join('')}`).join('');
}

function openPalette() {
  $('#palette').classList.add('open');
  $('#palette').setAttribute('aria-hidden', 'false');
  $('#paletteInput').value = '';
  state.paletteIndex = 0;
  renderPalette('');
  setTimeout(() => $('#paletteInput').focus(), 20);
}

function closePalette() {
  $('#palette').classList.remove('open');
  $('#palette').setAttribute('aria-hidden', 'true');
}

function runPalette() {
  const item = state.paletteItems[state.paletteIndex];
  if (!item) return;
  closePalette();
  setTimeout(() => item.run(), 30);
}

$('#btnPalette').onclick = openPalette;
$('#btnMenuBar').onclick = (event) => {
  event.stopPropagation();
  toggleQuickPanel();
};
$('#btnMenuBar2').onclick = (event) => {
  event.stopPropagation();
  toggleQuickPanel();
};
$('#btnTheme').onclick = () => applyTheme(state.theme === 'light' ? 'dark' : 'light');
$('#btnAddRoom').onclick = () => toast('房间由米家 App 管理；当前接口不支持在本机创建房间', true);
$('#btnHud').onclick = () => toggleHud();
$('#hudClose').onclick = () => toggleHud(false);
$('#popOpen').onclick = () => {
  toggleQuickPanel(false);
  showOverview();
};
$('#paletteInput').oninput = () => {
  state.paletteIndex = 0;
  renderPalette($('#paletteInput').value);
};

// Moving the highlight only swaps one class instead of re-rendering every
// device row, and keeps the highlighted row visible in long lists.
function setPaletteIndex(index) {
  state.paletteIndex = index;
  const box = $('#paletteResults');
  box.querySelector('.palette-item.active')?.classList.remove('active');
  const node = box.querySelector(`[data-palette-index="${index}"]`);
  node?.classList.add('active');
  node?.scrollIntoView({ block: 'nearest' });
}
$('#paletteResults').onclick = (event) => {
  const item = event.target.closest('[data-palette-index]');
  if (!item) return;
  state.paletteIndex = Number(item.dataset.paletteIndex);
  runPalette();
};
$('.palette-backdrop').onclick = closePalette;

document.addEventListener('click', (event) => {
  if (!$('#menubarPop').classList.contains('open')) return;
  if (event.target.closest('#menubarPop, #btnMenuBar, #btnMenuBar2')) return;
  toggleQuickPanel(false);
});

document.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === 'Escape' && !quickPickLayer().hidden) {
    closeQuickPick();
    return;
  }
  if ($('#palette').classList.contains('open')) {
    // Enter and arrows also confirm or move the candidate list of a Chinese
    // or Japanese input method; leave them to the IME while composing.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') closePalette();
    if (event.key === 'ArrowDown' && state.paletteItems.length) {
      event.preventDefault();
      setPaletteIndex((state.paletteIndex + 1) % state.paletteItems.length);
    }
    if (event.key === 'ArrowUp' && state.paletteItems.length) {
      event.preventDefault();
      setPaletteIndex((state.paletteIndex - 1 + state.paletteItems.length) % state.paletteItems.length);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runPalette();
    }
    return;
  }
  if (modifier && event.shiftKey && event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggleQuickPanel();
    return;
  }
  if (event.altKey && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    toggleHud();
    return;
  }
  if (modifier && ['1', '2', '3', '4', '5'].includes(event.key)) {
    event.preventDefault();
    [showOverview, showCameras, showScenes, showAutomations, showDevices][Number(event.key) - 1]();
  }
  if (event.key === 'Escape') {
    closeAccountPop();
    closeInspector();
    toggleEnvironmentPopover(false);
  }
});

async function boot() {
  await window.__MIHOME_I18N_READY__;
  applyStaticIcons();
  applyStyle(state.style);
  applyTheme(state.theme);
  document.body.dataset.density = state.density;
  updateSettingsSelection();
  const updateClock = () => {
    $('#statusClock').textContent = new Intl.DateTimeFormat(uiLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const popTime = $('#popTime');
    if (popTime) popTime.textContent = $('#statusClock').textContent;
    $('#camClock').textContent = new Intl.DateTimeFormat(uiLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());
    const playhead = $('#timelinePlayhead');
    if (playhead) {
      const now = new Date();
      playhead.style.left = `${(((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400) * 100).toFixed(3)}%`;
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updatePairingCountdown, 1000);
  setInterval(() => {
    if (state.page === 'access' && !document.hidden) loadAccess(false);
  }, 5000);
  setInterval(() => {
    if (state.loggedIn && !document.hidden) refreshDevicePresence();
  }, DEVICE_PRESENCE_REFRESH_MS);
  window.addEventListener('focus', () => {
    if (state.loggedIn) refreshDevicePresence();
  });
  document.addEventListener('visibilitychange', () => {
    if (state.loggedIn && !document.hidden) refreshDevicePresence();
  });
  renderSidebarRooms();
  if (!invoke) {
    setStatus('请从 MiHome Mac 桌面应用打开这个页面', 'error');
    return;
  }
  await loadAccounts();
  invoke('app_meta').then((meta) => {
    if (meta?.version) $('#appVersion').textContent = meta.version;
  }).catch(() => {});
  try {
    const userId = await invoke('auth_resume');
    if (!userId) {
      showLogin('initial');
      startAuth();
      return;
    }
    state.loggedIn = true;
    log.info('App', '登录状态恢复成功');
    setStatus(`已恢复登录，用户 ${userId}`);
    await loadAccounts();
    await loadHomes();
  } catch (error) {
    log.error('App', `恢复登录失败：${error}`);
    setStatus(`恢复登录失败：${error}`, 'error');
    $('#startAuth').disabled = false;
    state.loggedIn = false;
    showLogin('initial');
  }
}

if (invoke) {
  boot();
}

invoke?.('ui_ready').catch(() => {});
