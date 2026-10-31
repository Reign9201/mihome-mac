const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { profileFromSpec } = require('../ui/capabilities.js');

const spec = {
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:1',
      description: 'Light',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:1',
          format: 'bool',
          access: ['read', 'write'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:brightness:1',
          format: 'uint8',
          access: ['read', 'write'],
          unit: 'percentage',
          value_range: { min: 1, max: 100, step: 1 },
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:1',
          format: 'uint8',
          access: ['write'],
          value_list: [{ value: 0, description: 'Reading' }],
        },
      ],
      actions: [
        { iid: 1, type: 'urn:miot-spec-v2:action:toggle:1', inputs: [] },
        { iid: 2, type: 'urn:miot-spec-v2:action:set-level:1', inputs: [{ piid: 2 }] },
      ],
    },
    {
      iid: 3,
      type: 'urn:miot-spec-v2:service:battery:1',
      properties: [{
        iid: 1,
        type: 'urn:miot-spec-v2:property:battery-level:1',
        format: 'uint8',
        access: ['read', 'notify'],
        unit: 'percentage',
      }],
    },
  ],
};

test('maps MIoT properties to typed controls', () => {
  const profile = profileFromSpec(spec);
  assert.deepEqual(profile.controls.map((item) => item.type), ['toggle', 'range', 'segments']);
  assert.equal(profile.controls[0].label, '开关');
  assert.equal(profile.controls[1].suffix, '%');
  assert.equal(profile.actions.length, 1);
  assert.equal(profile.metrics.find((item) => item.label === '电量').secondary, true);
});

test('does not invent controls for a missing spec', () => {
  const profile = profileFromSpec({ services: [] });
  assert.equal(profile.controls.length, 0);
  assert.match(profile.note, /没有可用/);
});

test('accepts the hyphenated fields returned by miot-spec.org', () => {
  const profile = profileFromSpec({
    services: [{
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:1',
      description: 'Light',
      properties: [
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:brightness:1',
          format: 'uint8',
          access: ['read', 'write'],
          unit: 'percentage',
          'value-range': [1, 100, 1],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:1',
          format: 'uint8',
          access: ['write'],
          'value-list': [{ value: 0, description: 'Reading' }],
        },
      ],
    }],
  });
  assert.deepEqual(profile.controls.map((item) => item.type), ['range', 'segments']);
  assert.equal(profile.controls[0].min, 1);
  assert.equal(profile.controls[0].max, 100);
  assert.deepEqual(profile.controls[1].options, [[0, 'Reading']]);
});

test('global UI lock disables selection and copying', () => {
  const root = path.resolve(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'ui/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(css, /user-select:none/);
  assert.match(css, /-webkit-user-drag:none/);
  assert.match(css, /::selection\{background:transparent/);
  assert.match(js, /'copy', 'cut', 'dragstart'/);
  assert.match(js, /'selectstart'/);
});

test('loads a narrow Tauri bridge instead of the global API', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'ui/tauri-bridge.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  assert.equal(app.includes('window.__TAURI__'), false);
  assert.match(app, /window\.__MIHOME_TAURI__\?\.invoke/);
  assert.match(bridge, /@tauri-apps\/api\/core/);
  assert.match(html, /src="tauri-api\.js"/);
});

test('chunks device-spec requests to the backend limit', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../ui/app.js'), 'utf8');
  assert.match(app, /const SPEC_BATCH_SIZE = 128;/);
  assert.match(app, /missing\.slice\(offset, offset \+ SPEC_BATCH_SIZE\)/);
});

test('bundle keeps a strict CSP and ships license notices', () => {
  const config = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'src-tauri/tauri.conf.json'),
    'utf8',
  ));
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.match(config.app.security.csp, /script-src 'self'/);
  assert.equal(config.app.security.csp.includes("'unsafe-inline'"), false);
  assert.equal(config.app.withGlobalTauri, false);
  assert.equal(config.bundle.macOS.minimumSystemVersion, '13.0');
  assert.equal(config.bundle.resources['../../LICENSE'], 'LICENSE');
  assert.equal(
    config.bundle.resources['../../THIRD_PARTY_NOTICES.md'],
    'THIRD_PARTY_NOTICES.md',
  );
  assert.deepEqual(config.bundle.externalBin, ['../../helpers/go2rtc/go2rtc']);
});

test('release bundle strips symbols without requiring cargo-binutils', () => {
  const root = path.resolve(__dirname, '..');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const build = fs.readFileSync(path.resolve(root, '../scripts/build-macos.sh'), 'utf8');
  const config = JSON.parse(fs.readFileSync(
    path.join(root, 'src-tauri/tauri.conf.json'),
    'utf8',
  ));
  assert.match(cargo, /tauri = \{ version = "2", default-features = false, features = \["wry"\] \}/);
  assert.match(cargo, /^lto = true$/m);
  assert.match(cargo, /^codegen-units = 1$/m);
  assert.match(cargo, /^strip = false$/m);
  assert.match(cargo, /^panic = "abort"$/m);
  assert.equal(config.build.beforeBundleCommand, 'bash ../scripts/strip-macos-binary.sh');
  assert.match(build, /DMG_FORMAT=\$\{DMG_FORMAT:-ULMO\}/);
  assert.equal(
    fs.existsSync(path.resolve(root, '../scripts/strip-macos-binary.sh')),
    true,
  );
});
