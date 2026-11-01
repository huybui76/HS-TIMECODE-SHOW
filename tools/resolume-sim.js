/**
 * Giả lập Resolume Arena để test HS TIMECODE mà không cần mở Resolume:
 *  - Gửi OSC "feedback" tới app (127.0.0.1:7001): các lệnh connect clip
 *    theo chu kỳ + nhiễu position (như Resolume feedback thật).
 *  - Nghe cổng 7000 và in ra mọi cue app gửi lại (kiểm tra playback).
 *
 * Chạy: npm run sim
 */
const osc = require('osc');

const APP_HOST = '127.0.0.1';
const APP_LISTEN = parseInt(process.argv[2], 10) || 7000;   // cổng app đang nghe
const APP_SENDS_TO = parseInt(process.argv[3], 10) || 7001; // app gửi playback về đây

const out = new osc.UDPPort({ remoteAddress: APP_HOST, remotePort: APP_LISTEN });
const ear = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: APP_SENDS_TO });

let tx = 0, rx = 0;
ear.on('message', (m) => {
  rx++;
  console.log(`◀ APP→SIM  ${m.address}  ${JSON.stringify(m.args)}`);
});
ear.on('error', (e) => console.error('Lỗi cổng nghe:', e.message));

out.open();
ear.open();

console.log(`[sim] Gửi OSC tới ${APP_HOST}:${APP_LISTEN}, nghe playback tại :${APP_SENDS_TO} …`);

let i = 0;
const seq = setInterval(() => {
  const layer = 1 + (i % 3);
  const clip = 1 + (Math.floor(i / 3) % 4);
  out.send({ address: `/composition/layers/${layer}/clips/${clip}/connect`, args: [1] });
  tx++;
  if (i % 3 === 0) {
    out.send({ address: '/composition/columns/' + (1 + (i % 8)) + '/connect', args: [1] });
    tx++;
  }
  console.log(`▶ SIM→APP /composition/layers/${layer}/clips/${clip}/connect`);
  i++;
  if (i >= 10) {
    clearInterval(seq);
    clearInterval(noise);
    setTimeout(() => {
      console.log(`\n[sim] Xong. Đã gửi ${tx} message, nhận ${rx} cue từ app.`);
      console.log('[sim] (Nhấn Ctrl+C để thoát, hoặc để chạy để xem playback)');
    }, 500);
  }
}, 900);

// nhiễu giống feedback thật của Resolume (position liên tục)
const noise = setInterval(() => {
  out.send({ address: '/activeclip/video/position/values', args: [Math.random()] });
}, 350);

setTimeout(() => { /* giữ tiến trình sống thêm 60s để xem playback */ }, 60000).unref?.();
