#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp, waitFor } from './ui-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const chromeBin = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const quickUrl = pathToFileURL(path.join(repo, 'desktop/ui/quick.html')).href;

// 离线 mock：设备、规格、属性都固定，测试只验证面板的数据接线和交互。
const mockSource = String.raw`
(() => {
  const loggedOut = location.hash.includes('logged-out');
  const devices = [
    { did: 'light-1', name: '客厅吸顶灯', model: 'yeelink.light.ceiling', home_id: 'home-1', room_id: 'room-1', room_name: '客厅', online: true, spec_type: 'spec-light', parent_id: null },
    { did: 'plug-1', name: '书桌插座', model: 'chuangmi.plug.212a01', home_id: 'home-1', room_id: 'room-1', room_name: '书房', online: true, spec_type: 'spec-plug', parent_id: null },
    { did: 'switch-1', name: '走廊开关', model: 'lumi.switch.b1nacn02', home_id: 'home-1', room_id: 'room-1', room_name: '走廊', online: true, spec_type: 'spec-switch', parent_id: null },
    { did: 'sensor-1', name: '温湿度计', model: 'miaomiaoce.sensor_ht.t2', home_id: 'home-1', room_id: 'room-1', room_name: '客厅', online: true, spec_type: 'spec-sensor', parent_id: null },
    { did: 'camera-1', name: '客厅摄像头', model: 'chuangmi.camera.069a01', home_id: 'home-1', room_id: 'room-1', room_name: '客厅', online: false, spec_type: 'spec-camera', parent_id: null },
    { did: 'unknown-1', name: '旧款空调', model: 'unknown.model', home_id: 'home-1', room_id: null, room_name: null, online: true, spec_type: null, parent_id: null },
  ];
  // 测设备上限时用，默认不加载，免得动到其它断言里的设备数。
  if (location.hash.includes('many-devices')) {
    for (let i = 1; i <= 8; i += 1) {
      devices.push({ did: 'extra-' + i, name: '备用插座 ' + i, model: 'chuangmi.plug.212a01',
        home_id: 'home-1', room_id: 'room-2', room_name: '次卧', online: true, spec_type: 'spec-plug', parent_id: null });
    }
  }
  const specs = {
    'spec-light': { services: [{ iid: 2, type: 'urn:miot-spec-v2:service:light:00007802:mock:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:on:00007001:mock:1', format: 'bool', access: ['read', 'write', 'notify'] },
      { iid: 3, type: 'urn:miot-spec-v2:property:brightness:00007002:mock:1', format: 'uint8', access: ['read', 'write'], 'value-range': [1, 100, 1] },
    ] }] },
    'spec-plug': { services: [{ iid: 2, type: 'urn:miot-spec-v2:service:plug:00007801:mock:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:on:00007001:mock:1', format: 'bool', access: ['read', 'write', 'notify'] },
    ] }] },
    'spec-switch': { services: [{ iid: 2, type: 'urn:miot-spec-v2:service:switch:00007800:mock:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:on:00007001:mock:1', format: 'bool', access: ['read', 'write', 'notify'] },
    ] }] },
    'spec-sensor': { services: [{ iid: 2, type: 'urn:miot-spec-v2:service:temperature-humidity-sensor:0000780B:mock:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:temperature:00000020:mock:1', format: 'float', access: ['read', 'notify'], unit: 'celsius' },
      { iid: 2, type: 'urn:miot-spec-v2:property:relative-humidity:00000021:mock:1', format: 'uint8', access: ['read', 'notify'], unit: 'percentage' },
    ] }] },
    'spec-camera': { services: [{ iid: 2, type: 'urn:miot-spec-v2:service:camera:00007807:mock:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:video-quality:000000A9:mock:1', format: 'uint8', access: ['read'], 'value-list': [{ value: 1, description: 'low' }, { value: 2, description: 'high' }] },
    ] }] },
  };
  const values = {
    'light-1:2:1': true,
    'plug-1:2:1': false,
    'switch-1:2:1': true,
    'sensor-1:2:1': 23.4,
    'sensor-1:2:2': 48,
  };
  const calls = [];
  window.__QUICK_CALLS__ = calls;
  window.__QUICK_FAIL_SET__ = false;
  window.__QUICK_SCENE_FAIL__ = false;
  window.__QUICK_FAIL_SAVE__ = false;
  window.__MIHOME_TAURI__ = Object.freeze({
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === 'auth_resume') return loggedOut ? null : 'user-1';
      if (command === 'list_homes') return [{ id: 'home-1', name: '我的家', dids: [] }];
      if (command === 'list_devices') return devices;
      if (command === 'get_device_specs') {
        const result = {};
        for (const type of args.specTypes || []) if (specs[type]) result[type] = specs[type];
        return { specs: result, errors: [] };
      }
      if (command === 'get_properties') {
        return (args.requests || []).map((item) => ({
          did: item.did, siid: item.siid, piid: item.piid, code: 0,
          value: values[item.did + ':' + item.siid + ':' + item.piid],
        }));
      }
      if (command === 'set_property') {
        if (window.__QUICK_FAIL_SET__) throw new Error('云端拒绝写入');
        values[args.did + ':' + args.siid + ':' + args.piid] = args.value;
        return [{ did: args.did, siid: args.siid, piid: args.piid, code: 0 }];
      }
      if (command === 'list_scenes') {
        return [
          { id: 'scene-1', name: '回家', home_id: 'home-1' },
          { id: 'scene-2', name: '离家', home_id: 'home-1' },
          { id: 'scene-3', name: '晚安', home_id: 'home-1' },
          { id: 'scene-4', name: '观影', home_id: 'home-1' },
        ];
      }
      if (command === 'run_scene') {
        if (window.__QUICK_SCENE_FAIL__) throw new Error('场景执行失败');
        return [{ code: 0 }];
      }
      if (command === 'quick_open_main') return null;
      // 页面重载会清掉 window 上的东西，配置放 localStorage 里跨重载保留。
      if (command === 'quick_prefs') {
        try {
          return JSON.parse(localStorage.getItem('__QUICK_PREFS__') || 'null') || { devices: [], scenes: [] };
        } catch { return { devices: [], scenes: [] }; }
      }
      if (command === 'save_quick_prefs') {
        if (window.__QUICK_FAIL_SAVE__) throw new Error('写入配置失败');
        const saved = { devices: args.devices || [], scenes: args.scenes || [] };
        localStorage.setItem('__QUICK_PREFS__', JSON.stringify(saved));
        return saved;
      }
      throw new Error('unhandled mock invoke: ' + command);
    },
  });
})();
`;

