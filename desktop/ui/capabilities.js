(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROPERTY_LABELS = {
    on: '开关', brightness: '亮度', 'color-temperature': '色温', mode: '模式',
    'fan-level': '风速', 'target-temperature': '目标温度', temperature: '温度',
    'relative-humidity': '湿度', 'battery-level': '电量', 'night-vision': '夜视',
    'motion-detection': '移动侦测', 'motion-record': '录像', 'video-quality': '画质',
    'wide-dynamic-range': '宽动态', 'full-color-night-vision': '全彩夜视',
    'time-watermark': '时间水印', 'status-led': '状态灯', 'alarm-interval': '报警间隔',
    volume: '音量', mute: '静音', 'motor-control': '云台', 'physical-controls-locked': '按键锁',
    'charging-state': '充电状态', 'power-consumption': '功率', 'electric-current': '电流',
    voltage: '电压', 'filter-life-level': '滤芯寿命', 'water-level': '水位',
  };

  const SERVICE_GROUPS = {
    switch: '开关', light: '灯光', fan: '风扇', 'air-conditioner': '空调',
    battery: '电池', 'temperature-humidity-sensor': '温湿度', environment: '环境',
    'motion-sensor': '传感器', 'contact-sensor': '传感器', 'camera-control': '摄像头设置',
    camera: '摄像头设置', television: '电视', speaker: '声音', 'door-lock': '门锁',
  };

  function kindSuffix(kind) {
    const text = String(kind || '');
    const parts = text.split(':').filter(Boolean);
    const marker = parts.findIndex((part) =>
      ['device', 'service', 'property', 'action'].includes(part));
    return (marker >= 0 ? parts[marker + 1] : parts.pop()) || text;
  }

  function propertyAccessible(property) {
    return !property.access?.length
      || property.access.includes('read')
      || property.access.includes('notify');
  }

  function propertyWritable(property) {
    return property.access?.includes('write') || false;
  }

  function propertyValueList(property) {
    return property.value_list || property['value-list'];
  }

  function propertyValueRange(property) {
    const raw = property.value_range || property['value-range'];
    if (Array.isArray(raw)) {
      return raw.length >= 2
        ? { min: raw[0], max: raw[1], step: raw[2] ?? 1 }
        : undefined;
    }
    return raw;
  }

  function propertyLabel(service, property) {
    const suffix = kindSuffix(property.kind || property.type);
    return PROPERTY_LABELS[suffix] || property.description || service.description || '属性';
  }

  function propertyUnit(service, property) {
    const suffix = kindSuffix(property.kind || property.type);
    if (property.unit === 'percentage') return '%';
    if (property.unit === 'kelvin') return 'K';
    if (property.unit === 'celsius') return '°C';
    if (property.unit) return property.unit;
    if (suffix === 'temperature' || suffix === 'target-temperature') return '°C';
    if (suffix === 'relative-humidity' || suffix === 'battery-level' || suffix === 'brightness') return '%';
    if (suffix === 'color-temperature') return 'K';
    if (suffix === 'alarm-interval') return '秒';
    if (suffix === 'voltage') return 'V';
    if (suffix === 'electric-current') return 'mA';
    if (suffix === 'power-consumption') return 'W';
    return '';
  }

  function serviceGroup(service) {
    return SERVICE_GROUPS[kindSuffix(service.kind || service.type)] || service.description || '控制';
  }

  function profileFromSpec(spec) {
    const metrics = [];
    const controls = [];
    const actions = [];
    const seen = new Set();
    for (const service of spec.services || []) {
      const serviceName = kindSuffix(service.kind || service.type);
      if (serviceName === 'device-information') continue;
      const group = serviceGroup(service);
      for (const property of service.properties || []) {
        const key = `${service.iid}:${property.iid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const suffix = kindSuffix(property.kind || property.type);
        const label = propertyLabel(service, property);
        const unit = propertyUnit(service, property);
        const digits = unit === '°C' ? 1 : 0;
        const readable = propertyAccessible(property);
        const writable = propertyWritable(property);
        const options = propertyValueList(property)?.map((item) => [
          item.value,
          item.description || String(item.value),
        ]);
        if (writable && options?.length) {
          controls.push({
            type: 'segments', siid: service.iid, piid: property.iid, label,
            options, group, primary: suffix === 'on', readable,
          });
          continue;
        }
        if (writable && property.format === 'bool') {
          controls.push({
            type: 'toggle', siid: service.iid, piid: property.iid, label,
            group, primary: suffix === 'on', readable,
          });
          continue;
        }
        if (writable && propertyValueRange(property)) {
          const range = propertyValueRange(property);
          controls.push({
            type: 'range', siid: service.iid, piid: property.iid, label,
            min: range.min, max: range.max, step: range.step || 1,
            suffix: unit, group, readable,
          });
          continue;
        }
        if (readable) {
          metrics.push({
            siid: service.iid, piid: property.iid, label, unit, digits, options,
            secondary: serviceName === 'battery',
          });
        }
      }
      for (const action of service.actions || []) {
        if (action.inputs?.length) continue;
        actions.push({
          siid: service.iid,
          aiid: action.iid,
          label: action.description || kindSuffix(action.kind || action.type) || '执行动作',
        });
      }
    }
    return {
      metrics,
      controls,
      actions,
      note: metrics.length || controls.length || actions.length ? '' : '设备规格中没有可用的属性或动作。',
    };
  }

  return {
    PROPERTY_LABELS,
    SERVICE_GROUPS,
    kindSuffix,
    propertyAccessible,
    propertyWritable,
    propertyLabel,
    propertyUnit,
    serviceGroup,
    profileFromSpec,
  };
});
