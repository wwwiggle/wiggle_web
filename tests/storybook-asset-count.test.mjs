import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {startTestServer} from './harness/server.mjs';
import {sha256} from '../lib/token-crypto.ts';
import {emptyStorybookDocument} from '../lib/storybook-model.ts';

test('HTTP: a book with 60 stored images can add, reuse and save more without changing old images', async t => {
 const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});
 t.after(()=>server.dispose());await server.fetch('/api/student');
 const token=randomUUID(),otherToken=randomUUID(),expires=new Date(Date.now()+3600000).toISOString();
 await server.DB.batch([
  server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('assetcount_teacher','assetcount@example.test','교사')"),
  server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('assetcount_class','assetcount_teacher','반','1748','assetcount_join')"),
  ...['assetcount_student','assetcount_other'].map(id=>server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at) VALUES(?,'assetcount_class','별','cat',CURRENT_TIMESTAMP)").bind(id)),
  server.DB.prepare('INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').bind(await sha256(token),'assetcount_student',expires),
  server.DB.prepare('INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').bind(await sha256(otherToken),'assetcount_other',expires),
 ]);
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 const created=await server.fetch('/api/storybooks',{method:'POST',headers,body:'{}'});assert.equal(created.status,201);
 const id=(await created.json()).storybook.id;
 const png=await sharp({create:{width:20,height:20,channels:3,background:'#45aa66'}}).png().toBuffer();
 const upload=body=>server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{...headers,'content-type':'image/png'},body});
 const first=await upload(png);assert.equal(first.status,201);
 const original=(await first.json()).asset;
 const assetRow=await server.DB.prepare('SELECT * FROM storybook_assets WHERE id=?').bind(original.id).first();
 // Stored originals/old cutouts survive deleting their page element. Only one is visible.
 await server.DB.batch(Array.from({length:59},(_,i)=>server.DB.prepare("INSERT INTO storybook_assets(id,storybook_id,student_id,source_type,object_key,content_type,byte_size) VALUES(?,?,'assetcount_student','upload',?,'image/png',?)").bind(`asset_retained${String(i).padStart(8,'0')}`,id,assetRow.object_key,png.length)));
 const document=emptyStorybookDocument();
 const image=(assetId,index)=>({id:`element_count${String(index).padStart(8,'0')}`,type:'image',assetId,x:.1,y:.3,width:.4,height:.4,rotation:0,zIndex:index,opacity:1,locked:false});
 document.pages[0].elements.push(image(original.id,0));
 await server.DB.prepare('UPDATE storybooks SET document_json=? WHERE id=?').bind(JSON.stringify(document),id).run();
 const oldAssets=(await server.DB.prepare('SELECT * FROM storybook_assets WHERE storybook_id=? ORDER BY id').bind(id).all()).results;
 assert.equal(oldAssets.length,60);
 const next=await upload(png);assert.equal(next.status,201,await next.clone().text());
 const added=(await next.json()).asset;
 assert.notEqual(added.id,original.id);
 // Importing a completed artwork and reusing it must work beyond 60, too.
 await server.DB.prepare("INSERT INTO artworks(id,student_id,classroom_id,title,topic,learning_mode,ops_json,status,final_image_key) VALUES('artwork_assetcount','assetcount_student','assetcount_class','그림','집','free','{}','complete',?)").bind(assetRow.object_key).run();
 const importArtwork=()=>server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers,body:JSON.stringify({sourceType:'artwork',artworkId:'artwork_assetcount'})});
 const imported=await importArtwork();assert.equal(imported.status,201);
 const importedAsset=(await imported.json()).asset;
 const reused=await importArtwork();assert.equal(reused.status,200);
 assert.equal((await reused.json()).asset.id,importedAsset.id);
 const allAssets=(await(await server.fetch(`/api/storybooks/${id}`,{headers})).json()).assets;
 assert.equal(allAssets.length,62);
 assert.deepEqual((await server.DB.prepare('SELECT document_json FROM storybooks WHERE id=?').bind(id).first()).document_json,JSON.stringify(document),'upload alone never rewrites the book');
 // More than 60 actual images across pages can be saved and opened again.
 document.pages=Array.from({length:3},(_,i)=>emptyStorybookDocument('squarebook-hc',`page_assetcount${String(i).padStart(8,'0')}`,`element_textcount${String(i).padStart(8,'0')}`).pages[0]);
 allAssets.forEach((asset,i)=>document.pages[Math.floor(i/25)].elements.push(image(asset.id,i)));
 const saved=await server.fetch(`/api/storybooks/${id}`,{method:'PUT',headers,body:JSON.stringify({requestId:'save_'+randomUUID(),expectedRevision:0,title:'그림이 많은 책',document,complete:false})});
 assert.equal(saved.status,200,await saved.clone().text());
 const reopened=(await(await server.fetch(`/api/storybooks/${id}`,{headers})).json()).storybook.document;
 assert.deepEqual(reopened,document);
 assert.equal(reopened.pages.flatMap(page=>page.elements).filter(el=>el.type==='image').length,62);
 for(const previous of oldAssets)assert.deepEqual(await server.DB.prepare('SELECT * FROM storybook_assets WHERE id=?').bind(previous.id).first(),previous);
 assert.deepEqual(Buffer.from(await(await server.fetch(`/api/storybooks/${id}/assets/${original.id}`,{headers})).arrayBuffer()),png);
 assert.equal((await upload(Buffer.from('not a PNG'))).status,415);
 assert.equal((await upload(Buffer.alloc(3_500_001))).status,413,'file size bound remains');
 assert.equal((await server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{...headers,authorization:'Bearer '+otherToken,'content-type':'image/png'},body:png})).status,404);
 assert.equal((await server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{...headers,origin:'https://invalid.example','content-type':'image/png'},body:png})).status,403);
 assert.equal((await server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{'content-type':'image/png'},body:png})).status,401);
 assert.equal((await upload(png)).status,201,'valid upload still works after rejected files');
});
