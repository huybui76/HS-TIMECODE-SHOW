# Prompt Kiem Thu Doc Lap HS Timecode

Ban la ky su QA/SDET senior cho Electron, OSC/MIDI va ung dung timecode.
Hay kiem thu doc lap code hien tai, khong tin ket luan hoac so lieu cua AI truoc.

Repo: `/Users/huy/DATA show/HS TIMECODE`.
Doc `CLAUDE.md` truoc. Worktree dang co nhieu thay doi chua commit; khong reset,
checkout, stash, commit hoac ghi de thay doi nguoi dung.

## Pham vi va an toan

- Kiem thu, chan doan va viet bao cao; khong tu sua production code. Co the sua
  harness test bi lech API sau khi chung minh day la loi harness, khong lam yeu assertion.
- Khong tu bat/ket noi Resolume that, kich clip, phat OSC ra mang, chiem cong
  dang dung, kill Electron cua nguoi dung hay thay sysctl/cau hinh he thong.
- Can Electron/CDP/UDP/device that thi chi chay tren instance duoc co lap va
  duoc nguoi dung chap thuan. Khong chay nguyen xi script test cu khi chua doc:
  mot so script CDP thay du lieu va dung tien trinh Electron.
- Neu khong co phan cung thi danh dau BLOCKED/NOT RUN, khong doi thanh PASS.
- Khong coi syntax check, mock VM hay test plan la test UI/UDP/LTC that.
- Bao loi theo severity, file:line, cac buoc tai hien va expected/actual.

## Kien truc can xac minh

- `main.js` / `preload.js`: utility lifecycle, MessagePort, OSC Out.
- `realtime-config.js`: hang so dung chung.
- `osc-parser.js`: dia chi raw truoc args, trie wildcard va strict filter.
- `osc-ring.js`: fixed typed array, endpoint Float, ownership sequence.
- `osc-ingest.js`: UDP, accepted event batch, UI latest-value batch, ACK,
  recordStarted/recordRejected, recorder, preview va drain.
- `recording-session.js`: recorder thong nhat MIDI/OSC, match 1-1, gesture,
  fallback, timestamp, Float correlation va finish cutoff.
- `renderer/app.js`: recording transaction, model/project v13, lanes,
  preview, editor, playback bridge, Undo va OSC Out selector.
- `renderer/cue-layout.js`, `curve-tools.js`, `curve-editor.js`,
  `cue-playback.js`: module thuan va editor DOM.
- `osc-encode.js`, `osc-targets.js`: encode Nil/blob/nested args va route output.

## Khong gia dinh cac hanh vi sau da duoc nghiem thu

- Code cu co nut/flag SMPTE Input nhung chua chung minh co bo giai ma LTC/MTC
  hay dong bo clip Resolume that. Phai truy vet nguon tin hieu va behavior;
  test scheduler voi frame gia lap KHONG phai test LTC.
- Khong co tich hop REST/WebSocket de lay ten that. Ten la quy uoc tu dia chi.
- Trong REC, app Bounce bi tat de tranh physical MIDI + Bounce tao hai feedback.
  MIDI can di truc tiep vao Resolume. Ngoai REC, nut Bounce van dieu khien nhu cu.
- Float MIDI chua map hoac suy doan duoc hien thi bang du lieu MIDI; khong tu
  coi curve CC chuan hoa la curve OSC that de phat.
- Strict filter chi nhan connect/clear va float duoc gan/dang hoc. Monitor mo
  khong duoc tu mo toan bo telemetry. Hoc CC chi mo discovery co thoi han.
- Chua build lai `.app`; kiem thu source va phan biet voi binary cu trong dist.

## Chay unit va integration mock

Doc moi script truoc khi chay. Cac suite duoi day du kien khong can phan cung:

```sh
node tools/test-osc-parser.js
node tools/test-osc-ring.js
node tools/test-osc-ingest.js
node tools/test-osc-process.js
node tools/test-osc-feedback.js
node tools/test-osc-renderer.js
node tools/test-rec-engine.js
node tools/test-recording-session.js
node tools/test-recording-ingest.js
node tools/test-recording-bridge.js
node tools/test-cue-layout.js
node tools/test-cue-layout-bridge.js
node tools/test-curve-tools.js
node tools/test-curve-editor.js
node tools/test-curve-bridge.js
node tools/test-cue-playback.js
node tools/test-playback-bridge.js
node tools/test-project-recording-schema.js
node tools/test-osc-target-routing.js
node tools/test-renderer-bootstrap.js
```

