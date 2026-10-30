// 设备类型图标：24×24 线性 SVG，统一 1.55 描边。
// 设备型号千差万别，这里按“看得见的形态”归类，不按品牌归类。
const MI_ICON_ICONS = {
  light: '<path d="M9.2 15.3c0-1.5-.8-2.6-1.6-3.5a5.8 5.8 0 1 1 8.8 0c-.8.9-1.6 2-1.6 3.5"/><path d="M9.2 18.2h5.6M10.2 21h3.6"/><path d="M12 4.2v1.3M6.4 6.8l.9.9M17.6 6.8l-.9.9"/>',
  'ceiling-light': '<path d="M3 4h18"/><path d="M6.2 4c.5 4.4 2.7 6.5 5.8 6.5s5.3-2.1 5.8-6.5"/><path d="M8.6 10.5h6.8"/><path d="M12 13v3"/><path d="M9.4 19.5h5.2"/>',
  'pendant-light': '<path d="M3 4h18"/><path d="M12 4v7"/><path d="M7.2 11h9.6l-2 6H9.2z"/><circle cx="12" cy="19.6" r="1.5"/>',
  'desk-lamp': '<path d="M4 20h9"/><path d="M8.5 20v-6.2"/><path d="M8.5 13.8 14 7"/><path d="M11.8 4.2h6.4l1.8 5.2h-9.9z"/><path d="M8 17h4"/>',
  'wall-light': '<path d="M4 3v18"/><path d="M8 10h4.2v7H8z"/><path d="M8 8.5c0-2.4 1.6-3.5 3.1-4 1.5.5 3 1.6 3 4"/><path d="M14.8 11.5 18 9M14.8 14h4M14.8 16.5 18 19"/>',
  'floor-lamp': '<path d="M5 21h9"/><path d="M9.5 21v-9"/><path d="M6 12h7l-1.5-6h-4z"/><path d="M9.5 3v3"/>',
  'fan-light': '<path d="M12 3v4"/><circle cx="12" cy="13.2" r="2.7"/><path d="M12 10.5c-1.2-3.7-4-3.6-4.5-1.1M14.2 11.8c3.8-1.7 5.4.8 3.8 3M10.6 15c-2.5 3.3-5.4 2.2-5.2-.8M14.7 14.8c3.5 2.3 2.5 5.2-.5 5.1"/><path d="M9.2 16.8h5.6"/>',
  'light-strip': '<path d="M5 7h8a3 3 0 0 1 0 6H9"/><path d="M5 7v6"/><path d="M6.5 10h2"/><path d="M9 16h9a2 2 0 0 0 2-2v-2"/><path d="M18 12v4"/>',
  'spot-light': '<path d="M3 5h18"/><circle cx="12" cy="8.5" r="4"/><path d="M8 12.8 5 20M16 12.8 19 20M9.5 12.8 9 20M14.5 12.8 15 20"/>',
  'mirror-light': '<ellipse cx="12" cy="11" rx="5.4" ry="7.4"/><path d="M12 3.6v14.8"/><circle cx="4" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="17" r="1.1" fill="currentColor" stroke="none"/><circle cx="20" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="20" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
  'night-light': '<path d="M7 5h10v12a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z"/><path d="M9 5V3h6v2"/><path d="M13.5 10.2a3 3 0 1 0 2.8 4.1 3.5 3.5 0 0 1-2.8-4.1z"/>',
  'ambient-light': '<path d="M5 8.5 12 4l7 4.5v7L12 20l-7-4.5z"/><path d="M5 8.5 12 13l7-4.5M12 13v7"/><path d="M3 6.5 2 5M21 6.5 22 5"/>',
  'outdoor-light': '<path d="M3 3v18"/><path d="M8 6h8l1 4H7z"/><path d="M9 10h6v8H9z"/><path d="M8 18h8"/><path d="M12 4V2"/>',

  'ac-wall': '<rect x="3" y="5" width="18" height="7" rx="2"/><path d="M6.2 9h11.6M6 15.2c1.2 1.4 2.4 1.4 3.6 0M10.8 15.2c1.2 1.4 2.4 1.4 3.6 0M15.6 15.2c1.2 1.4 2.4 1.4 3.6 0"/><path d="M7 18.4c1 1 2 1 3 0M12 18.4c1 1 2 1 3 0M17 18.4c1 1 2 1 3 0"/>',
  'ac-floor': '<rect x="6" y="3" width="12" height="18" rx="3"/><path d="M9 6h6M9 9h6"/><path d="M10 14c1 1.2 2 1.2 3 0M14 14c1 1.2 2 1.2 3 0"/><path d="M9 18h6"/>',
  'ac-central': '<rect x="3" y="4" width="18" height="8" rx="2"/><path d="M7 8h10M6 12v4M18 12v4M9 16h6"/><path d="M8 20h8"/>',
  fan: '<circle cx="12" cy="9" r="4.5"/><circle cx="12" cy="9" r="1"/><path d="M12 13.5V20M8 21h8M9 20l3-3 3 3"/>',
  'tower-fan': '<rect x="8" y="3" width="8" height="15" rx="4"/><path d="M10 6h4M10 9h4M10 12h4M10 15h4"/><path d="M10 18v3M14 18v3"/>',
  'ceiling-fan': '<path d="M12 3v4"/><circle cx="12" cy="9" r="1.6"/><path d="M12 10.5c-4-2.5-7.5-.5-5.7 2.4M13.5 9c4.5-.5 5.5 3 1.8 4.2M11 10.5c-2 4.5 1 6.5 3.7 3.8M10.5 9C6 8.5 5 5 8.7 3.8"/><path d="M9 20h6"/>',
  'air-purifier': '<rect x="6.1" y="3.5" width="11.8" height="17" rx="3"/><circle cx="12" cy="9" r="2.4"/><path d="M9 14.8h6M9 17.2h3.8"/>',
  humidifier: '<path d="M8.2 4.3h7.6l1.1 15.2H7.1z"/><path d="M9.3 11.7h5.4M10.4 3.2V2M13.6 3.2V2"/><path d="M12 7c.8 1 1.4 1.7 1.4 2.6a1.4 1.4 0 0 1-2.8 0C10.6 8.7 11.2 8 12 7z"/>',
  dehumidifier: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M7 9h10M7 16h5"/><path d="M15 13c.9 1.2 1.5 2 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.8.6-1.6 1.5-2.8z"/>',
  heater: '<rect x="4" y="10" width="16" height="8" rx="2"/><path d="M7 14h10M7 17h10"/><path d="M7 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M17 7c0-1.5 1-2 1-3.5"/>',
  'fresh-air': '<rect x="3" y="4" width="18" height="7" rx="2"/><path d="M7 8h10"/><path d="M8 14v3a3 3 0 0 0 3 3h2M16 14v5"/><path d="m14 16 2-2 2 2"/>',
  'air-monitor': '<rect x="4" y="3" width="16" height="18" rx="3"/><rect x="7" y="6" width="10" height="6" rx="1"/><path d="M9 9h2M13 9h2"/><path d="M8 16c1.5-2 3-2 4.5 0M13 16c1.5-2 3-2 4.5 0"/>',
  'temp-humidity': '<path d="M9 4v11.2a3 3 0 1 0 4 0V4a2 2 0 0 0-4 0z"/><circle cx="11" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><path d="M16 9c1 1.3 1.7 2.3 1.7 3.2a1.7 1.7 0 0 1-3.4 0C14.3 11.3 15 10.3 16 9z"/>',

  plug: '<path d="M9 3.2v5M15 3.2v5"/><path d="M6.6 8.2h10.8v2.4a5.4 5.4 0 0 1-10.8 0z"/><path d="M12 16.2v3a2 2 0 0 0 2 2h2"/>',
  'power-strip': '<rect x="3" y="8" width="18" height="8" rx="3"/><path d="M7 12h2M11 12h2M15 12h2"/><path d="M6 16v3M18 16v3"/>',
  'switch-1': '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8 8h8"/><path d="M12 8v8"/><circle cx="12" cy="18" r=".8" fill="currentColor" stroke="none"/>',
  'switch-2': '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M12 3.5v17"/><path d="M8 8h2M14 8h2M8 12h2M14 12h2"/>',
  'switch-3': '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 3.5v17M15.5 3.5v17"/><path d="M6 8h1.5M10.2 8h1.5M16.8 8h1.2"/>',
  breaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 10h6"/><rect x="10" y="13" width="4" height="4" rx="1"/>',
  'universal-remote': '<rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="7" r="1.4"/><circle cx="9.5" cy="12" r="1"/><circle cx="14.5" cy="12" r="1"/><circle cx="9.5" cy="16" r="1"/><circle cx="14.5" cy="16" r="1"/>',

  'camera-fixed': '<rect x="3" y="7" width="12.4" height="8.4" rx="2.2"/><path d="M15.4 10.1 20 7.8v8.4l-4.6-2.3"/><circle cx="9.2" cy="11.2" r="2.2"/><path d="M6.2 19h7.6M8.2 15.4V19"/>',
  'camera-ptz': '<rect x="4" y="5" width="16" height="10" rx="3"/><circle cx="12" cy="10" r="2.4"/><path d="M9 15v2.5M15 15v2.5"/><path d="M7 20h10l-1.5-3.5M17 20l-1.5-3.5"/>',
  'video-doorbell': '<rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="7" r="2.2"/><path d="M9.5 12h5M10 15h4"/><path d="M10 19h4"/>',
  peephole: '<rect x="3" y="3" width="12" height="18" rx="1"/><circle cx="9" cy="10" r="2.2"/><path d="M9 12.2V16"/><path d="M18 8c1.6 0 3 1.4 3 3s-1.4 3-3 3"/>',
  'door-lock': '<rect x="4.5" y="10" width="15" height="10.2" rx="2.2"/><path d="M8 10V7.8a4 4 0 0 1 8 0V10"/><circle cx="12" cy="15" r="1.1" fill="currentColor" stroke="none"/><path d="M12 16v1.8"/>',
  gateway: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 13h3M8 16h6"/><path d="M12 9V5M9 5h6"/><path d="M17 6c1 .8 1.6 1.8 1.6 3M19 4c1.4 1.1 2.2 2.6 2.2 4.2"/>',
  alarm: '<path d="M7 17h10l1-8a6 6 0 0 0-12 0z"/><path d="M5 20h14M9 17v3M15 17v3"/><path d="M4 5 2.5 4M20 5l1.5-1M12 2v2"/>',
  'smoke-sensor': '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M7 8c1-1 2-1.5 3-1.5M17 8c-1-1-2-1.5-3-1.5M7 16c1 1 2 1.5 3 1.5M17 16c-1 1-2 1.5-3 1.5"/>',
  'gas-sensor': '<path d="M12 3c1.5 3 4.5 4.2 4.5 8a4.5 4.5 0 0 1-9 0c0-2 1-3 2-4 .3 1.4 1 2 2 2.5C11.5 7.5 11 5.5 12 3z"/><path d="M5 20h14"/>',
  'water-leak': '<path d="M12 3c3 4 5 6.3 5 9a5 5 0 0 1-10 0c0-2.7 2-5 5-9z"/><path d="M4 21c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 2.5 1 2.5 1"/>',
  'door-sensor': '<rect x="3" y="6" width="7" height="12" rx="1.5"/><rect x="14" y="6" width="7" height="12" rx="1.5"/><path d="M10.5 9h3M10.5 15h3"/><circle cx="6.5" cy="12" r=".8" fill="currentColor" stroke="none"/>',
  'motion-sensor': '<path d="M6 17a6 6 0 0 1 12 0"/><path d="M4 20h16"/><circle cx="12" cy="14" r="1.2"/><path d="M4 7c1.5 1 2.5 2 3 3M20 7c-1.5 1-2.5 2-3 3M12 3v3"/>',
  'light-sensor': '<circle cx="12" cy="10" r="3.5"/><path d="M12 3v2M12 15v2M5 10H3M21 10h-2M7 5 5.5 3.5M17 5l1.5-1.5M7 15l-1.5 1.5M17 15l1.5 1.5"/><path d="M8 20h8"/>',
  'emergency-button': '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 9v4M12 15.5v.5"/>',

  'robot-vacuum': '<circle cx="12" cy="12" r="8.5"/><path d="M5 15h10a3 3 0 0 0 3-3"/><circle cx="12" cy="12" r="3"/><circle cx="17" cy="7" r="1" fill="currentColor" stroke="none"/>',
  'stick-vacuum': '<path d="M14 3h4v4h-2l-2 4"/><path d="M14 11 9 19"/><path d="M6 21h6l-1.5-4h-3z"/><path d="M16 7h3"/>',
  washer: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><circle cx="12" cy="14" r="4"/><path d="M7 6h3M15 6h2"/><path d="M8 14c1.3-1.4 2.7-1.4 4 0s2.7 1.4 4 0"/>',
  dryer: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 10c1 .8 2 .8 3 0s2-.8 3 0M9 13c1 .8 2 .8 3 0s2-.8 3 0"/>',
  'drying-rack': '<path d="M4 5h16M6 5v15M18 5v15"/><path d="M6 9h12"/><path d="M8 9v4c0 1 1 1.5 2 1.5s2-.5 2-1.5V9M14 9v5c0 1 1 1.5 2 1.5"/>',

  fridge: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M5 10h14M9 5v3M9 12v3"/><path d="M16 5v2"/>',
  'rice-cooker': '<path d="M5 9h14l-1 10H6z"/><path d="M4 9h16M8 6c0-1.5 1-2 4-2s4 .5 4 2"/><path d="M9 12v4M15 12v4"/>',
  microwave: '<rect x="3" y="6" width="18" height="12" rx="2"/><rect x="6" y="9" width="9" height="6" rx="1"/><path d="M18 9v1M18 12v1M18 15v1"/>',
  oven: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 8h16M8 5h2M14 5h2"/><rect x="7" y="11" width="10" height="7" rx="1"/><path d="M9 14h6"/>',
  'air-fryer': '<path d="M7 4h10l1 12a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/><path d="M6 8h12M9 16h6"/><path d="M9 4v3M15 4v3"/>',
  dishwasher: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 8h16M8 5h8"/><path d="M7 12h10M7 15h10M7 18h10"/><path d="M9 12v6M15 12v6"/>',
  'water-purifier': '<rect x="6" y="10" width="12" height="11" rx="2"/><path d="M9 14h6M9 17h4"/><path d="M12 10V6a3 3 0 0 1 3-3h1"/><path d="M5 6h4"/>',
  kettle: '<path d="M6 9h10l-1 10H7z"/><path d="M5 9h12M9 6h4l2 3"/><path d="M16 12h2a2 2 0 0 1 0 4h-1"/><path d="M9 3h4"/>',
  'coffee-machine': '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M7 6V3h6v3M7 11h4v4H7z"/><path d="M14 11h4M14 14h4"/><path d="M12 15v3"/>',
  blender: '<path d="M8 3h8l1 11H7z"/><path d="M7 8h10"/><rect x="7" y="16" width="10" height="5" rx="1.5"/><path d="M10 18h4"/>',
  'induction-cooker': '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="9" cy="12" r="2.5"/><circle cx="16" cy="12" r="2.5"/><path d="M7 20h10"/>',
  'range-hood': '<path d="M3 5h18M6 5v5h12V5"/><path d="M8 10h8l2 6H6z"/><path d="M9 6c0 2 1 3 3 3s3-1 3-3"/>',

  toilet: '<path d="M6 4h8v5H6z"/><path d="M5 9h10v3a5 5 0 0 1-5 5H9a4 4 0 0 1-4-4z"/><path d="M8 17v4M14 17v4"/>',
  'toilet-seat': '<ellipse cx="12" cy="12" rx="7" ry="8"/><ellipse cx="12" cy="12" rx="4" ry="5"/><path d="M5 12h-2M21 12h-2M12 4V2"/>',
  'bath-heater': '<rect x="3" y="5" width="18" height="8" rx="2"/><circle cx="8" cy="9" r="1.5"/><circle cx="16" cy="9" r="1.5"/><path d="M7 16c1 1.2 2 1.2 3 0M12 16c1 1.2 2 1.2 3 0M17 16c1 1.2 2 1.2 3 0"/>',
  'water-heater': '<rect x="4" y="4" width="16" height="10" rx="4"/><path d="M8 14v6M16 14v6M4 17h4M16 17h4"/><path d="M12 7v4"/>',
  scale: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 12h10M9 15h6"/><path d="M8 3h8"/>',
  toothbrush: '<rect x="9" y="2.5" width="6" height="4" rx="1"/><path d="M10 6.5V19a2 2 0 0 0 4 0V6.5"/><path d="M10 10h4M10 13h4"/>',
  'hair-dryer': '<path d="M4 7h9a4 4 0 0 1 0 8H4z"/><path d="M7 15v5a1 1 0 0 0 1 1h2v-6"/><path d="M15 8h4M15 11h5M15 14h4"/>',
  'sleep-monitor': '<path d="M3 17v-5h18v5M3 17h18"/><path d="M5 12V7h6v5"/><path d="M14 9c1-1 2-1 3 0M14 12c1-1 2-1 3 0"/>',

  curtain: '<path d="M4 3.5v17M20 3.5v17M4 6.2c4.1 0 4.1 11.6 8 11.6M20 6.2c-4.1 0-4.1 11.6-8 11.6M12 6.2v11.6"/>',
  'roller-blind': '<path d="M4 4h16M6 4v5h12V4"/><path d="M6 9v10h12V9"/><path d="M10 11v6M14 11v6"/><path d="M12 19v2"/>',
  blinds: '<path d="M4 3h16M4 8h16M4 13h16M4 18h16"/><path d="M8 3v15M16 3v15"/><path d="M12 18v3"/>',

  tv: '<rect x="3" y="4.5" width="18" height="12.4" rx="2"/><path d="M9 21h6M12 16.9V21"/>',
  projector: '<rect x="3" y="7" width="12" height="9" rx="2"/><circle cx="8" cy="11.5" r="2"/><path d="M15 10l6-3v11l-6-3"/><path d="M7 19h4"/>',
  speaker: '<rect x="7.4" y="3.4" width="9.2" height="17.2" rx="4.1"/><circle cx="12" cy="15.4" r="1.2" fill="currentColor" stroke="none"/><path d="M9.8 7.6h4.4M4.7 9.4c-.9 1.5-.9 3.5 0 5M19.3 9.4c.9 1.5.9 3.5 0 5"/>',
  soundbar: '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M6 12h3M11 12h3M16 12h2"/><path d="M8 15v3M16 15v3"/>',
  display: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10" r="2"/>',

  router: '<rect x="3" y="13" width="18" height="6.2" rx="2"/><path d="M8 13V9M16 13V9M8 8.2 5.8 5.4M16 8.2l2.2-2.8"/><circle cx="6.8" cy="16.1" r=".9" fill="currentColor" stroke="none"/><circle cx="9.5" cy="16.1" r=".9" fill="currentColor" stroke="none"/>',
  'mesh-node': '<rect x="3" y="6" width="8" height="7" rx="2"/><rect x="13" y="11" width="8" height="7" rx="2"/><path d="M7 6V3M17 11V8"/><path d="M11 9.5h2"/>',
  hub: '<rect x="8" y="8" width="8" height="8" rx="2"/><path d="M12 8V3M12 16v5M8 12H3M16 12h5"/><circle cx="12" cy="12" r="1.5"/>',

  'pet-feeder': '<path d="M7 3h10l1 9H6z"/><path d="M6 12h12l-1 5H7z"/><path d="M9 17v3M15 17v3"/><path d="M9 7h6"/>',
  'pet-fountain': '<path d="M4 11h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 11c0-3 1.5-5 4-5s4 2 4 5"/><path d="M12 6V3"/>',
  'litter-box': '<path d="M3 9h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M7 9V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3"/><circle cx="12" cy="14" r="2"/>',
  'plant-sensor': '<path d="M6 13h12l-1 7H7z"/><path d="M12 13V9M9 10c0-3 2-5 3-6 1 1 3 3 3 6"/><path d="M4 6c1 1 2 1.5 3 1.5M20 6c-1 1-2 1.5-3 1.5"/>',

  printer: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><rect x="7" y="13" width="10" height="7" rx="1"/><path d="M6 11h2"/>',
  'monitor-light': '<rect x="3" y="5" width="18" height="11" rx="2"/><path d="M3 9h18M12 16v4M8 20h8"/>',
  'car-charger': '<path d="M4 14h16l-1.5-5H5.5z"/><circle cx="7" cy="17" r="1.5"/><circle cx="17" cy="17" r="1.5"/><path d="M8 9V6h8v3"/><path d="M12 3v3"/>',
  dashcam: '<rect x="4" y="7" width="12" height="8" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M16 9l4-2v8l-4-2"/><path d="M7 19h10"/>',
  'tire-pressure': '<circle cx="10" cy="12" r="6.5"/><circle cx="10" cy="12" r="2.5"/><path d="M16 8h5M18.5 5.5v5"/>',
  'smart-button': '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
  generic: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M9 9h6v6H9zM4.5 12h-2M21.5 12h-2M12 2.5v2M12 19.5v2"/>'
};

