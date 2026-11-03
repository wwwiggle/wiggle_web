// /tools/pdf-resize 시험 화면을 실제 Chrome(CDP)으로 확인한다: 파일 선택 → 판형 바꾸기 → 미리보기·표·내려받기,
// 그리고 내려받은 PDF의 쪽 크기. 320×568·390×844·844×390에서 가로 넘침과 44px 미만 터치 목표를 잰다.
// 이어서 1440×900에서 방식 조합별 표 값, 판형 고정본 전환, 배경 끄기, 미리보기 쪽 바꾸기, 잘못된·손상·암호 파일 안내,
// 키보드만으로 모든 조작 닿기를 확인한다. --big <파일>을 주면 큰 PDF의 읽기·변환·미리보기 시간과 JS 메모리를 잰다.
// 화면 캡처: PDF_RESIZE_SCREENSHOTS=<폴더>
// 사용: npm run build && npx next start -p 3299 & node scripts/check-pdf-resize-browser.mjs http://localhost:3299
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, rgb } from "pdf-lib";

const BASE = process.argv[2];
const BIG = process.argv.includes("--big") ? process.argv[process.argv.indexOf("--big") + 1] : null;
if (!BASE) { console.error("사용: node scripts/check-pdf-resize-browser.mjs http://localhost:3299"); process.exit(2); }
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Chrome을 찾지 못했습니다.");
const PT = 72 / 25.4;

