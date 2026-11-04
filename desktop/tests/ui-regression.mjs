#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const chromeBin = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const rounds = Number(process.env.UI_REGRESSION_ROUNDS || 10);
const screenshots = process.env.UI_REGRESSION_SCREENSHOTS !== '0';
const outputDir = process.env.UI_REGRESSION_OUTPUT
  || path.join(here, 'artifacts');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const file = path.resolve(repo, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(repo)) throw new Error('forbidden');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': mime.get(path.extname(file)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

const listen = () => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.onEvent?.(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const waitFor = async (check, timeout = 12000) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw last instanceof Error ? last : new Error(`timeout: ${JSON.stringify(last)}`);
};

const mockSource = String.raw`
(() => {
  const specs = {
    'urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:temperature-humidity-sensor:0000780B:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:temperature:00000020:mock:1', description: 'Temperature', format: 'float', access: ['read'], unit: 'celsius' },
          { iid: 2, type: 'urn:miot-spec-v2:property:relative-humidity:00000021:mock:1', description: 'Relative Humidity', format: 'uint8', access: ['read'], unit: 'percentage' },
          { iid: 3, type: 'urn:miot-spec-v2:property:battery-level:0000000A:mock:1', description: 'Battery Level', format: 'uint8', access: ['read'], unit: 'percentage' },
        ],
      }],
    },
    'urn:miot-spec-v2:device:light:0000A001:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:brightness:00000010:mock:1', description: 'Brightness', format: 'uint8', access: ['read', 'write'], unit: 'percentage', 'value-range': [1, 100, 1] },
          { iid: 3, type: 'urn:miot-spec-v2:property:color-temperature:0000000B:mock:1', description: 'Color Temperature', format: 'uint16', access: ['read', 'write'], unit: 'kelvin', 'value-range': [2700, 6500, 100] },
          { iid: 4, type: 'urn:miot-spec-v2:property:mode:00000008:mock:1', description: 'Mode', format: 'uint8', access: ['read', 'write'], 'value-list': [{ value: 0, description: 'None' }, { value: 1, description: 'Reading' }, { value: 2, description: 'Lighting' }, { value: 3, description: 'Tv' }, { value: 4, description: 'Warmth' }, { value: 5, description: 'Night Light' }, { value: 6, description: 'Vendor Private Mode' }] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:curtain:0000A00D:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:curtain:00007808:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:target-position:0000001A:mock:1', description: 'Target Position', format: 'uint8', access: ['read', 'write'], unit: 'percentage', 'value-range': [0, 100, 1] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:camera:0000A009:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:camera-control:0000782F:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Camera Switch', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:night-shot:00000057:mock:1', description: 'Night Shot', format: 'uint8', access: ['read', 'write'], 'value-list': [{ value: 0, description: 'Auto' }, { value: 1, description: 'Off' }] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:outlet:0000A002:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:switch:00007801:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:television:0000A00C:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:television:00007809:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:router:0000A036:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:router:00007864:mock:1',
        description: 'Router',
        properties: [
          { iid: 3, type: 'urn:miot-spec-v2:property:connected-device-number:000000A0:mock:1', description: 'Connected Device Number', format: 'uint16', access: ['read', 'notify'] },
        ],
      }, {
        iid: 5,
        type: 'urn:miot-spec-v2:service:indicator-light:00007803:mock:1',
        description: 'Indicator Light',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write', 'notify'] },
        ],
      }],
    },
  };
  const values = {
    'sensor1:2:1': 23.6,
    'sensor1:2:2': 51,
    'sensor1:2:3': 86,
    'light1:2:1': true,
    'light1:2:2': 68,
    'light1:2:3': 4200,
    'light1:2:4': 1,
    'curtain1:2:1': true,
    'curtain1:2:2': 60,
    'camera1:2:1': true,
    'camera1:2:2': 0,
    'camera2:2:1': true,
    'camera2:2:2': 0,
    'plug1:2:1': true,
    'fan1:2:1': false,
    'fan1:2:2': 20,
    'fan1:2:4': 1,
    'tv1:2:1': false,
    'router1:2:3': 22,
    'router1:5:1': false,
    'b-light:2:1': true,
    'b-light:2:2': 55,
    'b-light:2:3': 3900,
    'b-light:2:4': 2,
    'c-light:2:1': false,
    'c-light:2:2': 80,
    'c-light:2:3': 5000,
    'c-light:2:4': 3,
  };
  const devices = [
    { did: 'sensor1', name: '温湿度计', model: 'miaomiaoce.sensor_ht.t8', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:mock:1', parent_id: null },
    { did: 'light1', name: '客厅主灯', model: 'yeelink.light.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null },
    { did: 'curtain1', name: '客厅窗帘', model: 'lumi.curtain.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:curtain:0000A00D:mock:1', parent_id: null },
    { did: 'camera1', name: '小米智能摄像机3 云台版', model: 'chuangmi.camera.069a01', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1', parent_id: null },
    { did: 'camera2', name: '小米智能摄像机2 云台版', model: 'chuangmi.camera.039a01', home_id: 'home1', room_id: 'study', room_name: '书房', online: true, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1', parent_id: null },
    { did: 'plug1', name: '书房插座', model: 'cuco.plug.mock', home_id: 'home1', room_id: 'study', room_name: '书房', online: true, spec_type: 'urn:miot-spec-v2:device:outlet:0000A002:mock:1', parent_id: null },
    { did: 'fan1', name: '卧室风扇灯', model: 'yeelink.light.fanmock', home_id: 'home1', room_id: 'bedroom', room_name: '卧室', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null },
    { did: 'tv1', name: '客厅电视', model: 'xiaomi.tv.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: false, spec_type: 'urn:miot-spec-v2:device:television:0000A00C:mock:1', parent_id: null },
    { did: 'router1', name: '客厅路由器', model: 'xiaomi.router.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:router:0000A036:mock:1', parent_id: null },
  ];
  const scenes = [
    { id: 'scene-home', name: '回家', home_id: 'home1' },
    { id: 'scene-away', name: '离家', home_id: 'home1' },
    { id: 'scene-movie', name: '观影', home_id: 'home1' },
  ];
  const cameras = [
    { did: 'camera1', name: '小米智能摄像机3 云台版', model: 'chuangmi.camera.069a01', ip: '192.0.2.10', online: true, subtype: 'camera', channel: 0, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1' },
    { did: 'camera2', name: '小米智能摄像机2 云台版', model: 'chuangmi.camera.039a01', ip: null, online: true, subtype: 'camera', channel: 0, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1' },
  ];
  const accountDevices = {
    'mock-user': devices,
    'mock-user-2': [{
      did: 'b-light', name: '工作室射灯', model: 'yeelink.light.mock', home_id: 'home-b', room_id: 'b-room', room_name: '工作室', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null,
    }],
    'mock-user-3': [{
      did: 'c-light', name: '创意工作室灯', model: 'yeelink.light.mock', home_id: 'home-c', room_id: 'c-room', room_name: '工位', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null,
    }],
  };
  const accountHomes = {
    'mock-user': [{
      id: 'home1', name: '云栖公寓', uid: 1, room_count: 3,
      rooms: [
        { id: 'living', name: '客厅', dids: ['sensor1', 'light1', 'curtain1', 'camera1', 'tv1', 'router1'] },
        { id: 'study', name: '书房', dids: ['camera2', 'plug1'] },
        { id: 'bedroom', name: '卧室', dids: ['fan1'] },
      ],
    }, {
      id: 'home2', name: '工作室', uid: 1, room_count: 3,
      rooms: [
        { id: 'living', name: '客厅', dids: ['sensor1', 'light1', 'curtain1', 'camera1', 'tv1', 'router1'] },
        { id: 'study', name: '书房', dids: ['camera2', 'plug1'] },
        { id: 'bedroom', name: '卧室', dids: ['fan1'] },
      ],
    }],
    'mock-user-2': [{ id: 'home-b', name: '湖畔住宅', uid: 2, room_count: 1, rooms: [{ id: 'b-room', name: '工作室', dids: ['b-light'] }] }],
    'mock-user-3': [{ id: 'home-c', name: '创意工作室', uid: 3, room_count: 1, rooms: [{ id: 'c-room', name: '工位', dids: ['c-light'] }] }],
  };
  const accountScenes = {
    'mock-user': scenes,
    'mock-user-2': [{ id: 'scene-b', name: '工作室加班', home_id: 'home-b' }],
    'mock-user-3': [{ id: 'scene-c', name: '创意模式', home_id: 'home-c' }],
  };
  const accountCameras = {
    'mock-user': cameras,
    'mock-user-2': [],
    'mock-user-3': [],
  };
  let accounts = [
    { user_id: 'mock-user', display_name: '云栖账号', active: true },
    { user_id: 'mock-user-2', display_name: '工作室账号', active: false },
  ];
  let activeUserId = 'mock-user';
  const accountSummaries = () => accounts.map((account) => ({
    ...account,
    active: account.user_id === activeUserId,
  }));
  let authGeneration = 0;
  const setActiveAccount = (userId) => {
    if (!accounts.some((account) => account.user_id === userId)) return false;
    activeUserId = userId;
    return true;
  };
  window.__SET_DEVICE_ONLINE__ = (did, online) => {
    const device = (accountDevices[activeUserId] || []).find((item) => item.did === did);
    if (device) device.online = Boolean(online);
  };
  const accountAutomations = {
    'mock-user': [{
      id: 'auto1',
      name: '早上开灯',
      time: '07:30',
      days: [1, 2, 3, 4, 5],
      scene_id: 'scene-home',
      home_id: 'home1',
      enabled: true,
      last_run: null,
    }],
    'mock-user-2': [],
    'mock-user-3': [],
  };
  let automationSequence = 10;
  window.__MOCK_NEXT_LOGIN__ = null;
  window.__MOCK_DELAY_NEXT__ = null;
  window.__MOCK_CALLS__ = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  window.__MIHOME_TAURI__ = Object.freeze({
    invoke: async (command, args = {}) => {
      window.__MOCK_CALLS__.push({ command, args: clone(args) });
      const delayed = window.__MOCK_DELAY_NEXT__;
      if (delayed && delayed.command === command
        && (!delayed.account || delayed.account === activeUserId)) {
        window.__MOCK_DELAY_NEXT__ = null;
        await new Promise((resolve) => setTimeout(resolve, delayed.ms));
      }
      if (command === 'auth_resume') return activeUserId;
      if (command === 'auth_accounts') return clone(accountSummaries());
      if (command === 'auth_logout') {
        accounts = accounts.filter((account) => account.user_id !== activeUserId);
        activeUserId = accounts[0]?.user_id || null;
        return { active_user_id: activeUserId, accounts: clone(accountSummaries()) };
      }
      if (command === 'auth_switch_account') {
        if (!setActiveAccount(args.userId)) throw new Error('mock account missing');
        return args.userId;
      }
      if (command === 'auth_set_account_label') {
        const account = accounts.find((item) => item.user_id === activeUserId);
        if (account) account.display_name = args.label;
        return null;
      }
      if (command === 'auth_cancel') {
        authGeneration += 1;
        return null;
      }
      if (command === 'auth_start') {
        authGeneration += 1;
        return {
          qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-label="mock qr"><rect width="20" height="20" fill="#fff"/><path d="M2 2h6v6H2zm10 0h6v6h-6zM2 12h6v6H2zm10 2h2v2h-2zm4-2h2v2h-2z" fill="#111"/></svg>',
        };
      }
      if (command === 'auth_poll') {
        const pollGeneration = authGeneration;
        if (window.__MOCK_DELAY_NEXT__?.command === 'auth_poll') {
          await new Promise((resolve) => setTimeout(resolve, window.__MOCK_DELAY_NEXT__.ms));
          window.__MOCK_DELAY_NEXT__ = null;
        }
        if (pollGeneration !== authGeneration) {
          return { status: 'error', user_id: null, message: '登录已取消' };
        }
        const userId = window.__MOCK_NEXT_LOGIN__ || accounts[0]?.user_id || 'mock-user';
        const labels = { 'mock-user': '云栖账号', 'mock-user-2': '工作室账号', 'mock-user-3': '创意账号' };
        window.__MOCK_NEXT_LOGIN__ = null;
        if (!accounts.some((account) => account.user_id === userId)) {
          accounts.push({ user_id: userId, display_name: labels[userId] || null, active: false });
        }
        setActiveAccount(userId);
        return { status: 'success', user_id: userId, message: '' };
      }
      if (command === 'app_meta') return { name: 'MiHome Mac', version: '1.1.0' };
      if (command === 'ui_ready' || command === 'camera_stop' || command === 'log_export') return null;
      if (command === 'list_homes') return clone(accountHomes[activeUserId] || []);
      if (command === 'list_devices') return clone(accountDevices[activeUserId] || []);
      if (command === 'get_device_specs') {
        return {
          specs: Object.fromEntries(args.specTypes.filter((key) => specs[key]).map((key) => [key, specs[key]])),
          errors: [],
        };
      }
      if (command === 'get_properties' || command === 'get_property') {
        const requests = command === 'get_properties' ? args.requests : [{ did: args.did, siid: args.siid, piid: args.piid }];
        return requests.map(({ did, siid, piid }) => ({
          did, siid, piid, code: 0, value: values[did + ':' + siid + ':' + piid],
        }));
      }
      if (command === 'set_property') {
        values[args.did + ':' + args.siid + ':' + args.piid] = args.value;
        return [{ code: 0 }];
      }
      if (command === 'call_action') return null;
      if (command === 'list_scenes') return clone(accountScenes[activeUserId] || []);
      if (command === 'run_scene') return null;
      if (command === 'list_cameras') return clone(accountCameras[activeUserId] || []);
      if (command === 'camera_start') {
        return args.dids.map((did) => ({ id: did, url: 'http://127.0.0.1:9/mock.m3u8', host: 'local', prefer_mse: true, video_only: true }));
      }
      if (command === 'camera_remote_start') {
        return { id: args.did, url: 'http://127.0.0.1:9/mock.m3u8', host: 'CS2 relay', prefer_mse: false, video_only: true, webrtc_url: null };
      }
      if (command === 'camera_remote_stop' || command === 'camera_remote_ptz') return null;
      if (command === 'camera_diagnostics') return { alive: true, api_ready: true, detail: 'mock ready' };
      if (command === 'list_automations') return clone(accountAutomations[activeUserId] || []);
      if (command === 'save_automation') {
        const item = { ...args.automation, id: 'auto' + automationSequence++ };
        accountAutomations[activeUserId].push(item);
        return clone(accountAutomations[activeUserId]);
      }
      if (command === 'toggle_automation') {
        accountAutomations[activeUserId] = accountAutomations[activeUserId]
          .map((item) => item.id === args.id ? { ...item, enabled: args.enabled } : item);
        return clone(accountAutomations[activeUserId]);
      }
      if (command === 'delete_automation') {
        accountAutomations[activeUserId] = accountAutomations[activeUserId]
          .filter((item) => item.id !== args.id);
        return clone(accountAutomations[activeUserId]);
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

const click = (selector) => pageEval(cdp, `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) throw new Error('missing selector: ' + ${JSON.stringify(selector)});
  node.click();
  return true;
})()`);

const waitForSelector = (selector) => waitFor(() =>
  pageEval(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`));

