// /tools/pdf-resize 시험 화면을 실제 Chrome(CDP)으로 확인한다: 파일 선택 → 판형 바꾸기 → 미리보기·표·내려받기,
// 그리고 내려받은 PDF의 쪽 크기. 320×568·390×844·844×390에서 가로 넘침과 44px 미만 터치 목표를 잰다.
// 화면 캡처: PDF_RESIZE_SCREENSHOTS=<폴더>
// 사용: npm run build && npx next start -p 3299 & node scripts/check-pdf-resize-browser.mjs http://localhost:3299
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, rgb } from "pdf-lib";

const BASE = process.argv[2];
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
writeFileSync(samplePath, await sample.save());

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
  assert.deepEqual(cdp.errors, [], "페이지 오류");
  socket.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
