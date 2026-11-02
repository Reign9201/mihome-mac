(function () {
  const params = new URLSearchParams(location.search);
  const loginOnly = params.get("login") === "1";

  const home = {
    id: "demo-home",
    name: "云栖公寓",
    rooms: [
      { id: "living", name: "客厅" },
      { id: "bedroom", name: "主卧" },
      { id: "study", name: "书房" },
      { id: "kitchen", name: "厨房" },
      { id: "entry", name: "玄关" },
      { id: "balcony", name: "阳台" },
    ],
  };

  const specifications = {
    "demo.light": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:light:demo:1",
          properties: [
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:brightness:demo:1",
              format: "uint8",
              access: ["read", "write", "notify"],
              "value-range": [1, 100, 1],
            },
            {
              iid: 3,
              kind: "urn:miot-spec-v2:property:color-temperature:demo:1",
              format: "uint16",
              access: ["read", "write", "notify"],
              "value-range": [2700, 6500, 1],
            },
          ],
        },
      ],
    },
    "demo.climate": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:temperature-humidity-sensor:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:temperature:demo:1",
              format: "float",
              access: ["read", "notify"],
              unit: "celsius",
            },
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:relative-humidity:demo:1",
              format: "uint8",
              access: ["read", "notify"],
              unit: "percentage",
            },
            {
              iid: 3,
              kind: "urn:miot-spec-v2:property:battery-level:demo:1",
              format: "uint8",
              access: ["read", "notify"],
              unit: "percentage",
            },
          ],
        },
      ],
    },
    "demo.air-conditioner": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:air-conditioner:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:target-temperature:demo:1",
              format: "float",
              access: ["read", "write", "notify"],
              unit: "celsius",
              "value-range": [16, 30, 1],
            },
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:mode:demo:1",
              format: "uint8",
              access: ["read", "write", "notify"],
              "value-list": [
                { value: 0, description: "auto" },
                { value: 1, description: "cool" },
                { value: 2, description: "dry" },
                { value: 3, description: "heat" },
                { value: 4, description: "fan" },
              ],
            },
            {
              iid: 3,
              kind: "urn:miot-spec-v2:property:fan-level:demo:1",
              format: "uint8",
              access: ["read", "write", "notify"],
              "value-list": [
                { value: 0, description: "auto" },
                { value: 1, description: "low" },
                { value: 2, description: "medium" },
                { value: 3, description: "high" },
              ],
            },
          ],
        },
      ],
    },
    "demo.camera": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:camera-control:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:motion-detection:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:night-vision:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
            {
              iid: 3,
              kind: "urn:miot-spec-v2:property:video-quality:demo:1",
              format: "uint8",
              access: ["read", "write", "notify"],
              "value-list": [
                { value: 0, description: "auto" },
                { value: 1, description: "high" },
                { value: 2, description: "normal" },
              ],
            },
          ],
        },
      ],
    },
    "demo.plug": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:environment:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:power-consumption:demo:1",
              format: "float",
              access: ["read", "notify"],
              unit: "watt",
            },
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:voltage:demo:1",
              format: "float",
              access: ["read", "notify"],
              unit: "volt",
            },
          ],
        },
      ],
    },
    "demo.humidifier": {
      services: [
        {
          iid: 2,
          kind: "urn:miot-spec-v2:service:switch:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:on:demo:1",
              format: "bool",
              access: ["read", "write", "notify"],
            },
          ],
        },
        {
          iid: 3,
          kind: "urn:miot-spec-v2:service:environment:demo:1",
          properties: [
            {
              iid: 1,
              kind: "urn:miot-spec-v2:property:target-humidity:demo:1",
              format: "uint8",
              access: ["read", "write", "notify"],
              unit: "percentage",
              "value-range": [30, 80, 1],
            },
            {
              iid: 2,
              kind: "urn:miot-spec-v2:property:water-level:demo:1",
              format: "uint8",
              access: ["read", "notify"],
              unit: "percentage",
            },
          ],
        },
      ],
    },
  };

  const valueMap = new Map();
  const keyOf = (did, siid, piid) => `${did}:${siid}:${piid}`;
  const setValue = (did, siid, piid, value) => valueMap.set(keyOf(did, siid, piid), value);

  const roomIds = {
    客厅: "living",
    主卧: "bedroom",
    书房: "study",
    厨房: "kitchen",
    玄关: "entry",
    阳台: "balcony",
  };

  function device(did, name, roomName, model, specType, online = true) {
    return {
      did,
      name,
      model,
      online,
      room_id: roomIds[roomName] || "",
      room_name: roomName,
      spec_type: specType,
    };
  }

  const devices = [
    device("demo-light", "客厅主灯", "客厅", "yeelink.light.lamp4", "demo.light"),
    device("demo-ac", "客厅空调", "客厅", "xiaomi.aircondition.mc5", "demo.air-conditioner"),
    device("demo-sensor", "温湿度计", "客厅", "lumi.sensor_ht.htv1", "demo.climate"),
    device("demo-cam3", "小米智能摄像机3 云台版", "客厅", "chuangmi.camera.069a01", "demo.camera"),
    device("demo-cam2", "小米智能摄像机2 云台版", "客厅", "chuangmi.camera.039a01", "demo.camera"),
    device("demo-curtain", "客厅窗帘", "客厅", "lumi.curtain.hagl05", "demo.light"),
    device("demo-purifier", "空气净化器", "客厅", "zhimi.airpurifier.va1", "demo.plug"),
    device("demo-bedlight", "主卧灯带", "主卧", "yeelink.light.strip2", "demo.light", false),
    device("demo-humidifier", "主卧加湿器", "主卧", "zhimi.humidifier.ca4", "demo.humidifier"),
    device("demo-desk", "书房台灯", "书房", "yeelink.light.lamp4", "demo.light"),
    device("demo-plug", "书房插座", "书房", "lumi.plug.ugv1", "demo.plug"),
    device("demo-kitchen", "厨房灯", "厨房", "yeelink.light.ceiling3", "demo.light"),
    device("demo-lock", "智能门锁", "玄关", "lumi.lock.aq1", "demo.climate"),
    device("demo-balcony", "阳台摄像头", "阳台", "chuangmi.camera.ipc019", "demo.camera"),
  ];

  setValue("demo-light", 2, 1, true);
  setValue("demo-light", 3, 2, 78);
  setValue("demo-light", 3, 3, 4200);
  setValue("demo-ac", 2, 1, true);
  setValue("demo-ac", 3, 1, 24);
  setValue("demo-ac", 3, 2, 1);
  setValue("demo-ac", 3, 3, 1);
  setValue("demo-sensor", 2, 1, true);
  setValue("demo-sensor", 3, 1, 24.6);
  setValue("demo-sensor", 3, 2, 58);
  setValue("demo-sensor", 3, 3, 87);
  for (const did of ["demo-cam3", "demo-cam2", "demo-balcony"]) {
    setValue(did, 2, 1, true);
    setValue(did, 3, 1, true);
    setValue(did, 3, 2, true);
    setValue(did, 3, 3, 1);
  }
  setValue("demo-curtain", 2, 1, true);
  setValue("demo-curtain", 3, 2, 60);
  setValue("demo-purifier", 2, 1, true);
  setValue("demo-purifier", 3, 1, 12.4);
  setValue("demo-purifier", 3, 2, 220);
  setValue("demo-bedlight", 2, 1, false);
  setValue("demo-bedlight", 3, 2, 30);
  setValue("demo-bedlight", 3, 3, 3000);
  setValue("demo-humidifier", 2, 1, true);
  setValue("demo-humidifier", 3, 1, 55);
  setValue("demo-humidifier", 3, 2, 62);
  setValue("demo-desk", 2, 1, true);
  setValue("demo-desk", 3, 2, 62);
  setValue("demo-desk", 3, 3, 4000);
  setValue("demo-plug", 2, 1, true);
  setValue("demo-plug", 3, 1, 46.2);
  setValue("demo-plug", 3, 2, 220.1);
  setValue("demo-kitchen", 2, 1, false);
  setValue("demo-kitchen", 3, 2, 100);
  setValue("demo-kitchen", 3, 3, 5000);
  setValue("demo-lock", 2, 1, true);
  setValue("demo-lock", 3, 1, 23.2);
  setValue("demo-lock", 3, 2, 58);
  setValue("demo-lock", 3, 3, 95);

  const scenes = [
    { id: "scene-home", name: "回家" },
    { id: "scene-away", name: "离家" },
    { id: "scene-movie", name: "观影" },
    { id: "scene-night", name: "晚安" },
  ];

  const automations = [
    { id: "auto-1", time: "07:30", name: "拉开客厅窗帘", days: [1, 2, 3, 4, 5], scene_id: "scene-home", enabled: true },
    { id: "auto-2", time: "08:00", name: "关闭客厅空调", days: [1, 2, 3, 4, 5, 6, 7], scene_id: "scene-away", enabled: true },
    { id: "auto-3", time: "19:00", name: "打开客厅主灯", days: [1, 2, 3, 4, 5, 6, 7], scene_id: "scene-home", enabled: true },
    { id: "auto-4", time: "23:30", name: "全屋熄灯", days: [1, 2, 3, 4, 5, 6, 7], scene_id: "scene-night", enabled: true },
    { id: "auto-5", time: "02:00", name: "夜间清扫", days: [2, 4, 6], scene_id: "scene-away", enabled: false },
  ];

  const cameras = devices
    .filter((item) => item.spec_type === "demo.camera")
    .map((item, index) => ({
      ...item,
      ip: `192.168.31.${150 + index}`,
    }));

  function demoQrSvg() {
    const cells = [];
    for (let y = 0; y < 25; y += 1) {
      for (let x = 0; x < 25; x += 1) {
        const finder = (
          (x < 7 && y < 7)
          || (x > 17 && y < 7)
          || (x < 7 && y > 17)
        );
        const insideFinder = finder
          && !(x >= 1 && x <= 5 && y >= 1 && y <= 5)
          && !(x >= 19 && x <= 23 && y >= 1 && y <= 5)
          && !(x >= 1 && x <= 5 && y >= 19 && y <= 23);
        const on = insideFinder || (!finder && ((x * 7 + y * 11 + x * y) % 5 < 2));
        if (on) cells.push(`<rect x="${x * 8}" y="${y * 8}" width="8" height="8" rx="1"/>`);
      }
    }
    return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="200" fill="#fff"/>
      <g fill="#171411">${cells.join("")}</g>
      <rect x="77" y="77" width="46" height="46" rx="9" fill="#fff"/>
      <path d="M88 102 100 91l12 11v11H88z" fill="#c34d2b"/>
      <text x="100" y="194" text-anchor="middle" font-size="9" fill="#8b8d87">OFFLINE DEMO</text>
    </svg>`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function invoke(command, args = {}) {
    switch (command) {
      case "ui_ready":
      case "log_frontend":
      case "log_export":
        return undefined;
      case "auth_resume":
        return loginOnly ? null : "demo-user";
      case "auth_start":
        return { qr_svg: demoQrSvg() };
      case "auth_poll":
        await wait(200);
        return { status: "waiting" };
      case "auth_logout":
        return undefined;
      case "list_homes":
        return [home];
      case "list_devices":
        return devices;
      case "get_device_specs":
        return {
          specs: Object.fromEntries(
            (args.specTypes || [])
              .filter((type) => specifications[type])
              .map((type) => [type, specifications[type]]),
          ),
          errors: (args.specTypes || [])
            .filter((type) => !specifications[type])
            .map((type) => `${type}: demo spec unavailable`),
        };
      case "get_properties":
        return (args.requests || []).map((request) => ({
          did: request.did,
          siid: request.siid,
          piid: request.piid,
          code: 0,
          value: valueMap.get(keyOf(request.did, request.siid, request.piid)),
        }));
      case "set_property":
        setValue(args.did, args.siid, args.piid, args.value);
        return [{ code: 0 }];
      case "call_action":
        return [{ code: 0 }];
      case "list_scenes":
        return scenes;
      case "run_scene":
        return undefined;
      case "list_automations":
        return automations;
      case "save_automation":
        return automations;
      case "toggle_automation":
        return automations;
      case "delete_automation":
        return automations;
      case "list_cameras":
        return cameras;
      case "camera_diagnostics":
        return [];
      case "camera_remote_start":
        throw new Error("离线演示不连接真实摄像头");
      case "camera_remote_stop":
      case "camera_stop":
      case "camera_remote_ptz":
        return undefined;
      default:
        return undefined;
    }
  }

  window.__MIHOME_TAURI__ = Object.freeze({ invoke });
  window.__MIHOME_DEMO__ = Object.freeze({
    home,
    devices,
    scenes,
    automations,
    cameras,
    showDevices: () => document.querySelector("#devicesNav")?.click(),
    showScenes: () => document.querySelector("#sceneNav")?.click(),
    showAutomations: () => document.querySelector("#automationNav")?.click(),
    showCameras: () => document.querySelector("#cameraNav")?.click(),
    selectDevice: (did) => document.querySelector(`.device-card[data-did="${did}"]`)?.click(),
  });
})();
