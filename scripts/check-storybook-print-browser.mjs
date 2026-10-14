// Isolated local browser regression: never accesses a real class, DB or bucket.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {PDFDocument,PDFName,PDFDict,PDFRawStream} from 'pdf-lib';
import {startTestServer} from '../tests/harness/server.mjs';
import {emptyStorybookDocument} from '../lib/storybook-model.ts';
const {chromium}=createRequire(import.meta.url)(process.env.BOOK_PLAYWRIGHT_MODULE||'playwright');
const chrome=process.env.BOOK_CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});
const browser=await chromium.launch({executablePath:chrome,headless:true});
const out='work/storybook-print';await mkdir(out,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:1100}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const doc=emptyStorybookDocument();
 doc.pages=Array.from({length:26},(_,i)=>{
 const p=emptyStorybookDocument('squarebook-hc','page_fixture'+String(i).padStart(8,'0'),'element_fixture'+String(i).padStart(8,'0')).pages[0];
 p.elements[0].text='예시 이야기 '+(i+1)+'쪽';
 p.elements.push({id:'element_picture'+String(i).padStart(8,'0'),type:'image',assetId:'asset_fixture'+String(i).padStart(8,'0'),x:.1,y:.3,width:.8,height:.6,rotation:0,zIndex:1,opacity:1,locked:false});return p;
 });
 // A repeated picture and a page background must both be counted and decoded.
 doc.pages[25].backgroundAssetId=doc.pages[0].elements[1].assetId;
 const book={id:'book_print',classroomId:'class_print',classroomName:'검증 학급',studentId:'student_print',nickname:'검증 학생',animal:'🐰',title:'PDF 로딩 검증',completedAt:new Date().toISOString(),document:doc};
 const assets=doc.pages.map(p=>({id:p.elements[1].assetId,sourceType:'upload',contentType:'image/png'}));
 const png=await readFile('public/landing-gallery/artwork-whale.png');
 let release;const held=new Promise(r=>release=r);const requests=[];
 let mode='delay';
 await page.route('**/api/teacher/storybooks/book_print',route=>route.fulfill({json:{storybook:book,assets:mode==='missing'?assets.filter(a=>a.id!==assets[18].id):assets}}));
 await page.route('**/api/teacher/storybooks/book_print/assets/*',async route=>{
 const id=route.request().url().split('/').at(-1);requests.push(id);
 if(mode==='delay'&&[assets[14].id,assets[18].id].includes(id))await held;
 if(mode==='error'&&id===assets[14].id)return route.fulfill({status:404,json:{error:'test missing object'}});
 if(mode==='error'&&id===assets[18].id)return route.fulfill({contentType:'image/png',body:'not a decodable image'});
 if(mode==='background'&&id===assets[0].id)return route.fulfill({status:500,json:{error:'test background failure'}});
 if(mode==='timeout'&&id===assets[14].id)return; // deliberately stalled local route
 await route.fulfill({contentType:'image/png',body:png});
 });
 await page.addInitScript(()=>{window.printCalls=[];window.print=()=>{window.printCalls.push({loading:document.querySelectorAll('.teacher-print-pages [data-image-state]').length,images:[...document.querySelectorAll('.teacher-print-pages img')].filter(i=>i.complete&&i.naturalWidth>0).length});};});
 const url=server.origin+'/teacher/class/class_print/books/book_print';
 const button=page.getByRole('button',{name:'PDF로 저장 · 인쇄',exact:true});
 const ready=()=>page.waitForFunction(()=>document.querySelector('.teacher-book-preview-shell')?.dataset.printReady==='true');
 await page.goto(url);await page.waitForFunction(()=>document.querySelectorAll('.teacher-print-pages img').length===25);
 assert.equal(await button.isDisabled(),true);
 await button.evaluate(el=>el.click());assert.deepEqual(await page.evaluate(()=>window.printCalls),[]);
 await page.emulateMedia({media:'print'});
 assert.equal(await page.locator('.teacher-print-pages').isVisible(),false);
 assert.equal(await page.locator('.teacher-print-blocked').isVisible(),true);
 await page.screenshot({path:out+'/loading-print-guard.png'});
 await page.emulateMedia({media:'screen'});
 release();await ready();await button.click();
 assert.deepEqual(await page.evaluate(()=>window.printCalls),[{loading:0,images:27}]);
 assert.equal(requests.filter(id=>id===assets[0].id).length,2,'current preview + shared print cache (including repeated background)');
 await page.emulateMedia({media:'print'});
 assert.equal(await page.locator('.teacher-print-blocked').isVisible(),false);
 const pdfBytes=await page.pdf({path:out+'/complete-26-pages.pdf',format:'A4',printBackground:true});
 const pdf=await PDFDocument.load(pdfBytes);assert.equal(pdf.getPageCount(),26);
 for(const [index,p]of pdf.getPages().entries()){
 const xobjects=p.node.Resources()?.lookup(PDFName.of('XObject'),PDFDict);
 assert.ok(xobjects&&xobjects.values().some(ref=>{const obj=pdf.context.lookup(ref);return obj instanceof PDFRawStream&&obj.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&Number(obj.dict.get(PDFName.of('Width'))?.toString())>100;}),'page '+(index+1)+' must contain the actual illustration');
 }
 await page.locator('.teacher-print-pages>article').nth(14).screenshot({path:out+'/ready-page-15.png'});
 await page.emulateMedia({media:'screen'});
 console.log('PASS delayed pages 15/19 block print; native print guard; 26 PDF pages each embed illustration; repeated/background images');
 mode='error';await page.reload();await page.getByRole('alert').filter({hasText:'15·19쪽'}).waitFor();assert.equal(await button.isDisabled(),true);
 await page.setViewportSize({width:320,height:568});await page.screenshot({path:out+'/error-320x568.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 mode='ok';await page.getByRole('button',{name:'인쇄 준비 다시 시도'}).click();await ready();await button.click();assert.deepEqual(await page.evaluate(()=>window.printCalls),[{loading:0,images:27}]);
 console.log('PASS HTTP 404 and corrupt image report page numbers; retry decodes all images before print');
 mode='background';await page.reload();await page.getByRole('alert').filter({hasText:'1·26쪽'}).waitFor();assert.equal(await button.isDisabled(),true);
 console.log('PASS shared failed image reports both illustration and background pages');
 mode='missing';await page.reload();await page.getByRole('alert').filter({hasText:'19쪽'}).waitFor();assert.equal(await button.isDisabled(),true);
 console.log('PASS absent asset metadata blocks incomplete print');
 // Advance the readiness timer with the browser clock, without a real minute wait.
 mode='timeout';await page.clock.install();await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.teacher-print-pages img').length===26);await page.clock.fastForward(61000);
 await page.getByRole('alert').filter({hasText:'15쪽'}).waitFor();assert.equal(await button.isDisabled(),true);
 mode='ok';await page.getByRole('button',{name:'인쇄 준비 다시 시도'}).click();await ready();await page.clock.resume();
 console.log('PASS stalled response timeout and retry');
 await page.addInitScript(()=>{
   if(sessionStorage.getItem('holdPrintFonts')!=='yes')return;
   const original=document.fonts.ready;
   const held=new Promise(resolve=>{window.releasePrintFonts=()=>original.then(resolve);});
   Object.defineProperty(document.fonts,'ready',{get:()=>held});
 });
 await page.evaluate(()=>sessionStorage.setItem('holdPrintFonts','yes'));await page.reload();
 await page.waitForFunction(()=>document.querySelector('.teacher-print-status')?.textContent.includes('27/27개'));
 assert.equal(await button.isDisabled(),true);
 await page.evaluate(()=>{sessionStorage.removeItem('holdPrintFonts');window.releasePrintFonts();});await ready();
 console.log('PASS fonts readiness also gates printing after every image is ready');
 for(const [width,height]of [[320,568],[390,844],[844,390],[768,1024],[820,1180],[1180,820]]){
 await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await button.isEnabled(),true);
 await page.screenshot({path:out+`/ready-${width}x${height}.png`});
 }
 // Text-only books must not wait for a nonexistent image.
 doc.pages=doc.pages.slice(0,1);doc.pages[0].elements=doc.pages[0].elements.filter(e=>e.type==='text');await page.reload();await ready();assert.equal(await page.locator('.teacher-print-pages img').count(),0);
 assert.deepEqual(errors,[]);
 await writeFile(out+'/result.json',JSON.stringify({passed:true,pdfPages:26,imagesInPrintTree:27,checks:['delay','native-print-guard','decoded-pdf-images','background','duplicate','404','corrupt-png','retry','missing-metadata','timeout','6-viewports','text-only']},null,2));
 console.log('PASS six viewport widths and text-only book; no page errors');
}finally{await browser.close();await server.dispose();}
