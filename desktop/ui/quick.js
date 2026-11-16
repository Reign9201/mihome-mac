(() => {
  'use strict';

  const invoke = window.__MIHOME_TAURI__?.invoke;
  const $ = (selector) => document.querySelector(selector);
  const HOME_KEY = 'mihome-home-id';
  const THEME_KEY = 'mihome-theme';
  const MAX_DEVICES = 12;
  const MAX_SCENES = 3;
  const SPEC_BATCH_SIZE = 128;
  // 搜索命中很多时只给靠前的这些设备补属性，避免一次请求上百台。
  const HYDRATE_LIMIT = 30;
  // 路由重启要连点两次确认，两次之间隔这么久没点就撤销。
  const REBOOT_ARM_MS = 3200;

  const state = {
    homeId: null,
    homeName: '',
    homes: [],
    rooms: [],
    devices: [],
    shown: [],
    scenes: [],
    // 用户在设置里挑的常用设备与场景，由后端按账号保存。
    prefs: { devices: [], scenes: [] },
    // 面板内的挑选模式：编辑时用 draft 暂存，点保存才写回后端。
    editing: false,
    draft: { devices: [], scenes: [] },
    saving: false,
    specs: new Map(),
    // 规格读完仍然缺的类型。详情靠它区分「还在读」和「确实没有」。
    specsMissing: new Set(),
    profiles: new WeakMap(),
    values: new Map(),
    loading: false,
    requestedAt: 0,
    // 面板内的搜索、房间筛选、选中行与详情视图。
    query: '',
    room: '__all__',
    selected: 0,
    view: 'list',
    detailDid: null,
    rebootArmed: null,
    rebootTimer: null,
  };

  // 主题设置由主窗口写入，可能是 light / dark，也可能没有值（跟随系统）。
  // 面板只按最终明暗渲染，三种设置在这里收敛成两种。
  function applyTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const scheme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = scheme;
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  function iconSvg(kind) {
    const icons = window.MiIcons?.icons || {};
    const body = icons[kind] || icons.generic || '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>';
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function kindOf(device) {
    return window.MiIcons?.kindFor?.(device) || 'generic';
  }

  function profileOf(device) {
    if (!device?.spec_type) return null;
    const spec = state.specs.get(device.spec_type);
    if (!spec) return null;
    let profile = state.profiles.get(spec);
    if (!profile) {
      profile = window.MiCapabilities.profileFromSpec(spec);
      state.profiles.set(spec, profile);
    }
    return profile;
  }

  // 主开关取 MIoT-Spec 里标了 primary 的 on/off 属性；不在规格里猜字段。
  function switchDef(device) {
    const profile = profileOf(device);
    if (!profile) return null;
    return profile.controls.find((item) => item.primary) || null;
  }

  // 路由器没有可开关的属性，规格里也读不到重启动作，这里按设备品类识别。
  function isRouter(device) {
    return kindOf(device) === 'router';
  }

  // 房间名以设备自带的名字为准，缺了再按 room_id 到家庭房间里查。
  function roomName(device) {
    if (device?.room_name) return device.room_name;
    const room = state.rooms.find((item) => item.id === device?.room_id);
    return room?.name || '未分配';
  }

  // 房间用 id 做筛选键：同一个家庭里可能有重名房间，名字扛不住。
  function roomKey(device) {
    return device?.room_id || '__none__';
  }

  function sensorDevice() {
    const sensors = state.devices.filter((device) => kindOf(device) === 'temp-humidity');
    return sensors.find((device) => device.online) || sensors[0] || null;
  }

  function sensorDefs(device) {
    const profile = device ? profileOf(device) : null;
    if (!profile) return [];
    const temperature = profile.metrics.find((item) => item.suffix === 'temperature');
    const humidity = profile.metrics.find((item) => item.suffix === 'relative-humidity');
    return [temperature, humidity].filter(Boolean);
  }

  const propKey = (did, siid, piid) => `${did}:${siid}:${piid}`;

  function valueOf(device, def) {
    return state.values.get(propKey(device.did, def.siid, def.piid));
  }

  function rank(device) {
    const switchable = switchDef(device) ? 2 : 0;
    const notCamera = /camera|video-doorbell|peephole/.test(kindOf(device)) ? 0 : 1;
    return (device.online ? 4 : 0) + switchable + notCamera;
  }

  // 用户在设置里挑过就照挑的顺序排，没挑过（或挑的设备都不在了）才用默认排序。
  function pickDevices() {
    const picked = new Map(state.prefs.devices.map((did, index) => [did, index]));
    const chosen = state.devices
      .filter((device) => picked.has(device.did))
      .sort((left, right) => picked.get(left.did) - picked.get(right.did))
      .slice(0, MAX_DEVICES);
    if (chosen.length) return chosen;
    return state.devices
      .map((device, index) => ({ device, index }))
      .sort((left, right) => {
        const diff = rank(right.device) - rank(left.device);
        return diff !== 0 ? diff : left.index - right.index;
      })
      .slice(0, MAX_DEVICES)
      .map((item) => item.device);
  }

  function pickScenes() {
    const picked = new Map(state.prefs.scenes.map((id, index) => [id, index]));
    const chosen = state.scenes
      .filter((scene) => picked.has(scene.id))
      .sort((left, right) => picked.get(left.id) - picked.get(right.id))
      .slice(0, MAX_SCENES);
    if (chosen.length) return chosen;
    return state.scenes.slice(0, MAX_SCENES);
  }

  // ---------- 搜索与房间筛选 ----------
  // 平时面板只显示挑出来的常用设备；一旦输入了搜索词或选了房间，就改在
  // 整个家庭的设备里找，否则 12 台上限会把想找的设备挡在外面。

  function searchableText(device) {
    const parts = [device.name, roomName(device), device.model];
    return window.MiPinyin?.searchable(parts) ?? parts.filter(Boolean).join(' ').toLowerCase();
  }

  function filtersActive() {
    return Boolean(state.query.trim()) || state.room !== '__all__';
  }

  function filteredDevices() {
    const query = state.query.trim().toLowerCase();
    return state.devices.filter((device) => {
      if (state.room !== '__all__' && roomKey(device) !== state.room) return false;
      if (!query) return true;
      return searchableText(device).includes(query);
    });
  }

  function visibleDevices() {
    if (state.editing) return state.devices;
    return filtersActive() ? filteredDevices() : state.shown;
  }

  // 按家庭里的房间顺序列筛选项，只列真的有设备的房间；没分房间的设备归到末位。
  function roomOptions() {
    const counts = new Map();
    for (const device of state.devices) {
      const key = roomKey(device);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const options = [];
    const known = new Set();
    for (const room of state.rooms) {
      if (!counts.has(room.id)) continue;
      known.add(room.id);
      options.push({ id: room.id, name: room.name, count: counts.get(room.id) });
    }
    for (const [key, count] of counts) {
      if (known.has(key)) continue;
      const device = state.devices.find((item) => roomKey(item) === key);
      options.push({ id: key, name: roomName(device), count });
    }
    return options;
  }

  function setStatus(text, kind = 'ok') {
    const line = $('#statusLine');
    if (!line) return;
    line.hidden = !text;
    line.textContent = text || '';
    line.className = `status-line ${kind}`;
  }

  function flash(text, kind = 'ok') {
    setStatus(text, kind);
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      const line = $('#statusLine');
      if (line && line.classList.contains(kind)) line.hidden = true;
    }, 1500);
  }

  function errorText(error) {
    return String(error?.message || error || '未知错误');
  }

  function updateClock() {
    const clock = $('#clock');
    if (!clock) return;
    clock.textContent = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  }

  function formatValue(value, def) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'boolean') return value ? '开' : '关';
    if (typeof value === 'object') return '—';
    if (def.options) {
      const option = def.options.find(([key]) => String(key) === String(value));
      if (option) {
        const label = String(option[1] ?? '').trim();
        return /^-?\d+(?:\.\d+)?$/.test(label) ? '—' : label;
      }
    }
    const numeric = typeof value === 'number'
      || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(String(value).trim()));
    if (!numeric) return String(value);
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return `${number.toFixed(def.digits ?? 0)}${def.unit || ''}`;
  }

  function renderEnvironment() {
    const sensor = sensorDevice();
    const defs = sensorDefs(sensor);
    const temperature = defs.find((def) => def.suffix === 'temperature');
    const humidity = defs.find((def) => def.suffix === 'relative-humidity');
    const tempValue = sensor && temperature ? Number(valueOf(sensor, temperature)) : NaN;
    const humidValue = sensor && humidity ? Number(valueOf(sensor, humidity)) : NaN;
    const online = state.devices.filter((device) => device.online).length;

    $('#envTemp').textContent = Number.isFinite(tempValue) ? tempValue.toFixed(1) : '--';
    $('#envUnit').textContent = Number.isFinite(tempValue) ? '°' : '';
    $('#envHome').textContent = state.homeName || '当前家庭';
    $('#envOnline').textContent = state.devices.length
      ? `在线 ${online}/${state.devices.length}${Number.isFinite(humidValue) ? ` · 湿度 ${humidValue.toFixed(0)}%` : ''}`
      : '正在读取设备';
    $('#envDot').className = `env-dot${online ? '' : ' off'}`;
  }

  // ---------- 属性读写 ----------
  // 先改本地值再发请求，界面立刻响应；请求失败时回滚并报出原因。

  async function applyProperty(device, def, value) {
    const result = await invoke('set_property', {
      did: device.did,
      siid: def.siid,
      piid: def.piid,
      value,
    });
    const item = Array.isArray(result) ? result[0] : result;
    if (item?.code && item.code !== 0) throw new Error(`设备返回 code ${item.code}`);
    state.values.set(propKey(device.did, def.siid, def.piid), value);
  }

  async function toggleValue(device, def) {
    if (!device.online) return;
    const key = propKey(device.did, def.siid, def.piid);
    const previous = Boolean(state.values.get(key));
    const next = !previous;
    state.values.set(key, next);
    render();
    try {
      await applyProperty(device, def, next);
      flash(`${device.name}已${next ? '开启' : '关闭'}`);
    } catch (error) {
      state.values.set(key, previous);
      setStatus(`设置「${device.name}」失败：${errorText(error)}`, 'error');
    } finally {
      render();
    }
  }

  async function setControlValue(device, def, value, done) {
    if (!device.online) return;
    const key = propKey(device.did, def.siid, def.piid);
    const previous = state.values.get(key);
    state.values.set(key, value);
    try {
      await applyProperty(device, def, value);
      done?.();
      flash(`${def.label}已更新`);
    } catch (error) {
      state.values.set(key, previous);
      setStatus(`设置「${def.label}」失败：${errorText(error)}`, 'error');
    } finally {
      render();
    }
  }

  // 只给当前能看到的设备补属性：搜索命中多时按 HYDRATE_LIMIT 截断。
  function deviceRequests(devices) {
    const requests = [];
    const seen = new Set();
    for (const device of devices.slice(0, HYDRATE_LIMIT)) {
      const profile = profileOf(device);
      if (!profile) continue;
      for (const def of [...profile.controls, ...profile.metrics]) {
        const key = propKey(device.did, def.siid, def.piid);
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({ did: device.did, siid: def.siid, piid: def.piid });
      }
    }
    return requests;
  }

  async function hydrate(devices) {
    // 环境读数来自传感器，被搜索或房间筛选挡住时也要照常读它。放在最前，
    // 免得设备多时被 deviceRequests 的上限截掉。
    const sensor = sensorDevice();
    const targets = sensor && !devices.includes(sensor) ? [sensor, ...devices] : devices;
    const requests = deviceRequests(targets);
    if (!requests.length || !invoke) return;
    const homeId = state.homeId;
    try {
      const result = await invoke('get_properties', { requests });
      if (state.homeId !== homeId) return;
      for (const item of Array.isArray(result) ? result : []) {
        if (!item || !item.did || (item.code && item.code !== 0)) continue;
        state.values.set(propKey(item.did, item.siid, item.piid), item.value);
      }
      // 环境读数取自传感器，补完属性要跟着重画一次。
      renderEnvironment();
      render();
    } catch (_) {
      // 读不到属性时设备行照样能点开，详情里的控制会给出失败原因。
    }
  }

  // ---------- 面板内挑选常用设备与场景 ----------
  // 点右上角按钮进入挑选模式：设备区列出当前家庭的全部设备、场景区列出全部场景，
  // 点一下加进或移出，顺序就是点击顺序，点保存才写回后端。

  function togglePick(kind, id, limit) {
    const list = state.draft[kind];
    const at = list.indexOf(id);
    if (at >= 0) {
      list.splice(at, 1);
    } else if (list.length >= limit) {
      flash(kind === 'devices' ? `最多选 ${limit} 台设备` : `最多选 ${limit} 个场景`, 'hint');
      return;
    } else {
      list.push(id);
    }
    setStatus('');
    renderDevices();
    renderScenes();
  }

  function pickBadge(index) {
    const badge = document.createElement('span');
    badge.className = 'pick-badge' + (index >= 0 ? ' on' : '');
    badge.textContent = index >= 0 ? String(index + 1) : '';
    return badge;
  }

  function enterEdit() {
    if (state.editing) return;
    // 配置里可能有已经不在当前家庭的设备或场景，挑选时它们点不到、也移不掉，
    // 所以只在对应列表读到了数据时才把这类条目丢掉。
    const known = (ids, items, key) => (items.length
      ? ids.filter((id) => items.some((item) => item[key] === id))
      : ids);
    state.editing = true;
    state.view = 'list';
    state.detailDid = null;
    state.draft = {
      devices: known(state.prefs.devices, state.devices, 'did').slice(0, MAX_DEVICES),
      scenes: known(state.prefs.scenes, state.scenes, 'id').slice(0, MAX_SCENES),
    };
    setStatus('');
    syncEditChrome();
    render();
  }

  function exitEdit() {
    if (!state.editing) return;
    state.editing = false;
    state.saving = false;
    state.draft = { devices: [], scenes: [] };
    setStatus('');
    syncEditChrome();
    render();
  }

  function syncEditChrome() {
    const editing = state.editing;
    $('#editPrefs').setAttribute('aria-pressed', String(editing));
    $('#editPrefs').classList.toggle('on', editing);
    $('#footMain').hidden = editing;
    $('#footEdit').hidden = !editing;
    const save = $('#editSave');
    save.disabled = state.saving;
    save.textContent = state.saving ? '保存中…' : '保存';
  }

  function saveEdit() {
    if (state.saving) return;
    state.saving = true;
    syncEditChrome();
    invoke('save_quick_prefs', {
      devices: state.draft.devices,
      scenes: state.draft.scenes,
    }).then((saved) => {
      state.prefs = {
        devices: Array.isArray(saved?.devices) ? saved.devices : state.draft.devices.slice(),
        scenes: Array.isArray(saved?.scenes) ? saved.scenes : state.draft.scenes.slice(),
      };
      state.editing = false;
      state.saving = false;
      state.shown = pickDevices();
      syncEditChrome();
      render();
      flash('面板已更新');
    }).catch((error) => {
      state.saving = false;
      syncEditChrome();
      setStatus(`保存失败：${errorText(error)}`, 'error');
    });
  }

  // ---------- 渲染 ----------

  function renderRoomBar() {
    const bar = $('#roomBar');
    const options = roomOptions();
    bar.hidden = state.editing || options.length <= 1;
    bar.replaceChildren();
    if (bar.hidden) return;
    const chips = [{ id: '__all__', label: '全部', count: state.devices.length }]
      .concat(options.map((option) => ({ id: option.id, label: option.name, count: option.count })));
    for (const chip of chips) {
      const active = state.room === chip.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `room-chip${active ? ' active' : ''}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(active));
      button.textContent = chip.label;
      const count = document.createElement('small');
      count.textContent = String(chip.count);
      button.append(count);
      button.onclick = () => {
        state.room = chip.id;
        state.selected = 0;
        render();
        hydrate(visibleDevices());
      };
      bar.append(button);
    }
  }

  function renderDevices() {
    const grid = $('#deviceGrid');
    grid.replaceChildren();
    const editing = state.editing;
    const devices = visibleDevices();
    $('#deviceCount').textContent = editing
      ? `${state.draft.devices.length}/${MAX_DEVICES}`
      : state.devices.length
        ? `${devices.length}/${state.devices.length}`
        : '';
    $('#deviceHeadLabel').textContent = editing
      ? '挑选常用设备'
      : filtersActive() ? '搜索结果' : '常用设备';

    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      if (state.devices.length) {
        empty.textContent = filtersActive() ? '没有匹配的设备' : '暂无可用设备';
      } else {
        empty.textContent = state.loading ? '正在读取设备…' : '没有读取到设备';
      }
      grid.append(empty);
      return;
    }

    if (editing) {
      for (const device of devices) {
        const index = state.draft.devices.indexOf(device.did);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `device pickable${index >= 0 ? ' picked' : ''}${device.online ? '' : ' offline'}`;
        row.setAttribute('aria-pressed', String(index >= 0));
        row.setAttribute('aria-label', `${device.name}${index >= 0 ? '，已选' : '，未选'}`);
        const icon = document.createElement('span');
        icon.className = 'ic';
        icon.innerHTML = iconSvg(kindOf(device));
        const name = document.createElement('span');
        name.className = 'device-name';
        name.textContent = device.name;
        name.title = device.name;
        row.append(icon, name, pickBadge(index));
        row.onclick = () => togglePick('devices', device.did, MAX_DEVICES);
        grid.append(row);
      }
      return;
    }

    if (state.selected >= devices.length) state.selected = devices.length - 1;
    if (state.selected < 0) state.selected = 0;

    devices.forEach((device, index) => {
      const row = document.createElement('div');
      row.className = `device${device.online ? '' : ' offline'}${index === state.selected ? ' selected' : ''}`;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `${device.name}，${roomName(device)}`);

      const iconButton = document.createElement('button');
      iconButton.type = 'button';
      iconButton.className = 'device-icon-btn';
      iconButton.setAttribute('aria-label', `打开 ${device.name}`);
      iconButton.innerHTML = iconSvg(kindOf(device));
      iconButton.onclick = (event) => {
        event.stopPropagation();
        invoke('quick_open_main');
      };

      const name = document.createElement('span');
      name.className = 'device-name';
      name.textContent = device.name;
      name.title = `${device.name} · ${roomName(device)}`;
      name.onclick = () => openDetail(device);

      row.append(iconButton, name);

      const def = switchDef(device);
      if (def) {
        const switchButton = document.createElement('button');
        switchButton.type = 'button';
        const on = Boolean(valueOf(device, def));
        switchButton.className = `switch${on ? ' on' : ''}`;
        switchButton.setAttribute('role', 'switch');
        switchButton.setAttribute('aria-checked', String(on));
        switchButton.setAttribute('aria-label', `${device.name}${def.label}`);
        switchButton.disabled = !device.online;
        switchButton.onclick = (event) => {
          event.stopPropagation();
          toggleValue(device, def);
        };
        row.append(switchButton);
      } else if (isRouter(device)) {
        row.append(rebootButton(device, 'mini-action'));
      } else {
        row.append(chevron());
      }
      grid.append(row);
    });
  }

  function chevron() {
    const span = document.createElement('span');
    span.className = 'chevron';
    span.textContent = '›';
    return span;
  }

  function rebootButton(device, className) {
    const armed = state.rebootArmed === device.did;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${className}${armed ? ' armed' : ''}`;
    button.title = armed ? '再次点击确认重启' : '重启路由器';
    button.setAttribute('aria-label', button.title);
    button.textContent = armed ? '确认' : '重启';
    button.disabled = !device.online;
    button.onclick = (event) => {
      event.stopPropagation();
      armReboot(device);
    };
    return button;
  }

  function armReboot(device) {
    if (!device.online) return;
    if (state.rebootArmed !== device.did) {
      state.rebootArmed = device.did;
      clearTimeout(state.rebootTimer);
      state.rebootTimer = setTimeout(() => {
        state.rebootArmed = null;
        render();
      }, REBOOT_ARM_MS);
      flash('再次点击确认重启路由器', 'hint');
      render();
      return;
    }
    clearTimeout(state.rebootTimer);
    state.rebootTimer = null;
    state.rebootArmed = null;
    invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] })
      .then(() => {
        flash('重启指令已发送');
      })
      .catch((error) => {
        setStatus(`重启失败：${errorText(error)}`, 'error');
      })
      .finally(() => render());
  }

  function runScene(scene, button) {
    button.disabled = true;
    invoke('run_scene', { sceneId: scene.id, homeId: state.homeId })
      .then(() => flash(`「${scene.name}」已执行`))
      .catch((error) => setStatus(`执行场景「${scene.name}」失败：${errorText(error)}`, 'error'))
      .finally(() => { button.disabled = false; });
  }

  function renderScenes() {
    const box = $('#scenes');
    box.replaceChildren();
    const editing = state.editing;
    const scenes = editing ? state.scenes : pickScenes();
    box.classList.toggle('pick-mode', editing);
    $('#sceneCount').textContent = editing
      ? `${state.draft.scenes.length}/${MAX_SCENES}`
      : scenes.length ? String(scenes.length) : '';
    if (!scenes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty scenes-empty';
      empty.textContent = state.loading ? '正在读取场景…' : '暂无场景';
      box.append(empty);
      return;
    }
    if (editing) {
      box.classList.add('pick-mode');
      for (const scene of scenes) {
        const index = state.draft.scenes.indexOf(scene.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `scene pickable${index >= 0 ? ' picked' : ''}`;
        button.setAttribute('aria-pressed', String(index >= 0));
        button.textContent = scene.name;
        button.title = scene.name;
        button.append(pickBadge(index));
        button.onclick = () => togglePick('scenes', scene.id, MAX_SCENES);
        box.append(button);
      }
      return;
    }
    box.classList.remove('pick-mode');
    for (const scene of scenes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene';
      button.textContent = scene.name;
      button.title = scene.name;
      button.onclick = () => runScene(scene, button);
      box.append(button);
    }
  }

  // ---------- 详情视图 ----------

  function openDetail(device) {
    if (state.editing) return;
    state.view = 'detail';
    state.detailDid = device.did;
    state.rebootArmed = null;
    clearTimeout(state.rebootTimer);
    setStatus('');
    render();
    hydrate([device]);
  }

  function closeDetail() {
    const did = state.detailDid;
    state.view = 'list';
    state.detailDid = null;
    state.rebootArmed = null;
    clearTimeout(state.rebootTimer);
    const list = visibleDevices();
    const index = list.findIndex((device) => device.did === did);
    if (index >= 0) state.selected = index;
    render();
  }

  function detailHeader(device) {
    const head = document.createElement('div');
    head.className = 'detail-head';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.textContent = '‹';
    back.setAttribute('aria-label', '返回设备列表');
    back.onclick = () => closeDetail();
    head.append(back);

    const title = document.createElement('div');
    title.className = 'detail-title-box';
    const name = document.createElement('strong');
    name.className = 'detail-title';
    name.textContent = device.name || '未命名设备';
    const sub = document.createElement('span');
    sub.className = 'detail-sub';
    sub.textContent = [roomName(device), device.model].filter(Boolean).join(' · ');
    title.append(name, sub);
    head.append(title);

    const pill = document.createElement('span');
    pill.className = `online-pill${device.online ? '' : ' off'}`;
    pill.textContent = device.online ? '在线' : '离线';
    head.append(pill);
    return head;
  }

  function detailMetric(device, def) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    const label = document.createElement('span');
    label.textContent = def.label;
    const value = document.createElement('strong');
    value.textContent = formatValue(valueOf(device, def), def);
    card.append(label, value);
    return card;
  }

  function controlSwitch(device, def) {
    const button = document.createElement('button');
    button.type = 'button';
    const on = Boolean(valueOf(device, def));
    button.className = `switch${on ? ' on' : ''}`;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(on));
    button.setAttribute('aria-label', `${device.name}${def.label}`);
    button.disabled = !device.online;
    button.onclick = () => toggleValue(device, def);
    return button;
  }

  function controlRange(device, def) {
    const row = document.createElement('div');
    row.className = 'range-row';
    const head = document.createElement('div');
    head.className = 'range-head';
    const label = document.createElement('span');
    label.textContent = def.label;
    const output = document.createElement('output');
    const current = valueOf(device, def);
    const text = (value) => `${Number(value).toFixed(0)}${def.suffix || ''}`;
    output.textContent = current === undefined ? '—' : text(current);
    head.append(label, output);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step || 1);
    input.value = String(current ?? def.min);
    input.disabled = !device.online;
    input.oninput = () => {
      output.textContent = text(input.value);
    };
    input.onchange = () => {
      setControlValue(device, def, Number(input.value), () => {
        output.textContent = text(input.value);
      });
    };
    row.append(head, input);
    return row;
  }

  function controlSegments(device, def) {
    const row = document.createElement('div');
    row.className = 'range-row';
    const head = document.createElement('div');
    head.className = 'range-head';
    const label = document.createElement('span');
    label.textContent = def.label;
    head.append(label);
    row.append(head);

    const group = document.createElement('div');
    group.className = 'segment-group';
    const current = valueOf(device, def);
    for (const [value, optionLabel] of def.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `segment-btn${String(current) === String(value) ? ' active' : ''}`;
      button.textContent = optionLabel;
      button.disabled = !device.online;
      button.onclick = () => setControlValue(device, def, value);
      group.append(button);
    }
    row.append(group);
    return row;
  }

  function renderDetail() {
    const box = $('#detailView');
    const device = state.devices.find((item) => item.did === state.detailDid);
    box.replaceChildren();
    if (!device) {
      box.hidden = true;
      return;
    }
    box.append(detailHeader(device));

    const profile = profileOf(device);
    if (!profile) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      const unreadable = !device.spec_type || state.specsMissing.has(device.spec_type);
      note.textContent = unreadable
        ? '这台设备没有可读的规格，无法在面板内控制。'
        : '正在读取设备规格…';
      box.append(note);
      return;
    }

    if (profile.metrics.length) {
      const grid = document.createElement('div');
      grid.className = 'metric-grid';
      for (const def of profile.metrics.slice(0, 6)) grid.append(detailMetric(device, def));
      box.append(grid);
    }

    const primary = profile.controls.find((item) => item.primary);
    if (primary) {
      const card = document.createElement('div');
      card.className = 'detail-card';
      const row = document.createElement('div');
      row.className = 'detail-card-head';
      const label = document.createElement('strong');
      label.textContent = primary.label;
      row.append(label, controlSwitch(device, primary));
      card.append(row);
      box.append(card);
    } else if (isRouter(device)) {
      const card = document.createElement('div');
      card.className = 'detail-card';
      const row = document.createElement('div');
      row.className = 'detail-card-head';
      const copy = document.createElement('div');
      copy.className = 'detail-copy';
      const label = document.createElement('strong');
      label.textContent = '路由器';
      const hint = document.createElement('small');
      hint.textContent = '重启会断网约 1 分钟';
      copy.append(label, hint);
      row.append(copy, rebootButton(device, 'restart-btn'));
      card.append(row);
      box.append(card);
    }

    const others = profile.controls.filter((item) => !item.primary);
    if (others.length) {
      const card = document.createElement('div');
      card.className = 'detail-card';
      const head = document.createElement('div');
      head.className = 'detail-card-head';
      head.textContent = '更多控制';
      card.append(head);
      for (const def of others) {
        if (def.type === 'toggle') {
          const row = document.createElement('div');
          row.className = 'control-row';
          const label = document.createElement('span');
          label.className = 'control-label';
          label.textContent = def.label;
          row.append(label, controlSwitch(device, def));
          card.append(row);
        } else if (def.type === 'range') {
          card.append(controlRange(device, def));
        } else if (def.type === 'segments') {
          card.append(controlSegments(device, def));
        }
      }
      box.append(card);
    }

    const footer = document.createElement('button');
    footer.type = 'button';
    footer.className = 'detail-open-main';
    footer.textContent = '在主窗口中打开';
    footer.onclick = () => invoke('quick_open_main');
    box.append(footer);
  }

  function render() {
    const detail = state.view === 'detail' && !state.editing && Boolean(state.detailDid);
    const hasDevices = Boolean(state.devices.length);
    $('#deviceTools').hidden = detail || state.editing || !hasDevices;
    $('#envCard').hidden = detail;
    $('#deviceHead').hidden = detail;
    $('#deviceGrid').hidden = detail;
    $('#sceneHead').hidden = detail;
    $('#scenes').hidden = detail;
    $('#detailView').hidden = !detail;
    renderRoomBar();
    renderDevices();
    renderScenes();
    if (detail) renderDetail();
    else $('#detailView').replaceChildren();
  }

  function renderSelection() {
    const rows = [...document.querySelectorAll('#deviceGrid .device')];
    rows.forEach((row, index) => row.classList.toggle('selected', index === state.selected));
    rows[state.selected]?.scrollIntoView({ block: 'nearest' });
  }

  function renderLoggedOut() {
    state.devices = [];
    state.shown = [];
    state.scenes = [];
    state.rooms = [];
    state.homeName = '';
    state.profiles = new WeakMap();
    state.values = new Map();
    state.query = '';
    state.room = '__all__';
    state.selected = 0;
    state.view = 'list';
    state.detailDid = null;
    const search = $('#searchInput');
    if (search) search.value = '';
    $('#envTemp').textContent = '--';
    $('#envUnit').textContent = '';
    $('#envHome').textContent = '未登录';
    $('#envOnline').textContent = '打开主窗口完成登录';
    $('#envDot').className = 'env-dot off';
    $('#deviceTools').hidden = true;
    $('#deviceHead').hidden = false;
    $('#deviceGrid').hidden = false;
    $('#sceneHead').hidden = false;
    $('#scenes').hidden = false;
    $('#detailView').hidden = true;
    $('#deviceGrid').innerHTML = '<div class="empty">未登录，打开主窗口登录后可用</div>';
    $('#scenes').replaceChildren();
    $('#deviceCount').textContent = '';
    $('#sceneCount').textContent = '';
    $('#deviceHeadLabel').textContent = '常用设备';
  }

  async function refresh() {
    if (!invoke || state.loading) return;
    state.loading = true;
    renderScenes();
    try {
      const userId = await invoke('auth_resume');
      if (!userId) {
        renderLoggedOut();
        return;
      }
      const homes = await invoke('list_homes');
      state.homes = Array.isArray(homes) ? homes : [];
      if (!state.homes.length) {
        renderLoggedOut();
        $('#envHome').textContent = '账号下没有家庭';
        $('#deviceGrid').innerHTML = '<div class="empty">请先在米家 App 中创建家庭并添加设备</div>';
        return;
      }
      const saved = localStorage.getItem(HOME_KEY);
      const home = state.homes.find((item) => item.id === saved) || state.homes[0];
      state.homeId = home.id;
      state.homeName = home.name || '';
      state.rooms = Array.isArray(home.rooms) ? home.rooms : [];
      localStorage.setItem(HOME_KEY, state.homeId);

      try {
        const prefs = await invoke('quick_prefs');
        state.prefs = {
          devices: Array.isArray(prefs?.devices) ? prefs.devices : [],
          scenes: Array.isArray(prefs?.scenes) ? prefs.scenes : [],
        };
      } catch (_) {
        // 没读到配置就按默认规则挑，面板照常可用。
        state.prefs = { devices: [], scenes: [] };
      }

      const devices = await invoke('list_devices', { homeId: state.homeId });
      state.devices = Array.isArray(devices) ? devices : [];
      state.shown = pickDevices();
      // 换家庭或设备列表变了，之前选中的行和打开的设备都可能不在了。
      if (!state.devices.some((device) => device.did === state.detailDid)) {
        state.view = 'list';
        state.detailDid = null;
      }

      const types = [...new Set(state.devices.map((device) => device.spec_type).filter(Boolean))];
      state.specsMissing = new Set();
      for (let offset = 0; offset < types.length; offset += SPEC_BATCH_SIZE) {
        const chunk = types.slice(offset, offset + SPEC_BATCH_SIZE);
        try {
          const batch = await invoke('get_device_specs', { specTypes: chunk });
          for (const [type, spec] of Object.entries(batch?.specs || {})) {
            state.specs.set(type, spec);
          }
        } catch (_) {
          // 规格读取失败时设备仍可用于打开主窗口，面板不整块报错。
        }
        // 这一批里没拿回来的类型记下来，详情页才不会一直停在「正在读取」。
        for (const type of chunk) {
          if (!state.specs.has(type)) state.specsMissing.add(type);
        }
      }

      try {
        const scenes = await invoke('list_scenes', { homeId: state.homeId });
        state.scenes = Array.isArray(scenes) ? scenes : [];
      } catch (_) {
        state.scenes = [];
      }

      renderEnvironment();
      render();
      state.requestedAt = Date.now();
      await hydrate(visibleDevices());
    } catch (error) {
      setStatus(`读取失败：${errorText(error)}`, 'error');
      renderEnvironment();
      render();
    } finally {
      state.loading = false;
    }
  }

  // ---------- 键盘导航 ----------
  // ↑↓ 按网格列数跳行，←→ 走一格。回车切换主开关，没有主开关的设备打开详情。

  function gridColumns() {
    const grid = $('#deviceGrid');
    const columns = getComputedStyle(grid).gridTemplateColumns;
    const count = String(columns).split(' ').filter((part) => part && part !== 'none').length;
    return Math.max(1, count);
  }

  function onKeyDown(event) {
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (event.key === 'Escape') {
      event.preventDefault();
      // Esc 逐层往里退：先清搜索词，再关详情，再退挑选模式，最后才收起面板。
      if (state.query) {
        state.query = '';
        $('#searchInput').value = '';
        $('#searchInput').blur();
        state.selected = 0;
        render();
        hydrate(visibleDevices());
        return;
      }
      if (state.view === 'detail') {
        closeDetail();
        return;
      }
      if (state.editing) {
        exitEdit();
        return;
      }
      invoke?.('quick_hide');
      return;
    }

    if (state.view !== 'list' || state.editing) return;
    const list = visibleDevices();
    if (!list.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = gridColumns();
      const delta = event.key === 'ArrowDown' ? step : -step;
      state.selected = Math.min(list.length - 1, Math.max(0, state.selected + delta));
      renderSelection();
      return;
    }
    if (typing) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      state.selected = Math.min(list.length - 1, Math.max(0, state.selected + delta));
      renderSelection();
      return;
    }
    if (event.key === 'Enter') {
      const device = list[state.selected];
      if (!device) return;
      event.preventDefault();
      const def = switchDef(device);
      if (def && device.online) toggleValue(device, def);
      else openDetail(device);
    }
  }

  function bind() {
    $('#openMain').onclick = () => invoke?.('quick_open_main');
    $('#editPrefs').onclick = () => (state.editing ? exitEdit() : enterEdit());
    $('#editCancel').onclick = () => exitEdit();
    $('#editSave').onclick = () => saveEdit();

    let searchTimer = null;
    $('#searchInput').addEventListener('input', (event) => {
      state.query = event.target.value;
      state.selected = 0;
      render();
      clearTimeout(searchTimer);
      // 等输入停下来再补属性，避免每敲一个字都发一轮请求。
      searchTimer = setTimeout(() => hydrate(visibleDevices()), 150);
    });

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('focus', () => {
      // 面板从隐藏变为可见时刷新一次；隐藏期间设备状态可能已经变化。
      if (Date.now() - state.requestedAt > 1000) refresh();
    });
    document.addEventListener('visibilitychange', () => {
      // 面板收起时结束挑选，下次打开回到正常状态，未保存的改动不留下来。
      if (document.hidden) {
        exitEdit();
        return;
      }
      state.view = 'list';
      state.detailDid = null;
      if (Date.now() - state.requestedAt > 1000) refresh();
      else render();
    });
    updateClock();
    setInterval(updateClock, 1000);
  }

  applyTheme();
  bind();
  // 面板启动时是隐藏的，不预取数据；第一次显示由 focus 和 visibilitychange 触发刷新。
  if (!document.hidden) refresh();
})();