Luu y thay doi CUOI CHUA CHAY LAI SUITE: readiness gate yeu cau UDP da emit
listening, recordStarted acceptance, mapping nam trong recordActions.mappings
thay vi message recordMapping rieng, preview co ACK, va fallback config per
session. Harness can mock socket lifecycle that su, khong bo gate production
chi de test pass. Harness trich ham can nap projectEncode/projectDecode/
projectOscArgs, HSRealtime va cac module production thay vi stub logic can test.

## Ma Tran Can Test

### Recording va transaction

1. REC tat hoac timeline dung: khong cue. REC bat+Play: event frame dung o
   24/25/30fps, compensation tru dung mot lan, speed/offset khong lech.
2. MessagePort co nhung UDP chua listening: khong tao phien gia, khong xoa cue
   o overwrite. Utility tu choi thi renderer abort/disarm, khong false-active.
3. Overwrite chi xoa sau recordStarted cua DUNG session/current port.
4. Stop/tat REC/seek o ranh gioi batch: moi event nhan truoc cutoff duoc giu;
   late pre-cutoff MIDI/OSC khong tao cue doi; post-cutoff direct khong ghi.
5. recordDrained chi den sau moi recordActions ACK. Timeout abort utility,
   giu phan da nhan, cho phep phien moi va hien canh bao du lieu thieu.
6. Moi phien dung mot Undo/Redo, bao gom mappings/lanes; autosave sau drain.
   Warning/overflow khong bi thay bang thong bao thanh cong.
7. Dong socket/rebind/crash/port replacement/MIDI unplug: khong cue treo,
   khong kẹt ownership phien cu, khong tu record lai sau restart.

### Match, loai cue va mapping

8. MIDI mapped + OSC: dung mot cue voi args OSC, metadata MIDI dung.
   MIDI unmapped: cue cho, ten phim, khong OSC gia/khong MIDI Out.
9. Direct click Resolume: Trigger 1s. Note giu 0.1/0.49s Trigger 1s;
   0.5/3s Piano dung hold. OFF khong thanh cue direct thua cua note matched.
10. Ba note nhanh/hop am: match 1-1; onset truoc MIDI 10ms duoc match;
    ngoai cua so 500ms khong match; giu note >5s khong mat onset.
11. Dia chi concrete duoc uu tien hon selected alias; alias toi muon sau
    resolve van khong tao cue thu hai. Lap hai trigger giong nhau van giu du.
12. CC idle300ms tach gesture; hai CC song song khong gan cheo; chuoi CC
    [0,1,.25,.8,.1] cach100ms voi OSC .2+.5*CC tre90ms phai match.
    Neu mo ho thi cho gan, khong doan nham feedback nen.
13. Mapping actual duoc luu/them cap nhat; fallback bat thi guessed, tat thi
    pending; khong luu guessed thanh mapping that; key phan biet device/channel.
14. physical MIDI + app Bounce trong REC khong tao ban gui thu hai. Ngoai REC
    Bounce mapped van hoat dong; phim chua map khong gui template gia.
15. Ghi va playback dong thoi: recTx chi consume echo token mot lan, khong
    xoa cac lan trigger lap hop le khac. Neu nhieu target echo phai bao ro policy.

### Lane, ten, mau, preview

16. Clip cung layer chung hang; opacity/playmode la nhom tham so rieng;
    columns chung hang; unmapped moi phim/CC/device mot nhom.
17. Trigger duoc chong; Float/Piano chong thi hang phu ngay duoi nhom;
    empty auto-row duoc xoa, manual +R duoc giu, R lien tuc sau them/xoa/reorder.
18. Reorder bang drag/up/down/keyboard: cue theo dung lane identity;
    khong doi V/A, lock hoac folder khac. Manual move khong tu regroup lai.