const MI_ICON_LABELS = {
  light: '灯泡', 'ceiling-light': '吸顶灯', 'pendant-light': '吊灯', 'desk-lamp': '台灯', 'wall-light': '壁灯',
  'floor-lamp': '落地灯', 'fan-light': '风扇灯', 'light-strip': '灯带', 'spot-light': '筒灯 / 射灯',
  'mirror-light': '镜前灯', 'night-light': '夜灯', 'ambient-light': '氛围灯', 'outdoor-light': '户外灯',
  'ac-wall': '壁挂空调', 'ac-floor': '柜机空调', 'ac-central': '中央空调', fan: '落地扇', 'tower-fan': '塔扇',
  'ceiling-fan': '吊扇', 'air-purifier': '空气净化器', humidifier: '加湿器', dehumidifier: '除湿机',
  heater: '电暖器', 'fresh-air': '新风机', 'air-monitor': '空气检测仪', 'temp-humidity': '温湿度计',
  plug: '智能插座', 'power-strip': '智能排插', 'switch-1': '单键开关', 'switch-2': '双键开关', 'switch-3': '三键开关',
  breaker: '智能断路器', 'universal-remote': '万能遥控器', 'camera-fixed': '固定摄像头', 'camera-ptz': '云台摄像头',
  'video-doorbell': '可视门铃', peephole: '智能猫眼', 'door-lock': '智能门锁', gateway: '网关',
  alarm: '声光报警器', 'smoke-sensor': '烟雾传感器', 'gas-sensor': '燃气传感器', 'water-leak': '水浸传感器',
  'door-sensor': '门窗传感器', 'motion-sensor': '人体传感器', 'light-sensor': '光照传感器', 'emergency-button': '紧急按钮',
  'robot-vacuum': '扫地机器人', 'stick-vacuum': '吸尘器 / 洗地机', washer: '洗衣机', dryer: '烘干机',
  'drying-rack': '智能晾衣架', fridge: '冰箱', 'rice-cooker': '电饭煲', microwave: '微波炉', oven: '烤箱',
  'air-fryer': '空气炸锅', dishwasher: '洗碗机', 'water-purifier': '净水器 / 饮水机', kettle: '电热水壶',
  'coffee-machine': '咖啡机', blender: '破壁机', 'induction-cooker': '电磁炉', 'range-hood': '油烟机',
  toilet: '智能马桶', 'toilet-seat': '智能马桶盖', 'bath-heater': '浴霸', 'water-heater': '热水器',
  scale: '体重秤 / 体脂秤', toothbrush: '电动牙刷', 'hair-dryer': '吹风机', 'sleep-monitor': '睡眠监测',
  curtain: '开合窗帘', 'roller-blind': '卷帘', blinds: '百叶帘', tv: '电视', projector: '投影仪',
  speaker: '智能音箱', soundbar: '回音壁', display: '智能屏', router: '路由器', 'mesh-node': 'Mesh 节点',
  hub: '智能中枢', 'pet-feeder': '宠物喂食器', 'pet-fountain': '宠物饮水机', 'litter-box': '猫砂盆',
  'plant-sensor': '植物监测', printer: '打印机', 'monitor-light': '屏幕挂灯', 'car-charger': '车载充电器',
  dashcam: '行车记录仪', 'tire-pressure': '胎压监测', 'smart-button': '无线按钮', generic: '其他设备'
};