class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.errors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { done, reject } = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else done(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((done, reject) => { this.pending.set(id, { done, reject }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function evaluate(cdp, session, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate 실패");
  return result.result.value;
}
async function waitFor(cdp, session, expression, label, timeout = 20000) {
  for (const start = Date.now(); Date.now() - start < timeout; await sleep(150)) if (await evaluate(cdp, session, expression)) return;
  throw new Error(`${label} 기다리다 시간 초과: ${await evaluate(cdp, session, "document.querySelector('[role=status]')?.textContent ?? ''")}`);
}

const work = resolve(tmpdir(), `wiggle-pdf-resize-${Date.now()}`);
mkdirSync(work, { recursive: true });
const sample = await PDFDocument.create();
for (let i = 0; i < 3; i++) {
  const page = sample.addPage([210 * PT, 210 * PT]);
  page.drawRectangle({ x: 0, y: 0, width: 210 * PT, height: 210 * PT, color: rgb(0.2, 0.5, 0.8) });
  page.drawCircle({ x: 105 * PT, y: 105 * PT, size: 60 * PT, color: rgb(1, 0.85, 0.2) });
  page.drawText(`page ${i + 1}`, { x: 20 * PT, y: 180 * PT, size: 24 });
}
const samplePath = resolve(work, "sample-210x210.pdf");
const sampleBytes = Buffer.from(await sample.save({ useObjectStreams: false }));
writeFileSync(samplePath, sampleBytes);
const badFiles = { "notes.txt": "not a pdf", "broken.pdf": "%PDF-1.7 broken", "locked.pdf": sampleBytes.toString("latin1").replace("trailer\n<<", "trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>") };
for (const [name, text] of Object.entries(badFiles)) writeFileSync(resolve(work, name), Buffer.from(text, "latin1"));
// In-page helpers for the 1440 scenarios.
const UI = `window.__ui = {
  input(label) { return [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(label))?.querySelector('input,select'); },
  set(el, value) { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); },
  radio(name, i) { document.querySelectorAll('input[name=' + name + ']')[i].click(); },
  convert() { [...document.querySelectorAll('button')].find((b) => b.textContent === '판형 바꾸기').click(); },
  status() { return document.querySelector('[role=status]')?.textContent ?? ''; },
  row() { return [...document.querySelectorAll('.pdf-resize-table tbody tr:first-child td')].map((td) => td.textContent); },
  canvas(i) { return document.querySelectorAll('.pdf-resize-previews canvas')[i]?.toDataURL().slice(-200) ?? ''; },
  painted(i) { const c = document.querySelectorAll('.pdf-resize-previews canvas')[i]; return !!c && c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] > 0; },
}; true`;

const port = 9334;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(work, "profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  let ws;
  for (let i = 0; i < 60 && !ws; i++) { try { ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); } }
  const socket = new WebSocket(ws);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const cdp = new Cdp(socket);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, s); await cdp.send("Runtime.enable", {}, s); await cdp.send("DOM.enable", {}, s);

  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 768 }, s);
    await cdp.send("Page.navigate", { url: `${BASE}/tools/pdf-resize` }, s);
    await waitFor(cdp, s, "document.readyState === 'complete' && !!document.querySelector('input[type=file]')", "화면 열기");
    const robots = await evaluate(cdp, s, "document.querySelector('meta[name=robots]')?.content ?? ''");
    assert.match(robots, /noindex/);

    const { root } = await cdp.send("DOM.getDocument", {}, s);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" }, s);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [samplePath] }, s);
    await waitFor(cdp, s, "/3쪽 · 210×210mm 3쪽/.test(document.body.innerText)", "원본 정보");

    // 스위트북 기본값 + 채우기 + 도련 끝까지
    await evaluate(cdp, s, `(() => { const radio = (name, i) => document.querySelectorAll('input[name=' + name + ']')[i].click(); radio('mode', 1); radio('into', 1); return true; })()`);
    await evaluate(cdp, s, "[...document.querySelectorAll('button')].find((b) => b.textContent === '판형 바꾸기').click(), true");
    await waitFor(cdp, s, "!!document.querySelector('a[download]')", "결과");
    const result = await evaluate(cdp, s, `(async () => {
      const link = document.querySelector('a[download]');
      const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
      let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      const canvases = [...document.querySelectorAll('.pdf-resize-previews canvas')].map((c) => [c.width, c.height]);
      const rows = [...document.querySelectorAll('.pdf-resize-table tbody tr')].map((r) => r.innerText.replace(/\\s+/g, ' '));
      const doc = document.documentElement;
      const small = [...document.querySelectorAll('button, a[href], select, input:not([type=radio]):not([type=checkbox]), .pdf-resize-choice label')]
        .map((e) => [e.tagName + ':' + (e.textContent || e.getAttribute('type') || '').trim().slice(0, 20), e.getBoundingClientRect()])
        .filter(([, r]) => r.width > 0 && Math.min(r.width, r.height) < 44).map(([label, r]) => label + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      const radios = [...document.querySelectorAll('.pdf-resize-choice input[type=radio]')].map((e) => Math.round(e.getBoundingClientRect().width));
      const choiceText = [...document.querySelectorAll('.pdf-resize-choice span')].map((e) => Math.round(e.getBoundingClientRect().width));
      const color = Math.round(document.querySelector('input[type=color]').getBoundingClientRect().width);
      return { radios, choiceText, color, name: link.download, base64: btoa(binary), canvases, rows, overflow: doc.scrollWidth - doc.clientWidth, small, status: document.querySelector('[role=status]')?.textContent };
    })()`);
    assert.equal(result.overflow <= 0, true, `${width}×${height} 가로 넘침 ${result.overflow}px`);
    assert.deepEqual(result.small, [], `${width}×${height} 44px 미만 터치 목표`);
    assert.ok(result.radios.length === 7 && result.radios.every((w) => w <= 24), `라디오 단추 너비 ${result.radios}`);
    assert.ok(result.choiceText.every((w) => w >= 180), `선택지 글 너비 ${result.choiceText}`);
    assert.ok(result.color <= 80, `색 고르기 너비 ${result.color}`);
    assert.equal(result.canvases.length, 2); assert.ok(result.canvases.every(([w, h]) => w > 100 && h > 100), "미리보기 두 장");
    assert.equal(result.rows.length, 3); assert.match(result.rows[0], /1\.2095/);
    assert.equal(result.name, "sample-210x210_243x248_도련3.pdf");
    const out = await PDFDocument.load(Buffer.from(result.base64, "base64"));
    const sizes = out.getPages().map((p) => { const b = p.getMediaBox(), t = p.getTrimBox(); return [b.width, b.height, t.x, t.width].map((v) => Math.round(v / PT)); });
    assert.deepEqual(sizes, [[249, 254, 3, 243], [249, 254, 3, 243], [249, 254, 3, 243]]);

    if (process.env.PDF_RESIZE_SCREENSHOTS) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, s);
      writeFileSync(resolve(process.env.PDF_RESIZE_SCREENSHOTS, `pdf-resize-${width}x${height}.png`), Buffer.from(shot.data, "base64"));
    }
    // 잘못된 쪽 범위는 막고 안내한다. 고치면 다시 바뀐다.
    await evaluate(cdp, s, `(() => { const input = [...document.querySelectorAll('input')].find((i) => i.placeholder?.startsWith('예:')); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '9'); input.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('button')].find((b) => b.textContent === '판형 바꾸기').click(); return true; })()`);
    await waitFor(cdp, s, "/1~3 안에서/.test(document.querySelector('[role=status]')?.textContent ?? '')", "쪽 범위 오류 안내");
    assert.equal(await evaluate(cdp, s, "document.querySelector('a[download]') === null"), true, "실패하면 옛 결과를 보여 주지 않는다");
    await evaluate(cdp, s, `(() => { const input = [...document.querySelectorAll('input')].find((i) => i.placeholder?.startsWith('예:')); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('button')].find((b) => b.textContent === '판형 바꾸기').click(); return true; })()`);
    await waitFor(cdp, s, "/1\\/3쪽을 바꿨어요/.test(document.querySelector('[role=status]')?.textContent ?? '')", "쪽 범위 다시 변환");
    console.log(`PASS ${width}×${height}: 변환 3/3쪽 249×254(재단 243×248), 미리보기 ${result.canvases.map((c) => c.join("x")).join(", ")}, 가로 넘침 없음, 터치 목표 44px 이상, 쪽 범위 오류 안내와 복구`);
  }
  // --- 1440×900 ---
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await cdp.send("Page.navigate", { url: `${BASE}/tools/pdf-resize` }, s);
  await waitFor(cdp, s, "document.readyState === 'complete' && !!document.querySelector('input[type=file]')", "화면 열기");
  await evaluate(cdp, s, UI);
  const choose = async (path) => { const { root } = await cdp.send("DOM.getDocument", {}, s); const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" }, s); await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] }, s); };
  for (const [name, expected] of [["notes.txt", /PDF 파일\(\.pdf\)을 골라/], ["broken.pdf", /PDF를 읽지 못했어요/], ["locked.pdf", /암호가 걸린 PDF/]]) {
    await choose(resolve(work, name));
    await waitFor(cdp, s, `${expected}.test(__ui.status())`, `${name} 안내`);
    assert.equal(await evaluate(cdp, s, "document.querySelector('button.primary').disabled"), true, `${name}: 바꾸기 단추는 꺼져 있다`);
  }
  await choose(samplePath);
  await waitFor(cdp, s, "/3쪽 · 210×210mm 3쪽/.test(document.body.innerText) && __ui.status() === ''", "올바른 파일로 회복");

  // 기본값(2026-11-03 사용자 결정): 스위트북 + 늘리기 + 도련 끝. 2% 남짓 눌림이라 경고는 없다.
  assert.deepEqual(await evaluate(cdp, s, "['mode', 'into'].map((n) => [...document.querySelectorAll('input[name=' + n + ']')].findIndex((r) => r.checked))"), [2, 1]);
  await evaluate(cdp, s, "__ui.convert(), true");
  await waitFor(cdp, s, "/3\\/3쪽을 바꿨어요/.test(__ui.status())", "기본값 변환");
  assert.deepEqual(await evaluate(cdp, s, "__ui.row()"), ["1", "210×210", "1.1857 / 1.2095", "249×254", "좌 2.53 · 우 2.53 · 위 2.48 · 아래 2.48", "없음"]);
  assert.equal(await evaluate(cdp, s, "document.querySelector('[role=note]')"), null, "2% 남짓은 경고하지 않는다");
  // 많이 눌리면 경고한다 (210×210 → 300×210 늘리기)
  await evaluate(cdp, s, "__ui.set(__ui.input('가로'), '300'), __ui.set(__ui.input('세로'), '210'), __ui.set(__ui.input('도련'), '0'), __ui.convert(), true");
  await waitFor(cdp, s, "/42\\.9% 눌려요/.test(document.querySelector('[role=note]')?.textContent ?? '')", "눌림 경고");
  // 스위트북을 다시 고르면 크기와 방식이 함께 돌아온다
  await evaluate(cdp, s, "__ui.radio('mode', 0); __ui.radio('into', 0); __ui.set(__ui.input('판형'), 'sweetbook'); true");
  assert.deepEqual(await evaluate(cdp, s, "[['가로','세로','도련'].map((l) => __ui.input(l).value), ['mode', 'into'].map((n) => [...document.querySelectorAll('input[name=' + n + ']')].findIndex((r) => r.checked))]"), [["243", "248", "3"], [2, 1]]);

  // 판형 고정본과 직접 입력
  await evaluate(cdp, s, "__ui.set(__ui.input('판형'), 'square210'), true");
  assert.deepEqual(await evaluate(cdp, s, "['가로','세로','도련'].map((l) => __ui.input(l).value)"), ["210", "210", "0"]);
  await evaluate(cdp, s, "__ui.set(__ui.input('가로'), '200'), true");
  assert.equal(await evaluate(cdp, s, "__ui.input('판형').value"), "custom", "숫자를 고치면 직접 입력으로 바뀐다");
  await evaluate(cdp, s, "__ui.set(__ui.input('판형'), 'sweetbook'), true");

  // 방식 조합: 표 값이 lib/pdf-resize.ts 계산과 같다 (210×210 → 243×248 + 도련 3)
  for (const [mode, into, scale, placed, cut, gap] of [
    [0, 0, "1.1571", "243×243", "없음", "좌 0 · 우 0 · 위 2.5 · 아래 2.5"],
    [1, 0, "1.181", "248×248", "좌 2.12 · 우 2.12 · 위 0 · 아래 0", "없음"],
    [1, 1, "1.2095", "254×254", "좌 4.55 · 우 4.55 · 위 2.48 · 아래 2.48", "없음"],
    [2, 0, "1.1571 / 1.181", "243×248", "없음", "없음"],
  ]) {
    await evaluate(cdp, s, `__ui.radio('mode', ${mode}); __ui.radio('into', ${into}); __ui.convert(); true`);
    await waitFor(cdp, s, "/3\\/3쪽을 바꿨어요/.test(__ui.status()) && document.querySelectorAll('.pdf-resize-previews canvas').length === 2", `방식 ${mode}/${into}`);
    assert.deepEqual(await evaluate(cdp, s, "__ui.row()"), ["1", "210×210", scale, placed, cut, gap]);
  }

  // 배경 끄기
  await evaluate(cdp, s, "__ui.input('배경 칠하지 않기').click(), true");
  assert.equal(await evaluate(cdp, s, "__ui.input('배경색').disabled"), true);
  assert.equal(await evaluate(cdp, s, "document.querySelector('a[download]')"), null, "설정을 바꾸면 옛 결과를 내린다");
  await evaluate(cdp, s, "__ui.convert(), true");
  await waitFor(cdp, s, "!!document.querySelector('a[download]') && document.querySelectorAll('.pdf-resize-previews canvas').length === 2", "배경 없이 변환");

  // 미리보기 쪽 바꾸기: 두 그림 모두 다시 그린다
  await sleep(500);
  const before = await evaluate(cdp, s, "[__ui.canvas(0), __ui.canvas(1)]");
  await evaluate(cdp, s, "__ui.set(document.querySelector('[aria-label=미리보기] input[type=number]'), '2'), true");
  await waitFor(cdp, s, `__ui.canvas(0) !== ${JSON.stringify(before[0])} && __ui.canvas(1) !== ${JSON.stringify(before[1])}`, "2쪽 미리보기");

  // 1440 배치: 넘침 없음, 미리보기 나란히
  assert.deepEqual(await evaluate(cdp, s, "(() => { const c = [...document.querySelectorAll('.pdf-resize-previews canvas')].map((e) => e.getBoundingClientRect()); return [document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0, Math.abs(c[0].top - c[1].top) < 2, c[1].left > c[0].right]; })()"), [true, true, true]);

  // 키보드만으로: Tab으로 모든 조작에 닿고 초점 테두리가 보인다
  await evaluate(cdp, s, "__ui.input('배경 칠하지 않기').click(), document.activeElement?.blur(), window.scrollTo(0, 0), true"); // 배경을 다시 켜야 색 고르기가 Tab 순서에 들어온다
  await evaluate(cdp, s, "__ui.convert(), true");
  await waitFor(cdp, s, "!!document.querySelector('a[download]')", "키보드 확인 전 변환");
  await evaluate(cdp, s, "document.activeElement?.blur(), window.scrollTo(0, 0), true");
  const reached = new Set();
  for (let i = 0; i < 40; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, s);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, s);
    const focus = await evaluate(cdp, s, "(() => { const e = document.activeElement, st = getComputedStyle(e); return [e.tagName + ':' + (e.type || '') + ':' + (e.name || e.textContent.trim().slice(0, 8)), st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0]; })()");
    if (focus[0].startsWith("BODY")) continue;
    assert.ok(focus[1], `초점 테두리 없음: ${focus[0]}`);
    reached.add(focus[0]);
  }
  for (const want of ["INPUT:file", "SELECT:select-one", "INPUT:radio:mode", "INPUT:radio:into", "INPUT:radio:source-bleed", "INPUT:color", "INPUT:checkbox", "BUTTON:submit:판형 바꾸기", "INPUT:number", "A::PDF 내려받기"])
    assert.ok([...reached].some((r) => r.startsWith(want)), `Tab으로 닿지 않음: ${want} (닿은 것: ${[...reached].join(", ")})`);
  if (process.env.PDF_RESIZE_SCREENSHOTS) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, s);
    writeFileSync(resolve(process.env.PDF_RESIZE_SCREENSHOTS, "pdf-resize-1440x900.png"), Buffer.from(shot.data, "base64"));
  }
  console.log(`PASS 1440×900: 기본값 늘리기·도련 끝, 눌림 경고, 잘못된·손상·암호 파일 안내와 회복, 판형 고정본·직접 입력, 방식 4조합 표 값, 배경 끄기, 미리보기 쪽 바꾸기, 나란한 미리보기, Tab ${reached.size}곳 초점 테두리`);

  if (BIG) {
    await evaluate(cdp, s, "location.reload(), true"); await sleep(500);
    await waitFor(cdp, s, "document.readyState === 'complete' && !!document.querySelector('input[type=file]')", "큰 파일 화면");
    await evaluate(cdp, s, UI);
    const t0 = Date.now(); await choose(resolve(BIG));
    await waitFor(cdp, s, "/쪽 · /.test(document.querySelector('.book-muted')?.textContent ?? '')", "큰 파일 읽기", 180000);
    const t1 = Date.now(); await evaluate(cdp, s, "__ui.convert(), true");
    await waitFor(cdp, s, "!!document.querySelector('a[download]')", "큰 파일 변환", 180000);
    const t2 = Date.now();
    await waitFor(cdp, s, "__ui.painted(0) && __ui.painted(1)", "큰 파일 미리보기", 180000);
    const t3 = Date.now(); const first = await evaluate(cdp, s, "__ui.canvas(1)");
    await evaluate(cdp, s, "__ui.set(document.querySelector('[aria-label=미리보기] input[type=number]'), '100'), true");
    await waitFor(cdp, s, `__ui.painted(1) && __ui.canvas(1) !== ${JSON.stringify(first)}`, "큰 파일 100쪽 미리보기", 180000);
    const t4 = Date.now(); const heap = await evaluate(cdp, s, "Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6)");
    console.log(`BIG ${BIG.split("/").pop()}: 읽기 ${(t1 - t0) / 1000}s, 변환 ${(t2 - t1) / 1000}s, 미리보기 ${(t3 - t2) / 1000}s, 100쪽으로 이동 ${(t4 - t3) / 1000}s, JS 힙 ${heap}MB, 상태 "${await evaluate(cdp, s, "__ui.status()")}"`);
  }
  assert.deepEqual(cdp.errors, [], "페이지 오류");
  socket.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