let cdp;
let browser;
let profileDir;
let serverPort;

try {
  serverPort = await listen();
  profileDir = await mkdtemp(path.join(tmpdir(), 'mihome-ui-'));
  const debugPort = 9222 + Math.floor(Math.random() * 800);
  browser = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return response.ok ? response.json() : null;
  });
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('Chrome page target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  cdp = new Cdp(socket);
  const runtimeErrors = [];
  const ignoredResourceErrors = [];
  const recordRuntimeError = (text) => {
    if (String(text).startsWith('Failed to load resource:')) ignoredResourceErrors.push(String(text));
    else runtimeErrors.push(String(text));
  };
  cdp.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      recordRuntimeError(detail?.exception?.description || detail?.text || 'uncaught exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      recordRuntimeError(message.params.entry.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      recordRuntimeError(text || 'console.error');
    }
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource });
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${serverPort}/desktop/ui/index.html`,
  });
  await waitFor(() => pageEval(cdp, `document.readyState === 'complete'`));
  await waitForSelector('#overviewView .page-head');

  const failures = [];
  const timings = [];
  const screenshotFiles = [];
  let viewportWidth = 1440;
  let viewportHeight = 900;
  let checks = 0;
  const screenshot = async (name) => {
    if (!screenshots) return;
    await pageEval(cdp, `document.querySelectorAll('#toastStack .toast').forEach((node) => node.remove()); true`);
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buffer = Buffer.from(result.data, 'base64');
    const file = path.join(outputDir, `${name}.png`);
    await writeFile(file, buffer);
    const png = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 0;
    expect(png, `screenshot ${name}: invalid PNG`);
    expect(buffer.length > 2048, `screenshot ${name}: suspiciously small (${buffer.length} bytes)`);
    expect(
      width === viewportWidth && height === viewportHeight,
      `screenshot ${name}: expected ${viewportWidth}x${viewportHeight}, got ${width}x${height}`,
    );
    screenshotFiles.push({ name, file, width, height, bytes: buffer.length });
  };

  const actionTime = async (expression) => {
    const result = await pageEval(cdp, `(async () => {
      const start = performance.now();
      ${expression}
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    })()`);
    timings.push(result);
    return result;
  };

  const expect = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };

  if (screenshots) await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));

  for (let round = 1; round <= rounds; round += 1) {
    await pageEval(cdp, `location.reload(); true`);
    await waitFor(() => pageEval(cdp, `document.readyState === 'complete'`));
    await waitForSelector('#overviewView .page-head');

    const overview = await pageEval(cdp, `({
      title: document.querySelector('#overviewView .page-title')?.textContent,
      rows: document.querySelectorAll('#overviewView .device-row').length,
      hasTopnav: Boolean(document.querySelector('.topnav')),
      hasSidebar: Boolean(document.querySelector('.sidebar')),
      hasStatus: Boolean(document.querySelector('.statusbar')),
      hasMenuBar: Boolean(document.querySelector('#btnMenuBar')),
      hasThemeToggle: Boolean(document.querySelector('#btnTheme svg')),
      hasAddRoom: Boolean(document.querySelector('#btnAddRoom')),
      hasHud: Boolean(document.querySelector('#hud')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    })`);
    expect(overview.hasTopnav && overview.hasSidebar && overview.hasStatus, `round ${round}: shell missing`);
    expect(
      overview.hasMenuBar && overview.hasThemeToggle && overview.hasAddRoom && overview.hasHud,
      `round ${round}: prototype shell controls missing`,
    );
    expect(overview.rows === 9, `round ${round}: expected 9 overview rows, got ${overview.rows}`);
    expect(overview.overflow === false, `round ${round}: horizontal overflow on overview`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#overviewView .device-row[data-did="router1"] .device-meta')?.textContent.includes('连接设备数')`,
    ));
    const routerCard = await pageEval(cdp, `({
      meta: document.querySelector('#overviewView .device-row[data-did="router1"] .device-meta')?.textContent,
      switch: Boolean(document.querySelector('#overviewView .device-row[data-did="router1"] .inline-switch')),
      offline: document.querySelector('#overviewView .device-row[data-did="router1"]')?.classList.contains('off'),
    })`);
    expect(!routerCard.offline, `round ${round}: online router is rendered offline`);
    expect(!routerCard.switch, `round ${round}: router indicator light is exposed as router power`);
    expect(
      !/已关闭|离线/.test(routerCard.meta || ''),
      `round ${round}: router card shows the wrong state: ${routerCard.meta}`,
    );
    await screenshot(`r${round}-01-overview`);

    await click('#btnMenuBar');
    const quickPanel = await pageEval(cdp, `({
      open: document.querySelector('#menubarPop').classList.contains('open'),
      devices: document.querySelectorAll('#popGrid .pop-device').length,
      scenes: document.querySelectorAll('#popScenes button').length,
    })`);
    expect(quickPanel.open, `round ${round}: quick panel did not open`);
    expect(quickPanel.devices > 0 && quickPanel.scenes > 0, `round ${round}: quick panel is empty`);
    await screenshot(`r${round}-02-quick-panel`);
    await click('#popOpen');
    expect(
      await pageEval(cdp, `!document.querySelector('#menubarPop').classList.contains('open')`),
      `round ${round}: quick panel did not close`,
    );

    const themeBefore = await pageEval(cdp, `document.body.dataset.theme`);
    await click('#btnTheme');
    expect(
      await pageEval(cdp, `document.body.dataset.theme !== ${JSON.stringify(themeBefore)}`),
      `round ${round}: titlebar theme toggle failed`,
    );
    await click('#btnTheme');

    await click('#btnHud');
    await waitForSelector('#hud.show');
    const hudState = await pageEval(cdp, `({
      visible: document.querySelector('#hud').classList.contains('show'),
      dom: document.querySelector('#hudDom').textContent,
      inflight: document.querySelector('#hudInflight').textContent,
    })`);
    expect(hudState.visible, `round ${round}: performance HUD did not open`);
    expect(hudState.dom !== '--' && Number(hudState.dom) > 0, `round ${round}: performance HUD has no DOM metric`);
    expect(Number(hudState.inflight) >= 0, `round ${round}: performance HUD has invalid inflight metric`);
    await screenshot(`r${round}-03-performance-hud`);
    await click('#hudClose');

    await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('fan1', false); window.dispatchEvent(new Event('focus')); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('.device-row[data-did="fan1"]')?.classList.contains('off') === true`,
    ));
    await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('fan1', true); window.dispatchEvent(new Event('focus')); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('.device-row[data-did="fan1"]')?.classList.contains('off') === false`,
    ));
    expect(
      await pageEval(cdp, `document.querySelector('.device-row[data-did="fan1"] .device-meta')?.textContent !== '设备离线'`),
      `round ${round}: online device still shows offline metadata`,
    );
    await screenshot(`r${round}-04-device-online-recovered`);

    await actionTime(`document.querySelector('[data-room="living"]')?.click()`);
    const room = await pageEval(cdp, `({
      title: document.querySelector('#overviewView .page-title')?.textContent,
      rows: document.querySelectorAll('#overviewView .device-row').length,
    })`);
    expect(room.title === '客厅', `round ${round}: room filter title ${room.title}`);
    expect(room.rows === 6, `round ${round}: room filter rows ${room.rows}`);
    await screenshot(`r${round}-05-room-filter`);
    await click('[data-room="all"]');

    for (const [nav, view] of [
      ['#cameraNav', '#cameraView'],
      ['#sceneNav', '#sceneView'],
      ['#automationNav', '#automationView'],
      ['#devicesNav', '#devicesView'],
      ['#overviewNav', '#overviewView'],
    ]) {
      await actionTime(`document.querySelector(${JSON.stringify(nav)}).click()`);
      const visible = await pageEval(cdp, `({
        view: !document.querySelector(${JSON.stringify(view)}).hidden,
        active: document.querySelector(${JSON.stringify(nav)}).classList.contains('active'),
        overflow: document.documentElement.scrollWidth > innerWidth,
      })`);
      expect(visible.view, `round ${round}: ${nav} did not show ${view}`);
      expect(visible.active, `round ${round}: ${nav} active state missing`);
      expect(visible.overflow === false, `round ${round}: horizontal overflow on ${nav}`);
    }

    await click('#devicesNav');
    const devicesPage = await pageEval(cdp, `({
      title: document.querySelector('#devicesView .page-title')?.textContent,
      filters: document.querySelectorAll('#deviceFilters .filter-chip').length,
      rows: document.querySelectorAll('#deviceList .table-row').length,
      hasSearch: Boolean(document.querySelector('#deviceSearch')),
      hasTableHead: Boolean(document.querySelector('#devicesView .table-head')),
    })`);
    expect(devicesPage.title === '全部设备', `round ${round}: devices title ${devicesPage.title}`);
    expect(devicesPage.filters === 4, `round ${round}: expected 4 device filters, got ${devicesPage.filters}`);
    expect(devicesPage.rows === 9, `round ${round}: expected 9 table rows, got ${devicesPage.rows}`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#deviceList .table-row[data-did="router1"] .state-pill')?.textContent === '在线'`,
    ));
    const routerState = await pageEval(cdp, `({
      state: document.querySelector('#deviceList .table-row[data-did="router1"] .state-pill')?.textContent,
      summary: document.querySelector('#deviceList .table-row[data-did="router1"] .table-device')?.textContent,
    })`);
    expect(routerState.state === '在线', `round ${round}: online router shows ${routerState.state}`);
    expect(
      !/关闭|离线/.test(routerState.summary || ''),
      `round ${round}: router summary conflates indicator light with router power`,
    );
    expect(devicesPage.hasSearch && devicesPage.hasTableHead, `round ${round}: devices toolbar is incomplete`);
    await screenshot(`r${round}-06-devices`);
    await pageEval(cdp, `(() => {
      const input = document.querySelector('#deviceSearch');
      input.value = '摄像机';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 2`));
    await screenshot(`r${round}-07-devices-search`);
    await pageEval(cdp, `(() => {
      const input = document.querySelector('#deviceSearch');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-device-filter="local"]').click();
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 1`));
    await screenshot(`r${round}-08-devices-local-filter`);
    await click('[data-device-filter="all"]');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 9`));
    await waitForSelector('#deviceList .table-row[data-did="light1"]');
    await click('#deviceList .table-row[data-did="light1"]');
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector').classList.contains('open')`));
    const inspector = await pageEval(cdp, `({
      open: document.querySelector('#inspector').classList.contains('open'),
      title: document.querySelector('#inspector .detail-heading h3')?.textContent,
      controls: document.querySelectorAll('#inspector .detail-control-row, #inspector .detail-range, #inspector .detail-segment').length,
    })`);
    expect(inspector.open && inspector.title, `round ${round}: inspector did not open`);
    expect(inspector.controls > 0, `round ${round}: inspector has no controls`);
    const setCallsBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'set_property').length`);
    const switched = await pageEval(cdp, `(() => {
      const control = document.querySelector('#inspector .detail-switch:not(:disabled)');
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (switched) {
      await waitFor(() => pageEval(
        cdp,
        `window.__MOCK_CALLS__.filter((item) => item.command === 'set_property').length > ${setCallsBefore}`,
      ));
    }
    expect(switched, `round ${round}: inspector has no enabled switch`);
    await screenshot(`r${round}-09-device-inspector`);
    await click('#inspector .insp-close');
    await waitForSelector('#deviceList .table-row[data-did="fan1"]');
    await click('#deviceList .table-row[data-did="fan1"]');
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector').classList.contains('open')`));
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .detail-segment').length > 0`));
    const fanLabels = await pageEval(cdp, `[
      ...document.querySelectorAll('#inspector .detail-segment'),
    ].map((node) => node.textContent)`);
    expect(
      !fanLabels.some((label) => label.includes('未知选项') || /unknown option/i.test(label)),
      `round ${round}: inspector exposes untranslatable mode buttons`,
    );
    expect(
      fanLabels.includes('阅读') && fanLabels.includes('照明'),
      `round ${round}: known fan-light modes are missing`,
    );
    await screenshot(`r${round}-09b-fan-inspector`);
    await click('#inspector .insp-close');

    await click('#sceneNav');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#sceneList .scene-card').length === 3`));
    await screenshot(`r${round}-10-scenes`);
    const beforeScenes = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'run_scene').length`);
    await click('#sceneList [data-run-scene]');
    await waitFor(() => pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'run_scene').length > ${beforeScenes}`));

    await click('#automationNav');
    await waitFor(() => pageEval(cdp, `document.querySelector('#autoForm') !== null`));
    await screenshot(`r${round}-11-automation-form`);
    await pageEval(cdp, `(() => {
      document.querySelector('#autoName').value = '测试定时';
      document.querySelector('#autoTime').value = '08:15';
      document.querySelector('#autoForm').requestSubmit();
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `window.__MOCK_CALLS__.some((item) => item.command === 'save_automation')`));
    await screenshot(`r${round}-12-automation-created`);
    const toggleAutoBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'toggle_automation').length`);
    await pageEval(cdp, `(() => {
      const input = [...document.querySelectorAll('#autoList [data-toggle-auto]')].at(-1);
      if (!input) throw new Error('new automation toggle missing');
      input.click();
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'toggle_automation').length > ${toggleAutoBefore}`,
    ));
    const deleteAutoBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'delete_automation').length`);
    await pageEval(cdp, `(() => {
      const button = [...document.querySelectorAll('#autoList [data-delete-auto]')].at(-1);
      if (!button) throw new Error('new automation delete missing');
      button.click();
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'delete_automation').length > ${deleteAutoBefore}`,
    ));

    await click('#settingsNav');
    await screenshot(`r${round}-13-settings`);
    await click('[data-theme-set="dark"]');
    expect(await pageEval(cdp, `document.body.dataset.theme === 'dark'`), `round ${round}: dark theme failed`);
    await screenshot(`r${round}-14-settings-dark`);
    await click('[data-theme-set="light"]');
    await click('[data-density-set="compact"]');
    expect(await pageEval(cdp, `document.body.dataset.density === 'compact'`), `round ${round}: compact density failed`);
    await screenshot(`r${round}-15-settings-compact`);
    await click('[data-density-set="comfortable"]');

    await pageEval(cdp, `document.querySelector('#btnPalette').click(); true`);
    expect(await pageEval(cdp, `document.querySelector('#palette').classList.contains('open')`), `round ${round}: command palette did not open`);
    await pageEval(cdp, `document.querySelector('#paletteInput').value = '客厅'; document.querySelector('#paletteInput').dispatchEvent(new Event('input')); true`);
    expect(await pageEval(cdp, `document.querySelectorAll('#paletteResults .palette-item').length > 0`), `round ${round}: palette search returned no results`);
    await screenshot(`r${round}-16-command-palette`);
    await pageEval(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

    const pageSelectors = [
      ['overview', '#overviewView'],
      ['camera', '#cameraView'],
      ['scenes', '#sceneView'],
      ['automations', '#automationView'],
      ['devices', '#devicesView'],
      ['settings', '#settingsView'],
    ];
    for (const [width, height] of [[1440, 900], [1180, 800], [980, 680], [720, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = width;
      viewportHeight = height;
      for (const [name, selector] of pageSelectors) {
        await pageEval(cdp, `(() => {
          const nav = ${JSON.stringify(selector)} === '#overviewView' ? '#overviewNav'
            : ${JSON.stringify(selector)} === '#cameraView' ? '#cameraNav'
            : ${JSON.stringify(selector)} === '#sceneView' ? '#sceneNav'
            : ${JSON.stringify(selector)} === '#automationView' ? '#automationNav'
            : ${JSON.stringify(selector)} === '#devicesView' ? '#devicesNav' : '#settingsNav';
          document.querySelector(nav).click();
          return true;
        })()`);
        await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const metrics = await pageEval(cdp, `(() => {
          const page = document.querySelector(${JSON.stringify(selector)});
          const visibleNodes = [...page.querySelectorAll('button, input, select, article, .device-row, .table-row, .scene-card, .auto-row')]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            });
          const clipped = [...page.querySelectorAll('button, input, select')]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0
                && (rect.left < -1 || rect.right > innerWidth + 1);
            })
            .map((node) => node.id || node.className || node.tagName);
          const shellClipped = [...document.querySelectorAll(
            '.titlebar button, .topnav button, .topnav select, .sidebar button, .statusbar button',
          )]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0
                && (rect.left < -1 || rect.right > innerWidth + 1);
            })
            .map((node) => node.id || node.className || node.tagName);
          return {
            title: page.querySelector('.page-title')?.textContent || '',
            visibleNodes: visibleNodes.length,
            overflow: page.scrollWidth > page.clientWidth + 1
              || document.documentElement.scrollWidth > innerWidth + 1,
            clipped,
            shellClipped,
          };
        })()`);
        expect(Boolean(metrics.title), `round ${round}, ui ${width}px: ${name} has no title`);
        expect(metrics.visibleNodes > 0, `round ${round}, ui ${width}px: ${name} has no visible interactive content`);
        expect(metrics.overflow === false, `round ${round}, ui ${width}px: ${name} overflows horizontally`);
        expect(metrics.clipped.length === 0, `round ${round}, ui ${width}px: ${name} clips ${metrics.clipped.join(', ')}`);
        expect(
          metrics.shellClipped.length === 0,
          `round ${round}, ui ${width}px: shell clips ${metrics.shellClipped.join(', ')}`,
        );
        await screenshot(`r${round}-${name}-${width}`);
      }
      await click('#accountButton');
      await waitForSelector('#accountPop.open');
      const accountPopMetrics = await pageEval(cdp, `(() => {
        const pop = document.querySelector('#accountPop');
        const rect = pop.getBoundingClientRect();
        return {
          inside: rect.left >= -1 && rect.right <= innerWidth + 1
            && rect.top >= -1 && rect.bottom <= innerHeight + 1,
          overflow: pop.scrollWidth > pop.clientWidth + 1,
          cards: pop.querySelectorAll('.account-card').length,
        };
      })()`);
      expect(accountPopMetrics.cards >= 2, `round ${round}, ui ${width}px: account pop is empty`);
      expect(accountPopMetrics.inside, `round ${round}, ui ${width}px: account pop is clipped`);
      expect(!accountPopMetrics.overflow, `round ${round}, ui ${width}px: account pop overflows`);
      await screenshot(`r${round}-account-pop-${width}`);
      await click('#accountPopClose');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    viewportWidth = 1440;
    viewportHeight = 900;

    await click('#cameraNav');
    const localBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_start').length`);
    await click('#camLocalButton');
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_start').length > ${localBefore}`,
    ));
    expect(
      await pageEval(cdp, `document.querySelector('#camLocalButton').classList.contains('active')`),
      `round ${round}: local camera mode did not activate`,
    );
    await screenshot(`r${round}-17-camera-local`);

    const remoteBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').length`);
    await click('#camRemoteButton');
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').length > ${remoteBefore}`,
    ));
    await waitFor(() => pageEval(cdp, `document.querySelector('#camPtzOverlay').hidden === false`));
    expect(
      await pageEval(cdp, `Boolean(document.querySelector('#camTimeline .timeline-session'))`),
      `round ${round}: active camera timeline is missing`,
    );
    await screenshot(`r${round}-18-camera-remote`);

    const ptzBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_ptz').length`);
    await pageEval(cdp, `document.querySelector('#camPtzOverlay [data-ptz-dir=\"left\"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_ptz').length > ${ptzBefore}`,
    ));

    await click('#camPause');
    expect(
      await pageEval(cdp, `document.querySelector('#camPause').textContent.includes('继续')`),
      `round ${round}: camera pause did not update its control`,
    );
    await screenshot(`r${round}-19-camera-paused`);
    await click('#camPause');
    expect(
      await pageEval(cdp, `document.querySelector('#camPause').textContent.includes('暂停')`),
      `round ${round}: camera resume did not update its control`,
    );
    await screenshot(`r${round}-20-camera-resumed`);

    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    const accountSwitcher = await pageEval(cdp, `({
      cards: document.querySelectorAll('#accountList .account-card').length,
      active: document.querySelector('#accountList .account-card.active strong')?.textContent,
      hasAdd: Boolean(document.querySelector('#addAccountButton')),
      hasRemove: Boolean(document.querySelector('#removeAccountButton')),
    })`);
    expect(accountSwitcher.cards === 2, `round ${round}: expected 2 saved accounts, got ${accountSwitcher.cards}`);
    expect(accountSwitcher.active === '云栖账号', `round ${round}: wrong active account ${accountSwitcher.active}`);
    expect(accountSwitcher.hasAdd && accountSwitcher.hasRemove, `round ${round}: account actions missing`);
    await screenshot(`r${round}-21-account-switcher`);

    // A delayed response from the old account must never repopulate the new account.
    await pageEval(cdp, `window.__MOCK_DELAY_NEXT__ = { command: 'list_devices', account: 'mock-user', ms: 650 }; window.dispatchEvent(new Event('focus')); true`);
    await pageEval(cdp, `document.querySelector('#accountList [data-account="mock-user-2"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '工作室账号'
        && Boolean(document.querySelector('.device-row[data-did="b-light"]'))`,
    ));
    await new Promise((resolve) => setTimeout(resolve, 750));
    const accountB = await pageEval(cdp, `({
      account: document.querySelector('#accountName')?.textContent,
      home: document.querySelector('#homeSelect')?.selectedOptions[0]?.textContent,
      devices: [...document.querySelectorAll('.device-row')].map((node) => node.dataset.did),
      leaked: Boolean(document.querySelector('.device-row[data-did="light1"]')),
    })`);
    expect(accountB.account === '工作室账号' && accountB.home === '湖畔住宅', `round ${round}: account B did not load its own home`);
    expect(accountB.devices.includes('b-light') && !accountB.leaked, `round ${round}: account A leaked into account B`);
    await screenshot(`r${round}-22-account-b`);

    await click('#accountButton');
    await pageEval(cdp, `document.querySelector('#accountList [data-account="mock-user"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`,
    ));
    expect(
      await pageEval(cdp, `document.querySelectorAll('.device-row').length === 9`),
      `round ${round}: account A did not recover all devices`,
    );
    await screenshot(`r${round}-23-account-a-restored`);

    await pageEval(cdp, `window.__MOCK_DELAY_NEXT__ = { command: 'auth_poll', ms: 900 }; true`);
    await click('#accountButton');
    await click('#addAccountButton');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginTitle')?.textContent === '添加米家账号'`));
    expect(
      await pageEval(cdp, `document.querySelector('#loginBack')?.hidden === false`),
      `round ${round}: add-account back action is hidden`,
    );
    await screenshot(`r${round}-24-add-account`);
    await click('#loginBack');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(
      await pageEval(cdp, `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`),
      `round ${round}: cancelled add-account changed the active account`,
    );
    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    expect(
      await pageEval(cdp, `document.querySelectorAll('#accountList .account-card').length === 2`),
      `round ${round}: cancelled add-account created an account record`,
    );
    await screenshot(`r${round}-25-add-account-cancelled`);
    await click('#accountPopClose');

    await pageEval(cdp, `window.__MOCK_NEXT_LOGIN__ = 'mock-user-3'; window.__MOCK_DELAY_NEXT__ = { command: 'auth_poll', ms: 1200 }; true`);
    await click('#accountButton');
    await click('#addAccountButton');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginTitle')?.textContent === '添加米家账号'`));
    await screenshot(`r${round}-26-add-account-pending`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`));
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '创意账号'
        && Boolean(document.querySelector('.device-row[data-did="c-light"]'))`,
    ));
    const accountC = await pageEval(cdp, `({
      device: document.querySelector('.device-row')?.dataset.did,
      leaked: Boolean(document.querySelector('.device-row[data-did="light1"]')),
    })`);
    expect(accountC.device === 'c-light' && !accountC.leaked, `round ${round}: added account reused old device data`);
    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    expect(
      await pageEval(cdp, `document.querySelectorAll('#accountList .account-card').length === 3`),
      `round ${round}: added account is missing from the account switcher`,
    );
    expect(
      await pageEval(cdp, `document.querySelector('#accountState')?.textContent.includes('3 个账号')`),
      `round ${round}: account count did not refresh after adding`,
    );
    await screenshot(`r${round}-27-account-c-added`);
    await click('#accountPopClose');

    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`,
    ));
    expect(
      await pageEval(cdp, `!document.querySelector('.device-row[data-did="c-light"]')`),
      `round ${round}: removed account data remained visible`,
    );
    await screenshot(`r${round}-28-account-fallback`);

    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '工作室账号'
        && Boolean(document.querySelector('.device-row[data-did="b-light"]'))`,
    ));
    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(cdp, `!document.querySelector('#loginLayer').classList.contains('hide')`));
    await new Promise((resolve) => setTimeout(resolve, 520));
    await screenshot(`r${round}-29-login`);
    for (const [width, height] of [[1440, 900], [1180, 800], [980, 680], [720, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = width;
      viewportHeight = height;
      await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const loginMetrics = await pageEval(cdp, `(() => {
        const layer = document.querySelector('#loginLayer');
        const card = layer.querySelector('.login-card');
        const overflow = document.documentElement.scrollWidth > innerWidth + 1
          || layer.scrollWidth > layer.clientWidth + 1;
        const cardRect = card.getBoundingClientRect();
        return {
          visible: getComputedStyle(layer).visibility !== 'hidden',
          overflow,
          cardInside: cardRect.left >= -1 && cardRect.right <= innerWidth + 1,
        };
      })()`);
      expect(loginMetrics.visible, `round ${round}, login ${width}px: layer is hidden`);
      expect(!loginMetrics.overflow, `round ${round}, login ${width}px: horizontal overflow`);
      expect(loginMetrics.cardInside, `round ${round}, login ${width}px: login card is clipped`);
      await screenshot(`r${round}-login-${width}`);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    viewportWidth = 1440;
    viewportHeight = 900;
    await pageEval(cdp, `window.__MOCK_NEXT_LOGIN__ = 'mock-user'; true`);
    await click('#startAuth');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`));
    expect(
      await pageEval(cdp, `document.querySelector('#accountName').textContent === '云栖账号'`),
      `round ${round}: account did not reload after login`,
    );
    await pageEval(cdp, `(() => {
      const select = document.querySelector('#homeSelect');
      select.value = 'home2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#homeSelect').value === 'home2'
        && document.querySelector('#windowTitle').textContent.includes('工作室')`,
    ));
    await pageEval(cdp, `(() => {
      const select = document.querySelector('#homeSelect');
      select.value = 'home1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#homeSelect').value === 'home1'
        && document.querySelector('#windowTitle').textContent.includes('云栖公寓')`,
    ));
  }

  const heap = await pageEval(cdp, `performance.memory ? performance.memory.usedJSHeapSize : 0`);
  const dom = await pageEval(cdp, `document.querySelectorAll('*').length`);
  const maxTiming = timings.length ? Math.max(...timings) : 0;
  const interactionBudget = screenshots ? 600 : 350;
  expect(
    maxTiming < interactionBudget,
    `performance: max interaction wait ${maxTiming.toFixed(1)}ms (budget ${interactionBudget}ms)`,
  );
  expect(runtimeErrors.length === 0, `runtime errors: ${runtimeErrors.slice(0, 5).join(' | ')}`);
  if (screenshots) {
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      rounds,
      checks,
      screenshots: screenshotFiles,
      failures,
    }, null, 2));
  }
  console.log(JSON.stringify({
    ok: failures.length === 0,
    rounds,
    checks,
    screenshots: screenshotFiles.length,
    screenshotDir: screenshots ? outputDir : null,
    maxInteractionMs: Number(maxTiming.toFixed(2)),
    domNodes: dom,
    heapMB: Number((heap / 1048576).toFixed(2)),
    runtimeErrors,
    ignoredResourceErrors,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  try { cdp?.ws?.close(); } catch {}
  try { browser?.kill('SIGTERM'); } catch {}
  try { server.close(); } catch {}
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