const MI_ICON_GROUPS = [
  { id: 'lighting', title: '照明', keys: ['light', 'ceiling-light', 'pendant-light', 'desk-lamp', 'wall-light', 'floor-lamp', 'fan-light', 'light-strip', 'spot-light', 'mirror-light', 'night-light', 'ambient-light', 'outdoor-light'] },
  { id: 'climate', title: '环境电器', keys: ['ac-wall', 'ac-floor', 'ac-central', 'fan', 'tower-fan', 'ceiling-fan', 'air-purifier', 'humidifier', 'dehumidifier', 'heater', 'fresh-air', 'air-monitor', 'temp-humidity'] },
  { id: 'plug', title: '插座开关', keys: ['plug', 'power-strip', 'switch-1', 'switch-2', 'switch-3', 'breaker', 'universal-remote'] },
  { id: 'security', title: '安防与传感器', keys: ['camera-fixed', 'camera-ptz', 'video-doorbell', 'peephole', 'door-lock', 'gateway', 'alarm', 'smoke-sensor', 'gas-sensor', 'water-leak', 'door-sensor', 'motion-sensor', 'light-sensor', 'emergency-button'] },
  { id: 'cleaning', title: '清洁电器', keys: ['robot-vacuum', 'stick-vacuum', 'washer', 'dryer', 'drying-rack'] },
  { id: 'kitchen', title: '厨房电器', keys: ['fridge', 'rice-cooker', 'microwave', 'oven', 'air-fryer', 'dishwasher', 'water-purifier', 'kettle', 'coffee-machine', 'blender', 'induction-cooker', 'range-hood'] },
  { id: 'bath', title: '卫浴与个护', keys: ['toilet', 'toilet-seat', 'bath-heater', 'water-heater', 'scale', 'toothbrush', 'hair-dryer', 'sleep-monitor'] },
  { id: 'curtain', title: '窗帘', keys: ['curtain', 'roller-blind', 'blinds'] },
  { id: 'entertainment', title: '影音娱乐', keys: ['tv', 'projector', 'speaker', 'soundbar', 'display'] },
  { id: 'network', title: '路由网关', keys: ['router', 'mesh-node', 'hub'] },
  { id: 'pet', title: '宠物与植物', keys: ['pet-feeder', 'pet-fountain', 'litter-box', 'plant-sensor'] },
  { id: 'other', title: '办公 / 出行 / 其他', keys: ['printer', 'monitor-light', 'car-charger', 'dashcam', 'tire-pressure', 'smart-button', 'generic'] }
];

