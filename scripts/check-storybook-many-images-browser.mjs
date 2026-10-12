// Real editor interactions with an isolated book containing 1,000 image elements.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {startTestServer} from '../tests/harness/server.mjs';
import {seedManyImagesBook} from '../tests/harness/storybook-many-images.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.BOOK_PLAYWRIGHT_MODULE||'playwright');
const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});
let browser;
try{
 await server.fetch('/api/student');const book=await seedManyImagesBook(server,0);
 const initial=await server.fetch(`/api/storybooks/${book.id}`,{method:'PUT',headers:book.headers,body:JSON.stringify({requestId:'save_'+randomUUID(),expectedRevision:0,title:'천 개 그림 검증',document:book.document})});assert.equal(initial.status,200);
 browser=await chromium.launch({executablePath:process.env.BOOK_CHROME_PATH||undefined,headless:true});
 const context=await browser.newContext({viewport:{width:820,height:1180},hasTouch:true,permissions:['clipboard-read','clipboard-write']});
 await context.addInitScript(({student,token,expiresAt})=>{
  localStorage.setItem('wiggle.deviceProfiles.v2',JSON.stringify([{studentId:student,nickname:'봄이',animal:'cat',classroomName:'검증'}]));
  sessionStorage.setItem('wiggle.activeSession.v2',JSON.stringify({studentId:student,deviceToken:token,expiresAt}));
 },book);
 const page=await context.newPage();page.setDefaultTimeout(25000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const btn=name=>page.getByRole('button',{name,exact:true});
 const pictures=()=>page.locator('.storybook-stage:not(.preview) .storybook-stage-element.image');
 const count=expected=>page.waitForFunction(n=>document.querySelectorAll('.storybook-stage:not(.preview) .storybook-stage-element.image').length===n,expected);
 const saved=()=>page.waitForFunction(()=>document.querySelector('.storybook-save-state')?.textContent.includes('✓ 저장됨'));
 const stored=async()=>(await(await server.fetch(`/api/storybooks/${book.id}`,{headers:book.headers})).json()).storybook.document;
 const visibleImagesLoaded=()=>page.waitForFunction(()=>[...document.querySelectorAll('.storybook-stage:not(.preview) .storybook-stage-element.image')].every(el=>{const image=el.querySelector('img');return image?.complete&&image.naturalWidth>0;}));
 await page.goto(server.origin+'/student/books/'+book.id);await count(200);await visibleImagesLoaded();
 await btn('2쪽').click();await count(200);await visibleImagesLoaded();await btn('1쪽').click();await count(200);
 await page.locator('input[type=file]').first().setInputFiles({name:'추가 그림.png',mimeType:'image/png',buffer:book.png});await count(201);await saved();
 await page.evaluate(async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);},book.png.toString('base64'));
 await page.keyboard.press('Control+v');await count(202);await saved();
 await btn('복제').click();await count(203);await saved();
 await btn('↶ 되돌리기').click();await count(202);await btn('↷ 다시하기').click();await count(203);await saved();
 await btn('이야기 칸 추가').click();await saved();assert.equal((await stored()).pages[0].elements.filter(el=>el.type==='text').length,2);
 await btn('쪽 양식·배경').click();
 // Template fields and PDF/background conversion must also work on a dense page.
 await btn('겉표지').click();await saved();
 assert.ok((await stored()).pages[0].elements.some(el=>el.textRole==='credit'));
 await page.locator('input[type=file]').nth(1).setInputFiles({name:'배경.png',mimeType:'image/png',buffer:book.png});await saved();
 await btn('배경을 그림으로 편집').click();await count(204);await saved();
 const after=await stored();assert.equal(after.pages[0].backgroundAssetId,undefined);
 for(const original of book.document.pages[0].elements.filter(el=>el.type==='image'))assert.deepEqual(after.pages[0].elements.find(el=>el.id===original.id),original);
 await page.reload();await count(204);await visibleImagesLoaded();assert.deepEqual(await stored(),after);
 await mkdir('work/storybook-many-images',{recursive:true});
 for(const [width,height] of [[768,1024],[820,1180],[1180,820]]){
  await page.setViewportSize({width,height});
  await pictures().last().tap();await btn('＋ 크게').click();await saved();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`work/storybook-many-images/${width}-${height}.png`,fullPage:true});
 }
 await btn('미리보기').click();await page.locator('.storybook-reader').waitFor();await btn('다음 쪽').click();
 await page.waitForFunction(()=>!document.querySelector('.reader-turn'));await btn('편집으로 돌아가기').click();await count(204);
 assert.equal((await stored()).pages.flatMap(p=>p.elements).filter(el=>el.type==='image').length,1004);
 assert.deepEqual(Buffer.from(await(await server.fetch(`/api/storybooks/${book.id}/assets/${book.assetIds[0]}`,{headers:book.headers})).arrayBuffer()),book.png);
 assert.deepEqual(errors,[]);
 console.log('PASS 1,000-picture book: 200+ pictures on one page, actual upload/paste/duplicate/undo/redo/text/template/background conversion/reload/preview and three tablet sizes');
}finally{await browser?.close();await server.dispose();}
