const fs = require('fs');
const crypto = require('crypto');

const mode = process.argv[2] || 'json';
const path = process.argv[3] || 'data/home.json';
const iterations = Number(process.argv[4] || 30);
const data = fs.readFileSync(path);

function walk(payload) {
  let n = 0;
  for (const home of payload.homes) {
    for (const device of home.devices) {
      n++;
      for (const prop of device.props) {
        if (prop.value === true) n++;
      }
    }
  }
  return n;
}

if (mode === 'noop') {
  console.log('ok');
} else if (mode === 'startup' || mode === 'json') {
  const loops = mode === 'startup' ? 1 : iterations;
  const start = process.hrtime.bigint();
  let checksum = 0;
  for (let i = 0; i < loops; i++) checksum = walk(JSON.parse(data.toString('utf8')));
  const ns = Number(process.hrtime.bigint() - start) / loops;
  console.log(`devices=${checksum} iter=${loops} ns_per_iter=${Math.round(ns)}`);
} else if (mode === 'crypto') {
  const token = Buffer.from('0123456789abcdef0123456789abcdef');
  const key = crypto.createHash('md5').update(token).digest();
  const iv = crypto.createHash('md5').update(Buffer.concat([key, token])).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.alloc(1024, 0x41)), cipher.final()]);
  const start = process.hrtime.bigint();
  let total = 0;
  for (let i = 0; i < iterations; i++) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    total += Buffer.concat([decipher.update(enc), decipher.final()]).length;
  }
  const ns = Number(process.hrtime.bigint() - start) / iterations;
  console.log(`plain=${total / iterations} iter=${iterations} ns_per_iter=${Math.round(ns)}`);
} else {
  console.log('unknown mode');
}
