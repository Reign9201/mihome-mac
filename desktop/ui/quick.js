(() => {
  'use strict';

  const invoke = window.__MIHOME_TAURI__?.invoke;
  const $ = (selector) => document.querySelector(selector);
  const HOME_KEY = 'mihome-home-id';
  const THEME_KEY = 'mihome-theme';
  const MAX_DEVICES = 12;
  const MAX_SCENES = 3;
  const SPEC_BATCH_SIZE = 128;

  const state = {
    homeId: null,
    homeName: '',
    homes: [],
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
    profiles: new WeakMap(),
    values: new Map(),
    loading: false,
    requestedAt: 0,
  };

  function applyTheme() {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

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

  function toggleDevice(device, def, button) {
    const on = Boolean(valueOf(device, def));
    button.disabled = true;
    button.classList.toggle('on', !on);
    button.setAttribute('aria-checked', String(!on));
    invoke('set_property', {
      did: device.did,
      siid: def.siid,
      piid: def.piid,
      value: !on,
    }).then((result) => {
      const item = Array.isArray(result) ? result[0] : result;
      if (item?.code && item.code !== 0) throw new Error(`设置返回 code ${item.code}`);
      state.values.set(propKey(device.did, def.siid, def.piid), !on);
      button.classList.toggle('on', !on);
      button.setAttribute('aria-checked', String(!on));
      flash(`${device.name}已${!on ? '开启' : '关闭'}`);
    }).catch((error) => {
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
      setStatus(`设置「${device.name}」失败：${errorText(error)}`, 'error');
    }).finally(() => {
      button.disabled = !device.online;
    });
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
    state.draft = {
      devices: known(state.prefs.devices, state.devices, 'did').slice(0, MAX_DEVICES),
      scenes: known(state.prefs.scenes, state.scenes, 'id').slice(0, MAX_SCENES),
    };
    setStatus('');
    syncEditChrome();
    renderDevices();
    renderScenes();
  }

  function exitEdit() {
    if (!state.editing) return;
    state.editing = false;
    state.saving = false;
    state.draft = { devices: [], scenes: [] };
    setStatus('');
    syncEditChrome();
    renderDevices();
    renderScenes();
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
      renderDevices();
      renderScenes();
      flash('面板已更新');
    }).catch((error) => {
      state.saving = false;
      syncEditChrome();
      setStatus(`保存失败：${errorText(error)}`, 'error');
    });
  }

  function renderDevices() {
    const grid = $('#deviceGrid');
    grid.replaceChildren();
    const editing = state.editing;
    const devices = editing ? state.devices : state.shown;
    $('#deviceCount').textContent = editing
      ? `${state.draft.devices.length}/${MAX_DEVICES}`
      : state.devices.length
        ? `${Math.min(devices.length, state.devices.length)}/${state.devices.length}`
        : '';

    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.devices.length ? '暂无可用设备' : '没有读取到设备';
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

    for (const device of devices) {
      const row = document.createElement('div');
      row.className = `device${device.online ? '' : ' offline'}`;

      const iconButton = document.createElement('button');
      iconButton.type = 'button';
      iconButton.className = 'device-icon-btn';
      iconButton.setAttribute('aria-label', `打开 ${device.name}`);
      iconButton.innerHTML = iconSvg(kindOf(device));
      iconButton.onclick = () => invoke('quick_open_main');

      const name = document.createElement('span');
      name.className = 'device-name';
      name.textContent = device.name;
      name.title = device.name;
      name.onclick = () => invoke('quick_open_main');

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
        switchButton.onclick = () => toggleDevice(device, def, switchButton);
        row.append(switchButton);
      }
      grid.append(row);
    }
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

  function renderLoggedOut() {
    state.devices = [];
    state.shown = [];
    state.scenes = [];
    state.homeName = '';
    $('#envTemp').textContent = '--';
    $('#envUnit').textContent = '';
    $('#envHome').textContent = '未登录';
    $('#envOnline').textContent = '打开主窗口完成登录';
    $('#envDot').className = 'env-dot off';
    $('#deviceGrid').innerHTML = '<div class="empty">未登录，打开主窗口登录后可用</div>';
    $('#scenes').replaceChildren();
    $('#deviceCount').textContent = '';
    $('#sceneCount').textContent = '';
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

      const types = [...new Set(state.devices.map((device) => device.spec_type).filter(Boolean))];
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
      }

      const requests = [];
      for (const device of state.shown) {
        const def = switchDef(device);
        if (def && device.online) {
          requests.push({ did: device.did, siid: def.siid, piid: def.piid });
        }
      }
      const sensor = sensorDevice();
      if (sensor) {
        for (const def of sensorDefs(sensor)) {
          requests.push({ did: sensor.did, siid: def.siid, piid: def.piid });
        }
      }
      state.values = new Map();
      if (requests.length) {
        try {
          const result = await invoke('get_properties', { requests });
          for (const item of Array.isArray(result) ? result : []) {
            if (!item || !item.did || (item.code && item.code !== 0)) continue;
            state.values.set(propKey(item.did, item.siid, item.piid), item.value);
          }
        } catch (error) {
          setStatus(`读取设备状态失败：${errorText(error)}`, 'error');
        }
      }

      try {
        const scenes = await invoke('list_scenes', { homeId: state.homeId });
        state.scenes = Array.isArray(scenes) ? scenes : [];
      } catch (_) {
        state.scenes = [];
      }

      renderEnvironment();
      renderDevices();
      renderScenes();
      state.requestedAt = Date.now();
    } catch (error) {
      setStatus(`读取失败：${errorText(error)}`, 'error');
      renderEnvironment();
      renderDevices();
    } finally {
      state.loading = false;
    }
  }

  function bind() {
    $('#openMain').onclick = () => invoke?.('quick_open_main');
    $('#editPrefs').onclick = () => (state.editing ? exitEdit() : enterEdit());
    $('#editCancel').onclick = () => exitEdit();
    $('#editSave').onclick = () => saveEdit();
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
      if (Date.now() - state.requestedAt > 1000) refresh();
    });
    updateClock();
    setInterval(updateClock, 1000);
  }

  applyTheme();
  bind();
  // 面板启动时是隐藏的，不预取数据；第一次显示由 focus 和 visibilitychange 触发刷新。
  if (!document.hidden) refresh();
})();
