import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {sha256} from '../../lib/token-crypto.ts';
import {emptyStorybookDocument} from '../../lib/storybook-model.ts';

// Local test data only: every student has a real uploaded PNG and independent assets.
export async function seedManyImagesBook(server, index, count = 1000) {
 const student=`many_student_${index}`,token=randomUUID(),expiresAt=new Date(Date.now()+3600000).toISOString();
 await server.DB.batch([
  server.DB.prepare("INSERT OR IGNORE INTO teachers(id,email,display_name) VALUES('many_teacher','many@example.test','교사')"),
  server.DB.prepare("INSERT OR IGNORE INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('many_class','many_teacher','검증반','1849','many_join')"),
  server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at) VALUES(?,'many_class',?,'cat',CURRENT_TIMESTAMP)").bind(student,`학생 ${index}`),
  server.DB.prepare('INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').bind(await sha256(token),student,expiresAt),
 ]);
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const response=await server.fetch('/api/storybooks',{method:'POST',headers,body:'{}'});assert.equal(response.status,201);
 const id=(await response.json()).storybook.id;
 const png=await sharp({create:{width:64,height:64,channels:3,background:{r:30+index*7%200,g:120,b:180}}}).png().toBuffer();
 const upload=await server.fetch(`/api/storybooks/${id}/assets`,{method:'POST',headers:{...headers,'content-type':'image/png'},body:png});assert.equal(upload.status,201);
 const original=(await upload.json()).asset;
 const objectKey=(await server.DB.prepare('SELECT object_key FROM storybook_assets WHERE id=?').bind(original.id).first()).object_key;
 const assetIds=[original.id,...Array.from({length:count-1},(_,i)=>`asset_many_${index}_${String(i).padStart(8,'0')}`)];
 await server.DB.batch(assetIds.slice(1).map(assetId=>server.DB.prepare("INSERT INTO storybook_assets(id,storybook_id,student_id,source_type,object_key,content_type,byte_size) VALUES(?,?,?,'upload',?,'image/png',?)").bind(assetId,id,student,objectKey,png.length)));
 const document=emptyStorybookDocument();
 document.pages=Array.from({length:24},(_,i)=>emptyStorybookDocument('squarebook-hc',`page_many_${index}_${String(i).padStart(8,'0')}`,`element_text_${index}_${String(i).padStart(8,'0')}`).pages[0]);
 assetIds.forEach((assetId,i)=>document.pages[Math.floor(i/200)].elements.push({
  id:`element_many_${index}_${String(i).padStart(8,'0')}`,type:'image',assetId,
  x:Number((.02+(i%20)*.048).toFixed(4)),y:Number((.25+(Math.floor(i/20)%10)*.065).toFixed(4)),width:.04,height:.055,
  rotation:0,zIndex:i%200+1,opacity:1,locked:false,
 }));
 return {student,token,expiresAt,headers,id,png,assetIds,document};
}
