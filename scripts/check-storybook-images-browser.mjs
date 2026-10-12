// Production build + isolated test DB. Uses Chrome's real clipboard, not a fake paste handler.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {startTestServer} from '../tests/harness/server.mjs';
import {sha256} from '../lib/token-crypto.ts';
const {chromium}=createRequire(import.meta.url)(process.env.BOOK_PLAYWRIGHT_MODULE||'playwright');
const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});await server.fetch('/api/student');
const token=randomUUID(),student='student_imagecheck',room='class_imagecheck',expiresAt=new Date(Date.now()+3600000).toISOString();
await server.DB.batch([
 server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('teacher_imagecheck','imagecheck@example.test','교사')"),
 server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES(?,'teacher_imagecheck','그림 검증반','1738',?)").bind(room,randomUUID()),
 server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at) VALUES(?,?,'봄이','cat',CURRENT_TIMESTAMP)").bind(student,room),
 server.DB.prepare('INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').bind(await sha256(token),student,expiresAt),
]);
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
const id=(await(await server.fetch('/api/storybooks',{method:'POST',headers,body:'{}'})).json()).storybook.id;
const rgb=Buffer.alloc(300*240*3,255);
for(let y=55;y<185;y++)for(let x=65;x<235;x++){const i=(y*300+x)*3;rgb[i]=30;rgb[i+1]=105;rgb[i+2]=190;}
const png=await sharp(rgb,{raw:{width:300,height:240,channels:3}}).png().toBuffer();
// Simulate originals retained after deleting pictures or saving new cutouts. The
// first visible paste reaches 60 stored assets; saving its cutout crosses that limit.
const retainedUpload=await server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{...headers,'content-type':'image/png'},body:png});
assert.equal(retainedUpload.status,201);
const retainedId=(await retainedUpload.json()).asset.id;
const retained=await server.DB.prepare('SELECT object_key FROM storybook_assets WHERE id=?').bind(retainedId).first();
await server.DB.batch(Array.from({length:58},(_,i)=>server.DB.prepare("INSERT INTO storybook_assets(id,storybook_id,student_id,source_type,object_key,content_type,byte_size) VALUES(?,?,?,'upload',?,'image/png',?)").bind(`asset_retained${String(i).padStart(8,'0')}`,id,student,retained.object_key,png.length)));
const output='work/storybook-images';await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOOK_CHROME_PATH||undefined,headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true,permissions:['clipboard-read','clipboard-write']});
 await context.addInitScript(({student,token,expiresAt})=>{localStorage.setItem('wiggle.deviceProfiles.v2',JSON.stringify([{studentId:student,nickname:'봄이',animal:'cat',classroomName:'검증'}]));sessionStorage.setItem('wiggle.activeSession.v2',JSON.stringify({studentId:student,deviceToken:token,expiresAt}));},{student,token,expiresAt});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const btn=name=>page.getByRole('button',{name,exact:true});
 const saved=()=>page.waitForFunction(()=>document.querySelector('.storybook-save-state')?.textContent.includes('✓ 저장됨'));
 const image=()=>page.locator('.storybook-stage:not(.preview) .storybook-stage-element.image').last();
 const geometry=()=>image().evaluate(el=>Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(el.style[k])/100])));
 const range=async(name,value)=>page.getByRole('slider',{name,exact:true}).evaluate((el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);
 const clipboard=async()=>page.evaluate(async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);},png.toString('base64'));
 const stored=async()=>JSON.parse((await server.DB.prepare('SELECT document_json FROM storybooks WHERE id=?').bind(id).first()).document_json);
 await page.goto(server.origin+'/student/books/'+id);await page.getByRole('textbox',{name:'이 쪽의 이야기',exact:true}).waitFor();
 await clipboard();await page.keyboard.press('Control+v');await image().waitFor();await saved();
 assert.equal(await image().count(),1);const original=(await stored()).pages[0].elements.find(e=>e.type==='image');
 assert.equal((await server.DB.prepare('SELECT count(*) AS n FROM storybook_assets WHERE storybook_id=?').bind(id).first()).n,60,'one visible picture with 60 retained assets');
 const originalBytes=Buffer.from(await(await server.fetch(`/api/storybooks/${id}/assets/${original.assetId}`,{headers})).arrayBuffer());
 const before=await geometry();await btn('＋ 크게').click();const larger=await geometry();assert.ok(larger.width>before.width);assert.ok(Math.abs(larger.width/larger.height-before.width/before.height)<.01);
 await page.getByRole('checkbox',{name:'비율 유지',exact:true}).uncheck();await range('그림 크기',.45);await range('그림 세로 크기',.2);let g=await geometry();assert.ok(Math.abs(g.width-.45)<.01&&Math.abs(g.height-.2)<.01);
 // Actual mouse resize and drag above the former y=.24 image boundary.
 const handle=page.locator('.storybook-moveable .moveable-se').first();await handle.waitFor();await handle.scrollIntoViewIfNeeded();let box=await handle.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+65,box.y+box.height/2+35,{steps:8});await page.mouse.up();
 const resized=await geometry();assert.ok(resized.width>g.width+.02&&resized.height>g.height+.02,`real corner resize changes both axes: ${JSON.stringify({g,resized,box})}`);
 const stage=await page.locator('.storybook-stage:not(.preview)').boundingBox();box=await image().boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,stage.y+stage.height*.12+box.height/2,{steps:10});await page.mouse.up();
 g=await geometry();assert.ok(g.top<.2,`image can use upper page: ${g.top}`);await saved();
 await page.screenshot({path:output+'/image-tools.png',fullPage:true});
 await btn('✂️ 배경 지우기').click();const canvas=page.getByRole('img',{name:'캐릭터 오리기 작업 그림',exact:true});await btn('이 그림 넣기').waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.image-cutout-modal button')).find(b=>b.textContent==='이 그림 넣기')?.disabled);
 const alpha=()=>canvas.evaluate(el=>{const data=el.getContext('2d').getImageData(0,0,el.width,el.height).data;return {corner:data[3],center:data[(Math.floor(el.height/2)*el.width+Math.floor(el.width/2))*4+3]};});
 assert.deepEqual(await alpha(),{corner:0,center:255});await page.screenshot({path:output+'/cutout-preview.png',fullPage:true});
 await page.locator('.image-cutout-modal').getByRole('button',{name:'↶ 되돌리기',exact:true}).click();assert.deepEqual(await alpha(),{corner:255,center:255});
 await btn('✨ 배경 자동 지우기').click();assert.deepEqual(await alpha(),{corner:0,center:255});
 await btn('🧽 지우개').click();box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5,{steps:2});await page.mouse.up();assert.equal((await alpha()).center,0);
 await btn('🩹 다시 살리기').click();await canvas.click({position:{x:box.width/2,y:box.height/2}});assert.equal((await alpha()).center,255);await page.keyboard.press('Control+z');assert.equal((await alpha()).center,0);
 const documentBeforeUndo=await stored();await page.keyboard.press('Control+z');assert.equal((await alpha()).center,255);assert.deepEqual(await stored(),documentBeforeUndo,'cutout undo never undoes book edits');
 await btn('닫기').click();assert.equal((await stored()).pages[0].elements.find(e=>e.type==='image').assetId,original.assetId,'cancel preserves original');
 await btn('✂️ 배경 지우기').click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.image-cutout-modal button')).find(b=>b.textContent==='이 그림 넣기')?.disabled);await btn('이 그림 넣기').click();await page.locator('.image-cutout-modal').waitFor({state:'hidden'});await saved();
 let newDoc=await stored(),cut=newDoc.pages[0].elements.find(e=>e.type==='image');assert.notEqual(cut.assetId,original.assetId);
 assert.equal((await server.DB.prepare('SELECT count(*) AS n FROM storybook_assets WHERE storybook_id=?').bind(id).first()).n,61,'cutout succeeds beyond 60 without deleting originals');
 assert.deepEqual(Buffer.from(await(await server.fetch(`/api/storybooks/${id}/assets/${original.assetId}`,{headers})).arrayBuffer()),originalBytes);
 const cutBytes=Buffer.from(await(await server.fetch(`/api/storybooks/${id}/assets/${cut.assetId}`,{headers})).arrayBuffer());const {data,info}=await sharp(cutBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(data[3],0);assert.equal(data[(Math.floor(info.height/2)*info.width+Math.floor(info.width/2))*4+3],255);
 const uncut=documentBeforeUndo.pages[0].elements.find(e=>e.type==='image');assert.ok(Math.abs(cut.width*300/info.width-uncut.width)<.001&&Math.abs(cut.height*240/info.height-uncut.height)<.001,'background removal preserves the stretched picture scale');
 await page.reload();await image().waitFor();assert.deepEqual(await stored(),newDoc,'reload preserves pasted/cut/resized document');
 // Normal text pasting still targets the story, without adding an image.
 const text=page.getByRole('textbox',{name:'이 쪽의 이야기',exact:true});await text.click();await page.evaluate(()=>navigator.clipboard.writeText('붙여넣은 이야기'));await page.keyboard.press('Control+v');assert.equal(await text.inputValue(),'붙여넣은 이야기');await saved();
 await btn('꾸미기 닫기').click();await clipboard();await btn('📋 그림 붙여넣기').click();await page.waitForFunction(()=>document.querySelectorAll('.storybook-stage:not(.preview) .image').length===2);await saved();
 // A delayed image upload stays on the original page even if the child moves to another page.
 let release,started;const held=new Promise(r=>{release=r;}),begun=new Promise(r=>{started=r;});
 await page.route(`**/api/storybooks/${id}/assets`,async route=>{if(route.request().method()==='POST'){started();await held;}await route.continue();});
 await clipboard();await page.keyboard.press('Control+v');await begun;await page.getByRole('button',{name:/쪽 추가/}).click();release();await saved();await page.waitForTimeout(700);await saved();await page.unroute(`**/api/storybooks/${id}/assets`);
 newDoc=await stored();assert.equal(newDoc.pages[0].elements.filter(e=>e.type==='image').length,3);assert.equal(newDoc.pages[1].elements.filter(e=>e.type==='image').length,0);
 await page.locator('.storybook-page-rail>button').first().click();
 for(const [width,height]of [[320,568],[390,844],[844,390],[768,1024],[820,1180],[1180,820]]){
  console.log('Checking touch tools and resize',width,height);
  if(await btn('꾸미기 닫기').count())await btn('꾸미기 닫기').click();await page.setViewportSize({width,height});if(!await btn('그림 도구 열기').count())await image().tap();
  if(await btn('그림 도구 열기').count())await btn('그림 도구 열기').click();
  assert.ok(await btn('✂️ 배경 지우기').isVisible());await page.getByRole('checkbox',{name:'비율 유지',exact:true}).uncheck();await range('그림 크기',.65);await range('그림 세로 크기',.6);await btn('− 작게').click();await saved();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await btn('✂️ 배경 지우기').click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.image-cutout-modal button')).find(b=>b.textContent==='이 그림 넣기')?.disabled);
  await btn('🧽 지우개').scrollIntoViewIfNeeded();await btn('🧽 지우개').tap();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.cutout-tool-buttons button')).find(b=>b.textContent==='🧽 지우개')?.getAttribute('aria-pressed')==='true');await page.locator('.image-cutout-modal').getByRole('button',{name:'↶ 되돌리기',exact:true}).tap();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:output+`/cutout-${width}.png`,fullPage:true});await btn('닫기').tap();
  await page.locator('.image-cutout-modal').waitFor({state:'hidden'});await btn('꾸미기 닫기').click();await page.waitForTimeout(100);
  const resizeHandle=page.locator('.storybook-moveable .moveable-se').first();await resizeHandle.scrollIntoViewIfNeeded();
  const touchBefore=await geometry(),touchHandle=await resizeHandle.boundingBox();
  const cdp=await context.newCDPSession(page),x=touchHandle.x+touchHandle.width/2,y=touchHandle.y+touchHandle.height/2;
  assert.ok(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('.moveable-control'),{x,y}),`resize handle reachable ${width} at ${x},${y}`);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let step=1;step<=6;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-24*step/6,y:y-18*step/6,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  const touchAfter=await geometry();assert.ok(touchAfter.width<touchBefore.width-.005&&touchAfter.height<touchBefore.height-.005,`touch resize ${width}: ${JSON.stringify({touchBefore,touchAfter})}`);await saved();
 }
 // Copy a selected image in another web page with actual Ctrl+C, then Ctrl+V here.
 if(await btn('꾸미기 닫기').count())await btn('꾸미기 닫기').click();
 const imageCount=await page.locator('.storybook-stage:not(.preview) .image').count();
 const source=await context.newPage();await source.goto(server.origin+'/privacy');
 await source.setContent(`<div contenteditable="true"><img src="data:image/png;base64,${png.toString('base64')}"></div>`);
 await source.locator('div').focus();await source.evaluate(()=>{const range=document.createRange();range.selectNode(document.querySelector('img'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
 await source.keyboard.press('Control+c');await source.close();await page.bringToFront();await page.keyboard.press('Control+v');
 await page.waitForFunction(count=>document.querySelectorAll('.storybook-stage:not(.preview) .image').length===count+1,imageCount);await saved();
 // Re-selecting the same file after the old lifetime limit must still fire onChange.
 for(let i=0;i<2;i++){
  await page.locator('input[type=file]').first().setInputFiles({name:'같은 그림.png',mimeType:'image/png',buffer:png});
  await page.waitForFunction(count=>document.querySelectorAll('.storybook-stage:not(.preview) .image').length===count,imageCount+2+i);await saved();
 }
 const afterUploads=await stored();await page.reload();await image().waitFor();
 assert.deepEqual(await stored(),afterUploads);
 assert.equal(await page.locator('.storybook-stage:not(.preview) .image').count(),imageCount+3);
 assert.deepEqual(Buffer.from(await(await server.fetch(`/api/storybooks/${id}/assets/${retainedId}`,{headers})).arrayBuffer()),png,'retained originals are never cleaned up to make room');
 assert.deepEqual(errors,[]);console.log('PASS beyond 60 retained images: actual clipboard/file uploads, repeated same-file selection, cutout save and original preservation, reload, delayed upload page identity, sizing and six viewport sizes');
}finally{await browser.close();await server.dispose();}