const pageEval = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

const waitForSelector = (cdp, selector) => waitFor(() =>
  pageEval(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`));

const main = async () => {
  let browser;
  let profileDir;
  const failures = [];
  const check = (name, condition, detail = '') => {
    if (condition) {
      console.log(`  ok   ${name}`);
    } else {
      failures.push(`${name}${detail ? `: ${detail}` : ''}`);
      console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
  };

  try {
    profileDir = await mkdtemp(path.join(tmpdir(), 'mihome-quick-'));
    const debugPort = 9222 + Math.floor(Math.random() * 800);
    browser = spawn(chromeBin, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--allow-file-access-from-files',
      '--disable-web-security',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      quickUrl,
    ], { stdio: 'ignore' });

    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok ? response.json() : null;
    });
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find((item) => item.type === 'page' && item.url.startsWith('file:'));
    if (!target) throw new Error('quick.html page target not found');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(socket);
    const runtimeErrors = [];
    cdp.onEvent = (message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || 'uncaught exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        runtimeErrors.push((message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        const text = String(message.params.entry.text || '');
        if (!text.startsWith('Failed to load resource:')) runtimeErrors.push(text);
      }
    };
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    // 尺寸与速控窗口一致（create_quick_panel 里的 inner_size），布局断言才有意义。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 420, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource });
    await pageEval(cdp, 'location.reload(); true');

    await waitForSelector(cdp, '#deviceGrid .device');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceGrid .device').length >= 5`));

    // 1. 基础渲染
    const summary = await pageEval(cdp, `(() => ({
      temp: document.querySelector('#envTemp').textContent,
      home: document.querySelector('#envHome').textContent,
      online: document.querySelector('#envOnline').textContent,
      deviceCount: document.querySelectorAll('#deviceGrid .device').length,
      names: [...document.querySelectorAll('.device-name')].map((node) => node.textContent),
      scenes: [...document.querySelectorAll('.scene')].map((node) => node.textContent),
      switchOn: [...document.querySelectorAll('.switch')].map((node) => node.classList.contains('on')),
      sensorSwitch: document.querySelectorAll('#deviceGrid .switch').length,
    }))()`);
    check('温度显示 23.4', summary.temp === '23.4', summary.temp);
    check('家庭名显示', summary.home === '我的家', summary.home);
    check('在线数显示', summary.online.includes('在线 5/6'), summary.online);
    check('设备数 6', summary.deviceCount === 6, String(summary.deviceCount));
    check('只有可开关设备有开关', summary.sensorSwitch === 3, String(summary.sensorSwitch));
    check('场景 3 个', summary.scenes.length === 3, JSON.stringify(summary.scenes));
    check('灯初始为开', summary.switchOn[0] === true, JSON.stringify(summary.switchOn));

    // 2. 开关写入
    const beforeCalls = await pageEval(cdp, 'window.__QUICK_CALLS__.filter((item) => item.command === "set_property").length');
    await pageEval(cdp, `document.querySelectorAll('#deviceGrid .switch')[0].click(); true`);
    await waitFor(() => pageEval(cdp, 'Boolean(document.querySelector("#statusLine:not([hidden])"))'));
    const afterCalls = await pageEval(cdp, `(() => {
      const call = window.__QUICK_CALLS__.filter((item) => item.command === 'set_property').at(-1);
      return { count: window.__QUICK_CALLS__.filter((item) => item.command === 'set_property').length,
        call, status: document.querySelector('#statusLine').textContent,
        on: document.querySelectorAll('#deviceGrid .switch')[0].classList.contains('on') };
    })()`);
    check('开关写入一次', afterCalls.count === beforeCalls + 1, String(afterCalls.count));
    check('写入 did 与值正确', afterCalls.call?.args?.did === 'light-1' && afterCalls.call?.args?.value === false,
      JSON.stringify(afterCalls.call));
    check('状态行提示已关闭', afterCalls.status.includes('已关闭'), afterCalls.status);
    check('开关视觉变为关闭', afterCalls.on === false, String(afterCalls.on));

    // 3. 写入失败时保持原状态并显示红色错误行
    await pageEval(cdp, 'window.__QUICK_FAIL_SET__ = true; true');
    await pageEval(cdp, `document.querySelectorAll('#deviceGrid .switch')[1].click(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#statusLine').classList.contains('error')`));
    const failureState = await pageEval(cdp, `({
      text: document.querySelector('#statusLine').textContent,
      hidden: document.querySelector('#statusLine').hidden,
      on: document.querySelectorAll('#deviceGrid .switch')[1].classList.contains('on'),
    })`);
    check('失败提示包含原因', failureState.text.includes('云端拒绝写入'), failureState.text);
    check('失败状态行不隐藏', failureState.hidden === false, String(failureState.hidden));
    check('失败后开关恢复', failureState.on === false, String(failureState.on));

    // 4. 场景执行
    const sceneCallsBefore = await pageEval(cdp, 'window.__QUICK_CALLS__.filter((item) => item.command === "run_scene").length');
    await pageEval(cdp, `document.querySelectorAll('.scene')[0].click(); true`);
    await waitFor(() => pageEval(cdp, 'window.__QUICK_CALLS__.some((item) => item.command === "run_scene")'));
    const sceneState = await pageEval(cdp, `(() => {
      const call = window.__QUICK_CALLS__.filter((item) => item.command === 'run_scene').at(-1);
      return { count: window.__QUICK_CALLS__.filter((item) => item.command === 'run_scene').length, call,
        status: document.querySelector('#statusLine').textContent };
    })()`);
    check('场景执行一次', sceneState.count === sceneCallsBefore + 1, String(sceneState.count));
    check('场景 id 与家庭正确', sceneState.call?.args?.sceneId === 'scene-1' && sceneState.call?.args?.homeId === 'home-1',
      JSON.stringify(sceneState.call));
    check('场景提示', sceneState.status.includes('「回家」已执行'), sceneState.status);

    // 5. 打开主窗口按钮调用命令
    await pageEval(cdp, `document.querySelector('#openMain').click(); true`);
    const openCalls = await pageEval(cdp, 'window.__QUICK_CALLS__.filter((item) => item.command === "quick_open_main").length');
    check('打开主窗口调用命令', openCalls >= 1, String(openCalls));

    // 5.0 底部按钮任何时候都要留在窗口可视区内。设备铺满 6 个再加状态行时，
    // 内容最容易把按钮挤出面板，因此这里在状态行显示的状态下量一次位置。
    await waitFor(() => pageEval(cdp, 'Boolean(document.querySelector("#statusLine:not([hidden])"))'));
    const layout = await pageEval(cdp, `(() => {
      const panel = document.querySelector('#panel').getBoundingClientRect();
      const button = document.querySelector('#openMain').getBoundingClientRect();
      return {
        viewport: window.innerHeight, panelBottom: panel.bottom, panelTop: panel.top,
        buttonTop: button.top, buttonBottom: button.bottom, buttonHeight: button.height,
        statusVisible: !document.querySelector('#statusLine').hidden,
        scrollHeight: document.querySelector('#panel').scrollHeight,
        clientHeight: document.querySelector('#panel').clientHeight,
      };
    })()`);
    check('状态行显示时按钮仍在窗口内', layout.buttonBottom <= layout.viewport && layout.buttonTop >= 0,
      JSON.stringify(layout));
    check('按钮有可见高度', layout.buttonHeight > 20, JSON.stringify(layout));
    check('面板内容不溢出', layout.scrollHeight <= layout.clientHeight + 1, JSON.stringify(layout));

    // 5.1 设置里挑过常用设备与场景后，面板按挑选的顺序显示，不再按默认排序。
    await pageEval(cdp, `localStorage.setItem('__QUICK_PREFS__', JSON.stringify({ devices: ['switch-1', 'unknown-1'], scenes: ['scene-3', 'scene-1'] }));
      location.reload(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceGrid .device').length === 2`));
    const pickedState = await pageEval(cdp, `({
      devices: [...document.querySelectorAll('.device-name')].map((node) => node.textContent),
      scenes: [...document.querySelectorAll('.scene')].map((node) => node.textContent),
    })`);
    check('常用设备按挑选顺序显示', JSON.stringify(pickedState.devices) === JSON.stringify(['走廊开关', '旧款空调']),
      JSON.stringify(pickedState.devices));
    check('常用场景按挑选顺序显示', JSON.stringify(pickedState.scenes) === JSON.stringify(['晚安', '回家']),
      JSON.stringify(pickedState.scenes));

    // 5.2 挑的设备全都不在当前家庭时，退回默认排序，面板不留空。
    await pageEval(cdp, `localStorage.setItem('__QUICK_PREFS__', JSON.stringify({ devices: ['gone-1'], scenes: ['gone-scene'] }));
      location.reload(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceGrid .device').length >= 5`));
    const fallbackState = await pageEval(cdp, `({
      devices: document.querySelectorAll('#deviceGrid .device').length,
      scenes: [...document.querySelectorAll('.scene')].map((node) => node.textContent),
    })`);
    check('配置失效时退回默认设备', fallbackState.devices === 6, String(fallbackState.devices));
    check('配置失效时退回默认场景', fallbackState.scenes.length === 3, JSON.stringify(fallbackState.scenes));

    await pageEval(cdp, "localStorage.removeItem('__QUICK_PREFS__'); true");

    // 5.3 面板右上角的设置按钮进入挑选模式：列出全部设备与场景，按点击顺序编号。
    await pageEval(cdp, `location.reload(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceGrid .device').length >= 5`));
    await pageEval(cdp, `document.querySelector('#editPrefs').click(); true`);
    const editEntered = await pageEval(cdp, `(() => ({
      pressed: document.querySelector('#editPrefs').getAttribute('aria-pressed'),
      mainHidden: document.querySelector('#footMain').hidden,
      editHidden: document.querySelector('#footEdit').hidden,
      devices: document.querySelectorAll('#deviceGrid .device.pickable').length,
      scenes: document.querySelectorAll('#scenes .scene.pickable').length,
      saveText: document.querySelector('#editSave').textContent,
      deviceCount: document.querySelector('#deviceCount').textContent,
    }))()`);
    check('点设置进入挑选模式', editEntered.pressed === 'true', JSON.stringify(editEntered));
    check('底部切换为取消与保存', editEntered.mainHidden === true && editEntered.editHidden === false,
      JSON.stringify(editEntered));
    check('挑选模式列出全部设备', editEntered.devices === 6, String(editEntered.devices));
    check('挑选模式列出全部场景', editEntered.scenes === 4, String(editEntered.scenes));
    check('已选计数从零开始', editEntered.deviceCount === '0/12', editEntered.deviceCount);

    // 挑选模式下点场景不执行场景，只改变选中。
    const sceneCallsInEdit = await pageEval(cdp,
      'window.__QUICK_CALLS__.filter((item) => item.command === "run_scene").length');
    await pageEval(cdp, `[...document.querySelectorAll('#deviceGrid .device.pickable')]
      .find((node) => node.textContent.includes('走廊开关')).click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#deviceGrid .device.pickable')]
      .find((node) => node.textContent.includes('旧款空调')).click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#scenes .scene.pickable')]
      .find((node) => node.textContent.includes('晚安')).click(); true`);
    const afterPicks = await pageEval(cdp, `(() => ({
      badges: [...document.querySelectorAll('#deviceGrid .device.pickable .pick-badge')]
        .map((node) => node.textContent).filter(Boolean),
      pickedDevices: [...document.querySelectorAll('#deviceGrid .device.pickable.picked .device-name')]
        .map((node) => node.textContent),
      pickedScenes: [...document.querySelectorAll('#scenes .scene.pickable.picked')].map((node) => node.textContent.trim()),
      deviceCount: document.querySelector('#deviceCount').textContent,
      sceneCount: document.querySelector('#sceneCount').textContent,
      sceneCalls: window.__QUICK_CALLS__.filter((item) => item.command === 'run_scene').length,
    }))()`);
    check('设备选中按点击顺序编号', JSON.stringify(afterPicks.badges) === JSON.stringify(['1', '2']),
      JSON.stringify(afterPicks.badges));
    check('设备选中列表正确', JSON.stringify(afterPicks.pickedDevices) === JSON.stringify(['走廊开关', '旧款空调']),
      JSON.stringify(afterPicks.pickedDevices));
    check('场景选中列表正确', afterPicks.pickedScenes.length === 1 && afterPicks.pickedScenes[0].startsWith('晚安'),
      JSON.stringify(afterPicks.pickedScenes));
    check('挑选模式计数更新', afterPicks.deviceCount === '2/12' && afterPicks.sceneCount === '1/3',
      `${afterPicks.deviceCount} ${afterPicks.sceneCount}`);
    check('挑选模式下点场景不执行', afterPicks.sceneCalls === sceneCallsInEdit, String(afterPicks.sceneCalls));

    // 取消退出后配置不变，面板仍按原来的默认规则显示。
    await pageEval(cdp, `document.querySelector('#editCancel').click(); true`);
    const afterCancel = await pageEval(cdp, `(() => ({
      pressed: document.querySelector('#editPrefs').getAttribute('aria-pressed'),
      mainHidden: document.querySelector('#footMain').hidden,
      devices: document.querySelectorAll('#deviceGrid .device').length,
      stored: localStorage.getItem('__QUICK_PREFS__'),
    }))()`);
    check('取消退出挑选模式', afterCancel.pressed === 'false' && afterCancel.mainHidden === false,
      JSON.stringify(afterCancel));
    check('取消不写入配置', afterCancel.stored === null, String(afterCancel.stored));
    check('取消后回到常用设备', afterCancel.devices === 6, String(afterCancel.devices));

    // 保存后写回后端，面板立即按挑选的顺序显示。
    await pageEval(cdp, `document.querySelector('#editPrefs').click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#deviceGrid .device.pickable')]
      .find((node) => node.textContent.includes('书桌插座')).click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#deviceGrid .device.pickable')]
      .find((node) => node.textContent.includes('走廊开关')).click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#scenes .scene.pickable')]
      .find((node) => node.textContent.includes('观影')).click(); true`);
    await pageEval(cdp, `document.querySelector('#editSave').click(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#editPrefs').getAttribute('aria-pressed') === 'false'`));
    const afterSave = await pageEval(cdp, `(() => ({
      call: window.__QUICK_CALLS__.filter((item) => item.command === 'save_quick_prefs').at(-1),
      stored: JSON.parse(localStorage.getItem('__QUICK_PREFS__') || 'null'),
      devices: [...document.querySelectorAll('#deviceGrid .device .device-name')].map((node) => node.textContent),
      scenes: [...document.querySelectorAll('#scenes .scene')].map((node) => node.textContent),
      status: document.querySelector('#statusLine').textContent,
      hasSwitch: document.querySelectorAll('#deviceGrid .switch').length,
    }))()`);
    check('保存写入一台设备与一个场景',
      JSON.stringify(afterSave.call?.args?.devices) === JSON.stringify(['plug-1', 'switch-1'])
      && JSON.stringify(afterSave.call?.args?.scenes) === JSON.stringify(['scene-4']),
      JSON.stringify(afterSave.call));
    check('后端返回的配置已保存',
      JSON.stringify(afterSave.stored?.devices) === JSON.stringify(['plug-1', 'switch-1']),
      JSON.stringify(afterSave.stored));
    check('保存后面板按挑选顺序显示设备',
      JSON.stringify(afterSave.devices) === JSON.stringify(['书桌插座', '走廊开关']),
      JSON.stringify(afterSave.devices));
    check('保存后面板按挑选顺序显示场景',
      JSON.stringify(afterSave.scenes) === JSON.stringify(['观影']), JSON.stringify(afterSave.scenes));
    check('保存后有提示', afterSave.status.includes('面板已更新'), afterSave.status);
    check('保存后恢复开关控件', afterSave.hasSwitch === 2, String(afterSave.hasSwitch));

    // 保存失败时留在挑选模式，已选内容不丢。
    await pageEval(cdp, 'window.__QUICK_FAIL_SAVE__ = true; true');
    await pageEval(cdp, `document.querySelector('#editPrefs').click(); true`);
    await pageEval(cdp, `[...document.querySelectorAll('#deviceGrid .device.pickable')]
      .find((node) => node.textContent.includes('客厅吸顶灯')).click(); true`);
    await pageEval(cdp, `document.querySelector('#editSave').click(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#statusLine').classList.contains('error')`));
    const saveFailure = await pageEval(cdp, `(() => ({
      text: document.querySelector('#statusLine').textContent,
      pressed: document.querySelector('#editPrefs').getAttribute('aria-pressed'),
      saveDisabled: document.querySelector('#editSave').disabled,
      saveText: document.querySelector('#editSave').textContent,
      picked: [...document.querySelectorAll('#deviceGrid .device.pickable.picked .device-name')]
        .map((node) => node.textContent),
    }))()`);
    check('保存失败提示原因', saveFailure.text.includes('写入配置失败'), saveFailure.text);
    check('保存失败留在挑选模式', saveFailure.pressed === 'true', saveFailure.pressed);
    check('保存失败后按钮可重试', saveFailure.saveDisabled === false && saveFailure.saveText === '保存',
      `${saveFailure.saveDisabled} ${saveFailure.saveText}`);
    check('保存失败不丢已选', saveFailure.picked.includes('客厅吸顶灯'), JSON.stringify(saveFailure.picked));
    await pageEval(cdp, `window.__QUICK_FAIL_SAVE__ = false; document.querySelector('#editCancel').click(); true`);

    // 挑选模式下按钮仍要留在窗口里，且面板内容不溢出。
    await pageEval(cdp, `document.querySelector('#editPrefs').click(); true`);
    const editLayout = await pageEval(cdp, `(() => {
      const viewport = window.innerHeight;
      const save = document.querySelector('#editSave').getBoundingClientRect();
      const cancel = document.querySelector('#editCancel').getBoundingClientRect();
      const grid = document.querySelector('#deviceGrid');
      const panel = document.querySelector('#panel');
      return { viewport, saveBottom: save.bottom, saveTop: save.top, cancelBottom: cancel.bottom,
        gridScroll: grid.scrollHeight, gridClient: grid.clientHeight,
        scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
    })()`);
    check('挑选模式按钮在窗口内',
      editLayout.saveBottom <= editLayout.viewport && editLayout.saveTop >= 0
      && editLayout.cancelBottom <= editLayout.viewport, JSON.stringify(editLayout));
    check('挑选模式面板不溢出', editLayout.scrollHeight <= editLayout.clientHeight + 1,
      JSON.stringify(editLayout));
    await pageEval(cdp, `document.querySelector('#editCancel').click(); true`);
    await pageEval(cdp, "localStorage.removeItem('__QUICK_PREFS__'); true");

    // 5.4 设备数超过上限时：挑选模式仍列出全部设备，选到 12 台后拒绝再加，
    // 设备区自己滚动，面板不溢出。
    await pageEval(cdp, `location.hash = '#many-devices'; location.reload(); true`).catch(() => {});
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceGrid .device').length === 12`));
    const manyNormal = await pageEval(cdp, `(() => {
      const panel = document.querySelector('#panel');
      return { devices: document.querySelectorAll('#deviceGrid .device').length,
        deviceCount: document.querySelector('#deviceCount').textContent,
        scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
    })()`);
    check('常用设备最多显示 12 台', manyNormal.devices === 12 && manyNormal.deviceCount === '12/14',
      JSON.stringify(manyNormal));
    check('12 台设备时面板不溢出', manyNormal.scrollHeight <= manyNormal.clientHeight + 1,
      JSON.stringify(manyNormal));

    await pageEval(cdp, `document.querySelector('#editPrefs').click(); true`);
    const manyEntered = await pageEval(cdp, `(() => ({
      devices: document.querySelectorAll('#deviceGrid .device.pickable').length,
      deviceCount: document.querySelector('#deviceCount').textContent,
    }))()`);
    check('设备多于上限时全部列出', manyEntered.devices === 14, String(manyEntered.devices));
    check('上限计数显示 12', manyEntered.deviceCount === '0/12', manyEntered.deviceCount);

    // 依次点满全部 14 台：每次点击都会重绘设备区，所以要按索引重新取节点。
    // 前 12 台选中，后 2 台被上限挡下。
    for (let index = 0; index < 14; index += 1) {
      await pageEval(cdp,
        `document.querySelectorAll('#deviceGrid .device.pickable')[${index}].click(); true`);
    }
    const manyPicked = await pageEval(cdp, `(() => {
      const grid = document.querySelector('#deviceGrid');
      const panel = document.querySelector('#panel');
      return {
        picked: document.querySelectorAll('#deviceGrid .device.pickable.picked').length,
        badges: [...document.querySelectorAll('#deviceGrid .device.pickable.picked .pick-badge')]
          .map((node) => node.textContent),
        deviceCount: document.querySelector('#deviceCount').textContent,
        status: document.querySelector('#statusLine').textContent,
        gridScroll: grid.scrollHeight, gridClient: grid.clientHeight,
        scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      };
    })()`);
    check('超过上限不再加入', manyPicked.picked === 12, String(manyPicked.picked));
    check('选中编号连续', JSON.stringify(manyPicked.badges) === JSON.stringify(
      Array.from({ length: 12 }, (_, index) => String(index + 1))), JSON.stringify(manyPicked.badges));
    check('计数停在上限', manyPicked.deviceCount === '12/12', manyPicked.deviceCount);
    check('超出上限有提示', manyPicked.status.includes('最多选 12 台设备'), manyPicked.status);
    check('设备超额时设备区可滚动', manyPicked.gridScroll > manyPicked.gridClient,
      `${manyPicked.gridScroll} > ${manyPicked.gridClient}`);
    check('设备超额时面板不溢出', manyPicked.scrollHeight <= manyPicked.clientHeight + 1,
      JSON.stringify(manyPicked));

    // 已选中的仍可以点掉，移出后腾出位置。
    await pageEval(cdp, `document.querySelectorAll('#deviceGrid .device.pickable.picked')[0].click(); true`);
    const afterUnpick = await pageEval(cdp, `({
      picked: document.querySelectorAll('#deviceGrid .device.pickable.picked').length,
      deviceCount: document.querySelector('#deviceCount').textContent,
      status: document.querySelector('#statusLine').textContent,
    })`);
    check('移出一台后计数回落', afterUnpick.picked === 11 && afterUnpick.deviceCount === '11/12',
      JSON.stringify(afterUnpick));
    check('移出后清掉上限提示', !afterUnpick.status.includes('最多选'), afterUnpick.status);

    await pageEval(cdp, `document.querySelector('#editCancel').click(); true`);
    await pageEval(cdp, `location.hash = ''; true`);

    // 6. 未登录状态
    await pageEval(cdp, `location.hash = '#logged-out'; location.reload(); true`).catch(() => {});
    await waitFor(async () => {
      const stateValue = await pageEval(cdp, `document.querySelector('#envHome')?.textContent`);
      return stateValue === '未登录';
    });
    const loggedOutState = await pageEval(cdp, `({
      home: document.querySelector('#envHome').textContent,
      devices: document.querySelector('#deviceGrid').textContent,
    })`);
    check('未登录提示', loggedOutState.home === '未登录', loggedOutState.home);
    check('未登录设备区提示', loggedOutState.devices.includes('未登录'), loggedOutState.devices);

    check('无运行时异常', runtimeErrors.length === 0, runtimeErrors.join(' | '));

    if (failures.length) {
      console.error(`\n${failures.length} 项失败：`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\n全部通过');
    }
  } finally {
    try { browser?.kill('SIGTERM'); } catch {}
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