19. Ten quy uoc Layer/Column/Clip/param dung; ten/mau sua tay khong bi ghi de.
    Mau on dinh save/open/Undo, lien ke phan biet va label doc duoc.
20. Preview note dai ra realtime; Float co curve; max128 items/32points,
    mot preview in-flight va ACK finally. Preview khong vao project, playback,
    hit-test/Undo/autosave; finalize/drain/interrupt khong de ghost treo.

### Curve va editing

21. Dau/cuoi OSC .4488->.6142 dung, khong them 0. RDP sai so<=epsilon;
    point-cap phai canh bao. Giữ full args/numericIndex/interpolation.
22. Double click them, keo/xoa keyframe, numeric/slider, linear/ease/step;
    drag/slider mot Undo; cancel/close rollback, khong listener leak.
23. Raw Float cuoi180ms o24/30fps va170ms o25fps: exact endpoint duoc giu
    trong sai so mot frame. captureEndpoint chi dung voi curve chua sua.
24. Trim/split/resize khong stretch ngam; move chi doi frame; clone/Alt/Ctrl
    drag giu deep metadata, SMPTE, enabled, target va manual flags.
25. Multi-select/box/drag snapframe, lane collision va lock dung. Undo/Redo
    sau edit khong mat redo do restore tao them snapshot.

### Playback va luu project

26. Trigger dung args1lan; Piano1 dau/0 cuoi hoac layerclear tuy setting.
    Float30Hz giu first/last, step phai hold, khong gui curve MIDI display-only.
27. Seek giua cue khong chase; stop/seek release Piano da bat. Them cue REC
    trong qua khu khong stop Piano/Float dang phat va khong replay cue cu.
28. OutputTarget all/specific/list/empty/disabled/missing: khong broadcast
    fallback sai; PlayNow va Mini dung cung route.
29. Nil, UTF8, bool, nested arrays, U8/Buffer blobs encode byte-exact qua
    target va fallback sender. Danh gia separate string/numeric/blob types.
30. Project v13 save/open+autosave+snapshot giu args/keyframes/mapping/
    numericIndex/dataOrigin/recordingSpeed/captureEndpoint/target/overrides.
    Migrate3..12 khong mat cue cho; duplicate definition IDs khong im lang
    lam chay nham dia chi. Bao loi neu schema khong co policy ro.

### Hieu Nang Va Hardware

31. Sau khi doc harness, chay `node tools/profile-osc-ingest.js --seconds 60 --compact`.
    Kiem tra180000OSC,12000note-on+12000note-off, actual recorder, queue ACK,
    no wrong match/drop; report expected point reduction rieng, khong goi
    warning reduction la lossless curve. Day khong phai renderer FPS test.
32. Electron isolate:3000OSC/s+200MIDI/s60s,500+cue; do FPS,CPU,heap,queue,
    p99latency,OS UDP recv buffer va matgoi input sequence. Biet datagram vsleaf.
33. Stall consumer: ca UI,event,recordAction,mapping,preview deu bi gioi han,
    khong chi bounded Map ma backlog MessagePort vohan. Idle khongdecode.
34. Duoc chap thuan moi test thiet bi/Resolume: Output all messages, note/CC,
    direct click, Play/LTC, Piano connect0 so voi layerclear. Ghi ro phien ban,
    cong/device/route va actual signal source, khong gia lap thanh hardware PASS.
35. Regression: Trigger/Piano/Float, SMPTE flag/Input, PAD Tu dong, Ghi them,
    Don trung,+R,An clip,Ghi chu,Chon tu OSC,Lay tu Resolume,mau,manualMIDI,
    output selector,Mini,project isolation,LAN sync va audio clock.

## Bao Cao Bat Buoc

- Findings truoc, theo severity, kem repro va file:line.
- Bang PASS/FAIL/BLOCKED/NOT RUN theo tung nhom tren; khong gop mock va real.
- Moi lenh da chay + exit code + so test + ly do harness thay doi.
- So lieu profile thuc; khong ke thua so lieu cu thanh ket qua moi.
- Danh sach tinh nang chua duoc implement hoac chua chung minh, dac biet
  SMPTE/LTC that, Lay tu Resolume va FPS500cue.
- Khong tu tuyen bo san sang chay show khi hardware/regression con BLOCKED.