function miIncludes(text, words) {
  return words.some((word) => text.includes(word));
}

function miDeviceKind(device) {
  const name = String(device?.name || '');
  const model = String(device?.model || '').toLowerCase();
  const text = `${name} ${model}`.toLowerCase();
  const has = (words) => miIncludes(text, words);

  // 先处理“名字里同时出现多个品类”的组合，如风扇灯、宠物饮水机、智能门铃。
  if (has(['风扇灯'])) return 'fan-light';
  if (has(['宠物饮水', '猫咪饮水', '狗狗饮水']) || (has(['宠物', '猫', '狗']) && has(['饮水机', '饮水器']))) return 'pet-fountain';
  if (has(['宠物喂食', '喂食器', '自动喂食'])) return 'pet-feeder';
  if (has(['猫砂盆', '猫厕所'])) return 'litter-box';
  if (has(['植物监测', '花盆', '植物传感器'])) return 'plant-sensor';

  if (has(['可视门铃', '门铃摄像头', '智能门铃'])) return 'video-doorbell';
  if (has(['猫眼'])) return 'peephole';
  if (has(['门锁', '智能锁', '指纹锁'])) return 'door-lock';
  if (has(['摄像头', '摄像机', 'camera'])) return has(['云台', 'ptz']) ? 'camera-ptz' : 'camera-fixed';

  if (has(['门窗传感器', '门磁', '窗磁'])) return 'door-sensor';
  if (has(['人体传感器', '人体移动', '红外人体'])) return 'motion-sensor';
  if (has(['烟雾', '烟感'])) return 'smoke-sensor';
  if (has(['燃气', '天然气'])) return 'gas-sensor';
  if (has(['水浸', '漏水', '溢水'])) return 'water-leak';
  if (has(['光照传感器', '光线传感器'])) return 'light-sensor';
  if (has(['紧急按钮', 'sos', '求救'])) return 'emergency-button';
  if (has(['温湿度', '温度计', '湿度计'])) return 'temp-humidity';
  if (has(['空气检测', '甲醛', 'co2', '二氧化碳', '空气质量'])) return 'air-monitor';

  if (has(['扫地', '扫拖', 'robot vacuum'])) return 'robot-vacuum';
  if (has(['吸尘器', '洗地机', '无线吸尘'])) return 'stick-vacuum';
  if (has(['洗衣机'])) return 'washer';
  if (has(['烘干机'])) return 'dryer';
  if (has(['晾衣架', '晾衣机'])) return 'drying-rack';

  if (has(['冰箱', '冷柜'])) return 'fridge';
  if (has(['电饭煲', '压力锅', '饭煲'])) return 'rice-cooker';
  if (has(['微波炉'])) return 'microwave';
  if (has(['空气炸锅'])) return 'air-fryer';
  if (has(['烤箱', '蒸烤箱'])) return 'oven';
  if (has(['洗碗机'])) return 'dishwasher';
  if (has(['净水器', '净水机', '饮水机', '管线机'])) return 'water-purifier';
  if (has(['电热水壶', '热水壶', '养生壶'])) return 'kettle';
  if (has(['咖啡机'])) return 'coffee-machine';
  if (has(['破壁机', '料理机', '榨汁机'])) return 'blender';
  if (has(['电磁炉'])) return 'induction-cooker';
  if (has(['油烟机', '烟机'])) return 'range-hood';

  if (has(['马桶盖', '智能盖板'])) return 'toilet-seat';
  if (has(['马桶', '坐便器'])) return 'toilet';
  if (has(['浴霸'])) return 'bath-heater';
  if (has(['热水器'])) return 'water-heater';
  if (has(['体脂秤', '体重秤', '体脂仪'])) return 'scale';
  if (has(['牙刷'])) return 'toothbrush';
  if (has(['吹风机', '电吹风'])) return 'hair-dryer';
  if (has(['睡眠监测', '睡眠带', '睡眠仪'])) return 'sleep-monitor';

  if (has(['卷帘', '卷帘窗'])) return 'roller-blind';
  if (has(['百叶帘', '百叶窗'])) return 'blinds';
  if (has(['窗帘', '开合帘', '电动帘'])) return 'curtain';

  if (has(['投影仪', '投影机'])) return 'projector';
  if (has(['回音壁', 'soundbar'])) return 'soundbar';
  if (has(['智能屏', '中控屏', '触屏音箱'])) return 'display';
  if (has(['电视'])) return 'tv';
  if (has(['音箱', '小爱同学', 'speaker'])) return 'speaker';

  if (has(['mesh', '子母路由', '分布式路由'])) return 'mesh-node';
  if (has(['中枢', '智能中心'])) return 'hub';
  if (has(['路由器', '路由'])) return 'router';
  if (has(['网关', 'gateway'])) return 'gateway';
  if (has(['报警器', '声光报警', '警号'])) return 'alarm';

  if (has(['壁挂空调', '挂机空调', '挂机'])) return 'ac-wall';
  if (has(['柜机空调', '立式空调', '柜机'])) return 'ac-floor';
  if (has(['中央空调', '风管机'])) return 'ac-central';
  if (has(['塔扇'])) return 'tower-fan';
  if (has(['吊扇'])) return 'ceiling-fan';
  if (has(['空调'])) return 'ac-wall';
  if (has(['风扇', '循环扇', '落地扇'])) return 'fan';
  if (has(['空气净化器', '净化器'])) return 'air-purifier';
  if (has(['加湿器'])) return 'humidifier';
  if (has(['除湿机'])) return 'dehumidifier';
  if (has(['电暖器', '取暖器', '暖风机', '踢脚线'])) return 'heater';
  if (has(['新风机', '新风系统'])) return 'fresh-air';

  if (has(['吸顶灯', '顶灯'])) return 'ceiling-light';
  if (has(['吊灯'])) return 'pendant-light';
  if (has(['台灯', '护眼灯', '学习灯', '钢琴灯'])) return 'desk-lamp';
  if (has(['壁灯', '壁挂灯', '床头灯'])) return 'wall-light';
  if (has(['落地灯'])) return 'floor-lamp';
  if (has(['灯带', '灯条', '氛围灯'])) return 'light-strip';
  if (has(['筒灯', '射灯', '轨道灯'])) return 'spot-light';
  if (has(['镜前灯', '镜灯'])) return 'mirror-light';
  if (has(['夜灯', '地脚灯', '感应灯'])) return 'night-light';
  if (has(['户外灯', '庭院灯', '泛光灯'])) return 'outdoor-light';
  if (has(['屏幕挂灯', '显示器挂灯'])) return 'monitor-light';
  if (has(['灯组', '灯泡', '灯'])) return 'light';

  if (has(['三键开关', '三开开关', '三路开关'])) return 'switch-3';
  if (has(['双键开关', '两键开关', '双开开关', '二开开关'])) return 'switch-2';
  if (has(['单键开关', '一开开关', '单开开关'])) return 'switch-1';
  if (has(['断路器', '空开', '漏保'])) return 'breaker';
  if (has(['排插', '插排', '接线板'])) return 'power-strip';
  if (has(['插座', '墙壁插座'])) return 'plug';
  if (has(['开关'])) return 'switch-1';
  if (has(['万能遥控', '遥控器'])) return 'universal-remote';
  if (has(['按钮', '无线开关', '场景开关'])) return 'smart-button';

  if (has(['打印机'])) return 'printer';
  if (has(['车载充电', '车充'])) return 'car-charger';
  if (has(['行车记录仪'])) return 'dashcam';
  if (has(['胎压'])) return 'tire-pressure';

  // 型号兜底：名字被用户改成“客厅灯”之类时，仍能按产品线归类。
  if (has(['camera'])) return 'camera-fixed';
  if (has(['lock'])) return 'door-lock';
  if (has(['vacuum'])) return 'robot-vacuum';
  if (has(['washer'])) return 'washer';
  if (has(['dryer'])) return 'dryer';
  if (has(['curtain'])) return 'curtain';
  if (has(['airconditioner'])) return 'ac-wall';
  if (has(['cfan', 'fan'])) return 'fan';
  if (has(['humidifier'])) return 'humidifier';
  if (has(['purifier'])) return 'air-purifier';
  if (has(['projector'])) return 'projector';
  if (has(['speaker'])) return 'speaker';
  if (has(['router'])) return 'router';
  if (has(['light'])) return 'light';
  if (has(['plug'])) return 'plug';
  if (has(['switch'])) return 'switch-1';
  if (has(['sensor'])) return 'motion-sensor';
  return 'generic';
}

const MI_ICON_FAMILY_OVERRIDES = { 'monitor-light': 'lighting' };

function miFamilyFor(kind) {
  if (MI_ICON_FAMILY_OVERRIDES[kind]) return MI_ICON_FAMILY_OVERRIDES[kind];
  return MI_ICON_GROUPS.find((group) => group.keys.includes(kind))?.id || 'other';
}

window.MiIcons = {
  icons: MI_ICON_ICONS,
  labels: MI_ICON_LABELS,
  groups: MI_ICON_GROUPS,
  kindFor: miDeviceKind,
  familyFor: miFamilyFor
};
