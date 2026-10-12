import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startTestServer} from './harness/server.mjs';
import {seedManyImagesBook} from './harness/storybook-many-images.mjs';

test('HTTP: 20 students each save 1,000 pictures, add more and reopen without a per-page quota', async t => {
 const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});
 t.after(()=>server.dispose());await server.fetch('/api/student');
 const books=[];
 for(let i=0;i<20;i++)books.push(await seedManyImagesBook(server,i));
 const save=(book,document,revision,complete=false)=>server.fetch(`/api/storybooks/${book.id}`,{method:'PUT',headers:book.headers,body:JSON.stringify({requestId:'save_'+randomUUID(),expectedRevision:revision,title:'그림을 많이 넣은 책',document,complete})});
 await Promise.all(books.map(async book=>{
  const saved=await save(book,book.document,0);assert.equal(saved.status,200,await saved.clone().text());
  const uploaded=await server.fetch(`/api/storybooks/${book.id}/assets`,{method:'POST',headers:{...book.headers,'content-type':'image/png'},body:book.png});assert.equal(uploaded.status,201);
  const asset=(await uploaded.json()).asset;
  book.document.pages[0].elements.push({...book.document.pages[0].elements[1],id:'element_'+randomUUID().replaceAll('-',''),assetId:asset.id,zIndex:201});
  const edited=await save(book,book.document,1,true);assert.equal(edited.status,200,await edited.clone().text());
  const reopened=await server.fetch(`/api/storybooks/${book.id}`,{headers:book.headers});assert.equal(reopened.status,200);
  const data=await reopened.json();assert.deepEqual(data.storybook.document,book.document);assert.equal(data.assets.length,1001);assert.equal(data.storybook.status,'complete');
  assert.equal(data.storybook.document.pages[0].elements.filter(el=>el.type==='image').length,201);
  assert.deepEqual(Buffer.from(await(await server.fetch(`/api/storybooks/${book.id}/assets/${book.assetIds[0]}`,{headers:book.headers})).arrayBuffer()),book.png);
 }));
 // Large books retain ownership checks, and a complete-book copy keeps every picture.
 const [first,second]=books;
 const forbidden=structuredClone(first.document);forbidden.pages[0].elements[1].assetId=second.assetIds[0];
 assert.equal((await save(first,forbidden,2)).status,403);
 const copyId='storybook_'+randomUUID().replaceAll('-','');
 const duplicate=await server.fetch(`/api/storybooks/${first.id}/duplicate`,{method:'POST',headers:first.headers,body:JSON.stringify({copyId})});assert.equal(duplicate.status,201,await duplicate.clone().text());
 const copied=(await(await server.fetch(`/api/storybooks/${copyId}`,{headers:first.headers})).json()).storybook;
 assert.equal(copied.document.pages.flatMap(page=>page.elements).filter(el=>el.type==='image').length,1001);
 const assets=(await(await server.fetch(`/api/storybooks/${copyId}`,{headers:first.headers})).json()).assets;
 const copyAssetIds=new Set(assets.map(asset=>asset.id));
 for(const page of copied.document.pages)for(const element of page.elements)if(element.type==='image')assert.ok(copyAssetIds.has(element.assetId));
 assert.deepEqual((await(await server.fetch(`/api/storybooks/${first.id}`,{headers:first.headers})).json()).storybook.document,first.document);
});
