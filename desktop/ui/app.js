const $ = (selector) => document.querySelector(selector);
const SPEC_BATCH_SIZE = 128;
const MAX_REMOTE_STREAMS = 6;
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

function runtimeLog(message) {
  runtime.logs.unshift(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`);
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
  document.addEventListener(eventName, (event) => event.preventDefault(), true);
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
  overviewSensorLoading: new Set(), overviewSensorHydrated: new Set(),
  sensorSeries: [], paletteIndex: 0, paletteItems: [],
  polling: false, loggedIn: false, cameras: [], cameraStreams: [], cameraGrid: false,
  selectedCameraDid: null, roomFilter: 'all', activeCamera: null, remoteActive: false,
  deviceFilter: 'all', deviceQuery: '', cameraSessionStartedAt: null, cameraPaused: false,
  remoteWatch: null, remoteWatches: [], cameraWatches: new Map(),
  cameraGeneration: 0, cameraControlsRequest: 0,
  cameraStopSequence: 0,
  cameraQueue: Promise.resolve(),
  restartingCameras: new Set(), restartTimers: new Map(), cardProps: new Map(),
  remoteAudio: new Map(),
  videoPlayers: new WeakMap(), streamCleanups: new Set(),
  hydratedCards: new Set(), cardObserver: null, cardHydrationQueue: new Map(),
  cardHydrationTimer: null, specs: new Map(), specErrors: new Map(), specLoading: false, specPending: new Set(),
  devicesRequest: 0, inspectorRequest: 0, scenesRequest: 0, camerasRequest: 0,
  automationsRequest: 0, accountGeneration: 0, accountTransition: false,
  accounts: [], loginMode: 'initial', loginRequest: 0,
  presenceRefreshing: false, lastPresenceSyncAt: 0, presenceSyncFailed: false,
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
  settings: '设置',
};

function updateChrome() {
  document.querySelectorAll('#mainNav [data-nav], .sidebar-footer [data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === state.page);
  });
  const home = currentHome()?.name || 'MiHome';
  const room = state.roomFilter === 'all' ? '' : `${roomGroups().find((item) => item.id === state.roomFilter)?.name || ''} · `;
  $('#windowTitle').textContent = `${room}${PAGE_TITLES[state.page] || '总览'} — ${home}`;
  const online = state.devices.filter((device) => device.online).length;
  const localCameras = state.cameras.filter((camera) => camera.online && camera.ip).length;
  const remoteCameras = state.cameras.filter((camera) => camera.online && !camera.ip).length;
  $('#statusPath').textContent = state.loggedIn
    ? `${online}/${state.devices.length} 台在线 · ${localCameras} 台摄像头本地可达${remoteCameras ? ` · ${remoteCameras} 台仅远程` : ''}`
    : '等待连接';
  setNavCount('devicesCount', state.devices.length);
  setNavCount('cameraCountNav', state.cameras.length);
  $('#camSideCount').textContent = String(state.cameras.length);
  $('#topnavCaption').textContent = localCameras
    ? `${localCameras} 台本地摄像头可达`
    : '本地优先 · 云端兜底';
  const statusSync = $('#statusSync');
  if (statusSync && state.loggedIn) {
    if (state.presenceSyncFailed) {
      statusSync.textContent = '状态同步失败，保留上次结果';
    } else if (state.lastPresenceSyncAt) {
      const time = new Intl.DateTimeFormat('zh-CN', {
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
  updateSettingsSelection();
}

function showView(page) {
  const started = performance.now();
  state.page = page;
  for (const [id, key] of [
    ['overviewView', 'overview'],
    ['devicesView', 'devices'],
    ['cameraView', 'camera'],
    ['sceneView', 'scenes'],
    ['automationView', 'automations'],
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
  return room?.name || '未分房间';
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
  if (/客厅/.test(text)) return '客';
  if (/主卧|卧室/.test(text)) return '卧';
  if (/书房/.test(text)) return '书';
  if (/厨房/.test(text)) return '厨';
  if (/玄关/.test(text)) return '玄';
  if (/阳台/.test(text)) return '阳';
  if (/卫生间|浴室/.test(text)) return '浴';
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
  all.append(el('span', 'room-glyph', '全'), el('span', '', '全部房间'));
  if (state.devices.some((device) => device.online)) all.append(el('i', 'room-dot'));
  all.append(el('span', 'room-count', String(state.devices.length)));
  all.onclick = () => {
    state.roomFilter = 'all';
    showOverview();
  };
  fragment.append(all);
  for (const group of groups) {
    const button = el('button', `room-item ${state.roomFilter === group.id ? 'active' : ''}`);
    button.type = 'button';
    button.dataset.room = group.id;
    button.append(el('span', 'room-glyph', roomShortName(group.name)), el('span', '', group.name));
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
  } catch (error) {
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    $('#deviceList').replaceChildren(el('div', 'empty error', `读取设备失败：${error}`));
    renderSidebarRooms();
  }
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
    ? profileFromSpec(spec)
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
  const request = state.devicesRequest;
  if (requests.length) {
    try {
      const result = await invoke('get_properties', { requests });
      if (currentHome !== state.homeId || request !== state.devicesRequest) return;
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
    return new Intl.NumberFormat('zh-CN').format(number);
  }
  return `${number.toFixed(def.digits ?? 0)}${def.unit || ''}`;
}

async function setCardProp(device, siid, piid, value) {
  const result = await invoke('set_property', { did: device.did, siid, piid, value });
  const item = Array.isArray(result) ? result[0] : result;
  if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
  state.cardProps.set(propKey(device.did, siid, piid), value);
  refreshDeviceCard(device);
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
  button.title = `${def.label} ${on ? '已开启' : '已关闭'}`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(on));
  const bulb = def.label.includes('灯') || def.label.includes('照明');
  button.innerHTML = bulb
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.3 2.2h4.6c.2-1 .7-1.7 1.3-2.2A6 6 0 0 0 12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
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
  copy.append(el('span', '', def.label));
  copy.append(el('small', '', input.checked ? '已开启' : '已关闭'));
  const track = el('span', 'card-switch-track');
  track.append(el('span', 'card-switch-knob'));
  row.append(copy, input, track);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardRange(device, def) {
  const row = el('label', 'card-range');
  const head = el('span', 'card-range-head');
  head.append(el('span', '', def.label));
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
  row.append(el('span', 'card-segments-label', def.label));
  const group = el('div', 'card-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', 'card-segment', label);
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
  const button = el('button', 'card-action', action.label);
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
  if (!device.online) return '设备离线';
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
        return `${range.label} ${number.toFixed(0)}${range.suffix || range.unit || ''}`;
      }
    }
  }
  const primary = profile.controls.find((item) => item.primary);
  if (primary) {
    const value = cardValue(device, primary.siid, primary.piid);
    if (value !== undefined && value !== null) return value ? '已开启' : '已关闭';
  }
  return '在线';
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
  button.setAttribute('aria-label', `${device.name}${def.label}`);
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
  glyph.innerHTML = deviceGlyph(device);
  row.append(glyph);

  const copy = el('div', 'device-id');
  const name = el('div', 'device-name');
  name.append(document.createTextNode(device.name));
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    const camera = state.cameras.find((item) => item.did === device.did);
    name.append(el('span', camera?.ip ? 'tag lan' : 'tag cloud', camera?.ip ? '本地' : '远程'));
  }
  copy.append(name, el('div', 'device-meta', cardSummary(device, profile)));
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

function cameraForDevice(device) {
  return state.cameras.find((camera) => camera.did === device.did) || null;
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
  row.setAttribute('aria-label', `${device.name}，${roomName(device)}，${status.label}`);

  const identity = el('div', 'table-device');
  const glyph = el('span', 'device-icon');
  glyph.dataset.tone = deviceTone(kind);
  glyph.dataset.kind = kind;
  glyph.innerHTML = deviceGlyph(device);
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
  const rows = [...document.querySelectorAll('.device-row, .table-row')]
    .filter((node) => node.dataset.did === device.did);
  for (const old of rows) {
    state.cardObserver?.unobserve(old);
    const replacement = old.classList.contains('table-row')
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
    return `${device.name} ${device.model || ''} ${roomName(device)}`
      .toLowerCase()
      .includes(query);
  });
  $('#devicesEyebrow').textContent = `${state.devices.length} 台设备 · ${localCameras} 台本地摄像头可达`;
  $('#devicesSubtitle').textContent = state.deviceFilter === 'all' && !query
    ? '点任意一行查看属性、连接路径与最近状态。'
    : `当前筛选 ${target.length} 台设备；点击房间可回到总览继续按空间浏览。`;
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
  return new Intl.DateTimeFormat('zh-CN', {
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
    temperature: temperatureDef ? cardValue(sensor, temperatureDef.siid, temperatureDef.piid) : null,
    humidity: humidityDef ? cardValue(sensor, humidityDef.siid, humidityDef.piid) : null,
  };
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
      state.cardProps.set(propKey(item.did, item.siid, item.piid), item.value);
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
      <p class="page-sub">${online}/${state.devices.length} 台设备在线，${localCameras} 台摄像头本地可达，${state.scenes.length} 个手动场景。</p>
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
    copy.append(el('div', 'eyebrow', '实时监控'), el('h3', '', `${state.cameras.length} 台摄像头`));
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
  for (const room of visibleRooms) {
    const section = el('section', 'room-block');
    const head = el('div', 'room-head');
    head.append(el('span', 'room-title', room.name), el('span', 'room-count', `${room.devices.length} 台`), el('span', 'line'));
    const list = el('div', 'device-list');
    const fragment = document.createDocumentFragment();
    for (const device of room.devices) {
      const row = renderDeviceRow(device);
      fragment.append(row);
      observeDeviceCard(row, device);
    }
    list.append(fragment);
    section.append(head, list);
    box.append(section);
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
  card.append(el('span', 'detail-metric-label', def.label));
  card.append(el('strong', '', formatCardValue(value, def)));
  return card;
}

function detailToggle(device, def) {
  const value = Boolean(cardValue(device, def.siid, def.piid));
  const row = el('div', `detail-control-row${def.primary ? ' primary' : ''}`);
  const copy = el('div', 'detail-control-copy');
  copy.append(el('span', 'detail-control-label', def.label));
  copy.append(el('small', 'detail-control-state', value ? '已开启' : '已关闭'));
  const button = el('button', `detail-switch ${value ? 'on' : ''}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(value));
  button.setAttribute('aria-label', `${def.label}${value ? '已开启' : '已关闭'}`);
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
  head.append(el('span', 'detail-control-label', def.label));
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
  row.append(el('span', 'detail-control-label', def.label));
  const group = el('div', 'detail-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', `detail-segment${String(current) === String(value) ? ' active' : ''}`, label);
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

function detailSpecActions(device, profile) {
  const kind = deviceKind(device);
  const actions = (profile.actions || []).filter((action) =>
    !((kind === 'router' || kind === 'tv') && action.siid === 2 && action.aiid === 1));
  if (!actions.length) return null;
  const section = el('section', 'detail-section');
  section.append(el('h4', '', '设备动作'));
  const list = el('div', 'detail-actions');
  for (const action of actions) {
    const button = el('button', 'detail-action secondary', action.label);
    button.type = 'button';
    button.disabled = !device.online;
    button.onclick = async () => {
      if (!confirm(`执行「${action.label}」？`)) return;
      button.disabled = true;
      try {
        await invoke('call_action', {
          did: device.did, siid: action.siid, aiid: action.aiid, params: [],
        });
        toast(`已执行：${action.label}`);
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

  const groups = new Map();
  for (const def of profile.controls) {
    const group = def.group || '控制';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(def);
  }
  for (const [name, items] of groups) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', name));
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
  const specActions = detailSpecActions(device, profile);
  if (specActions) box.append(specActions);

  if (!metrics.length && !profile.controls.length && !action && !specActions) {
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
  const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
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
  await loadCameras();
}

async function showSettings() {
  await stopCamera();
  showView('settings');
  updateSettingsSelection();
}

async function loadCameras() {
  const request = ++state.camerasRequest;
  const list = $('#camList');
  list.replaceChildren(el('div', 'empty', '正在读取摄像头…'));
  try {
    const cameras = await invoke('list_cameras');
    if (request !== state.camerasRequest) return;
    state.cameras = cameras;
    log.info('Camera', `摄像头列表已加载：${cameras.length} 台`);
    setNavCount('cameraCount', state.cameras.length);
    renderCameras();
    renderSidebarRooms();
    if (state.page === 'overview') renderOverview(true);
    updateChrome();
    loadDeviceSpecs(cameras);
  } catch (error) {
    log.error('Camera', `读取摄像头列表失败：${error}`);
    if (request !== state.camerasRequest) return;
    state.cameras = [];
    setNavCount('cameraCount', 0);
    list.replaceChildren(el('div', 'empty error', `读取摄像头失败：${error}`));
    updateChrome();
  }
}

function renderCameras() {
  const list = $('#camList');
  list.replaceChildren();
  $('#camSideCount').textContent = String(state.cameras.length);
  if (!state.cameras.length) {
    list.append(el('div', 'empty', '账号下没有识别到摄像头'));
    $('#camEmpty').textContent = '没有可用摄像头';
    $('#camTitle').textContent = '监控台';
    $('#camSubtitle').textContent = '账号下没有识别到摄像头';
    $('#camSpec').textContent = '无可用通道';
    return;
  }
  if (!state.cameras.some((camera) => camera.did === state.selectedCameraDid)) {
    state.selectedCameraDid = state.cameras[0].did;
  }
  const fragment = document.createDocumentFragment();
  for (const camera of state.cameras) {
    const card = el('div', `cam-card ${state.selectedCameraDid === camera.did ? 'active' : ''}`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.onclick = () => {
      state.selectedCameraDid = camera.did;
      renderCameras();
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
      renderCameras();
      startCameraSet([camera], false);
    };
    const remote = el('button', 'pill remote', '远程');
    remote.type = 'button';
    remote.disabled = !camera.online;
    remote.onclick = (event) => {
      event.stopPropagation();
      state.selectedCameraDid = camera.did;
      renderCameras();
      startRemoteCamera(camera);
    };
    actions.append(local, remote);
    card.append(actions);
    fragment.append(card);
  }
  list.append(fragment);
  const selected = state.cameras.find((camera) => camera.did === state.selectedCameraDid)
    || state.cameras[0];
  if (!state.activeCamera) {
    state.selectedCameraDid = selected?.did || null;
    $('#camEmpty').textContent = '选择一个摄像头';
    if (selected) updateCameraStage(selected, null, false);
  }
}

function updateCameraStage(camera, stream, remote) {
  if (!camera) return;
  $('#camTitle').textContent = camera.name;
  const cameraDevice = state.devices.find((device) => device.did === camera.did);
  $('#camSubtitle').textContent = `${cameraDevice ? roomName(cameraDevice) : '摄像头'} · ${camera.model || '米家摄像头'}`;
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
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now);
  const clock = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  const playhead = ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400) * 100;
  const started = state.cameraSessionStartedAt
    ? new Intl.DateTimeFormat('zh-CN', {
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
  renderCameras();
  updateCameraStage(usable[0], null, true);
  $('#camLayout').hidden = grid;
  $('#camGrid').hidden = !grid;
  $('#camEmpty').hidden = false;
  $('#camEmpty').textContent = '正在连接远程画面…首次约 10–20 秒';
  const selected = grid ? usable.slice(0, MAX_REMOTE_STREAMS) : usable;
  $('#camHint').textContent = grid ? `正在建立 ${selected.length} 路远程画面` : `正在建立远程通道：${usable[0].name}`;
  $('#camGridToggle').textContent = grid ? '单画面' : '宫格';

  let tiles = null;
  let singleVideo = null;
  if (grid) {
    $('#camGrid').replaceChildren();
    $('#camControls').hidden = true;
    tiles = new Map();
    const selectedDids = new Set(selected.map((camera) => camera.did));
    for (const camera of usable) {
      const tile = el('div', 'cam-tile');
      tile.append(el('span', 'cam-tile-title', camera.name));
      const status = el(
        'span',
        'cam-tile-status',
        selectedDids.has(camera.did) ? '正在连接…' : '未启动 · 已达同时显示上限',
      );
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

  try {
    await starts;
    if (generation !== state.cameraGeneration) {
      return;
    }
    if (!readyCount) throw failures[0] || new Error('远程通道没有启动');
    if (failures.length) toast(`${failures.length} 路摄像头取流失败`, true);
    log.info('Camera', `远程画面通道已建立：count=${readyCount} failed=${failures.length}`);
    if (grid) {
      const skipped = usable.length - selected.length;
      $('#camHint').textContent = `${readyCount}/${selected.length} 路远程画面已启动${failures.length ? ` · ${failures.length} 路失败` : ''}${skipped ? ` · 最多同时显示 ${MAX_REMOTE_STREAMS} 路` : ''}`;
      for (const camera of usable.slice(selected.length)) {
        const target = tiles?.get(camera.did);
        if (target) {
          target.status.textContent = '未启动 · 已限制同时显示数量';
          target.status.hidden = false;
        }
      }
    }
  } catch (error) {
    log.error('Camera', `远程画面失败：${String(error)}`);
    if (generation === state.cameraGeneration) await stopCameraNow('远程启动失败');
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

function startCameraSet(cameras, grid) {
  return queueCameraOperation(() => startCameraSetNow(cameras, grid));
}

async function startCameraSetNow(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online && camera.ip);
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
    renderCameras();
    updateCameraStage(usable[0], streams[0], false);
    log.info('Camera', `本地画面地址已返回：count=${streams.length}`);
    renderCameraControls(usable[0], false).catch((error) => {
      log.error('Camera', `渲染本地控制项失败：${error}`);
    });
    if (grid) {
      $('#camLayout').hidden = true;
      $('#camGrid').hidden = false;
      $('#camGrid').replaceChildren();
      for (const stream of streams) {
        const camera = usable.find((item) => item.did === stream.id);
        const tile = el('div', 'cam-tile');
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
        attachCameraStream(
          video,
          stream,
          camera || usable[0],
          generation,
          () => restartLocalCamera(camera || usable[0], generation),
        );
        watchRemote(video, camera || usable[0], () => restartLocalCamera(camera || usable[0], generation), generation);
      }
      $('#camHint').textContent = `${streams.length} 路画面正在建立本地连接`;
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
    watchRemote(video, camera, () => restartRemoteCamera(camera, video, generation), generation);
  } catch (error) {
    log.error('Camera', `远程画面重连失败：${camera.name} ${error}`);
    $('#camHint').textContent = `自动重连失败：${error}`;
    const timer = setTimeout(() => {
      state.restartTimers.delete(camera.did);
      if (generation === state.cameraGeneration && state.remoteActive) {
        restartRemoteCamera(camera, video, generation);
      }
    }, 5000);
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
$('#camRemoteGrid').onclick = () => startRemoteCameraSet(state.cameras, true);
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

$('#camGridToggle').onclick = () => {
  if (state.cameraGrid) {
    if (state.remoteActive) {
      const first = state.cameras.find((camera) => camera.online);
      if (first) startRemoteCameraSet([first], false);
    } else {
      const first = state.cameras.find((camera) => camera.online && camera.ip);
      if (first) startCameraSet([first], false);
    }
  } else {
    if (state.remoteActive) startRemoteCameraSet(state.cameras, true);
    else startCameraSet(state.cameras, true);
  }
};

$('#startAuth').onclick = startAuth;
$('#reload').onclick = loadDevices;
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

function updateSettingsSelection() {
  document.querySelectorAll('[data-theme-set]').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeSet === state.theme);
  });
  document.querySelectorAll('[data-density-set]').forEach((button) => {
    button.classList.toggle('active', button.dataset.densitySet === state.density);
  });
}

document.addEventListener('click', (event) => {
  const themeButton = event.target.closest('[data-theme-set]');
  if (themeButton) {
    applyTheme(themeButton.dataset.themeSet);
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
    ? `湿度 ${Number.isFinite(humidity) ? `${humidity.toFixed(0)}%` : '—'}\n${online}/${state.devices.length} 台在线`
    : `台设备在线\n${state.devices.length} 台设备`;

  const grid = $('#popGrid');
  grid.replaceChildren();
  const candidates = [...state.devices]
    .sort((a, b) => Number(b.online) - Number(a.online))
    .slice(0, 4);
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
  const items = state.devices.map((device) => ({
    group: '设备',
    label: device.name,
    sub: `${roomName(device)} · ${device.online ? '在线' : '离线'}`,
    icon: 'sliders',
    run: () => selectDevice(device),
  }));
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
$('#paletteInput').oninput = () => renderPalette($('#paletteInput').value);
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
  if ($('#palette').classList.contains('open')) {
    if (event.key === 'Escape') closePalette();
    if (event.key === 'ArrowDown' && state.paletteItems.length) {
      event.preventDefault();
      state.paletteIndex = (state.paletteIndex + 1) % state.paletteItems.length;
      renderPalette($('#paletteInput').value);
    }
    if (event.key === 'ArrowUp' && state.paletteItems.length) {
      event.preventDefault();
      state.paletteIndex = (state.paletteIndex - 1 + state.paletteItems.length) % state.paletteItems.length;
      renderPalette($('#paletteInput').value);
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
  }
});

async function boot() {
  applyStaticIcons();
  applyTheme(state.theme);
  document.body.dataset.density = state.density;
  updateSettingsSelection();
  const updateClock = () => {
    $('#statusClock').textContent = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const popTime = $('#popTime');
    if (popTime) popTime.textContent = $('#statusClock').textContent;
    $('#camClock').textContent = new Intl.DateTimeFormat('zh-CN', {
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
