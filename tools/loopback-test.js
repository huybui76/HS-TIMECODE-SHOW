/**
 * Test nhanh thư viện osc trên máy này: mở 2 cổng UDP, gửi A→B, B nhận.
 * Chạy: npm run loopback
 */
const osc = require('osc');

const a = new osc.UDPPort({ localAddress: '127.0.0.1', localPort: 7101, remoteAddress: '127.0.0.1', remotePort: 7102 });
const b = new osc.UDPPort({ localAddress: '127.0.0.1', localPort: 7102 });

b.on('message', (m) => {
  console.log('PASS — nhận được:', m.address, JSON.stringify(m.args));
  a.close(); b.close();
  process.exit(0);
});

a.open();
b.open();

setTimeout(() => {
  a.send({ address: '/test/ping', args: [1, 2.5, 'hello'] });
}, 300);

setTimeout(() => {
  console.error('FAIL — không nhận được message sau 3 giây');
  process.exit(1);
}, 3000);
