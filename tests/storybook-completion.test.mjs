import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startTestServer} from './harness/server.mjs';
import {sha256} from '../lib/token-crypto.ts';
import {emptyStorybookDocument,storybookCompletionError} from '../lib/storybook-model.ts';
import {storyTextLines,fittedStoryText,STORY_TEXT_LINE_HEIGHT} from '../lib/storybook-text.ts';
test('story text wraps Korean, explicit newlines and emoji without hiding legacy content',()=>{
  assert.deepEqual(storyTextLines('가나다라\n마바',2,s=>Array.from(s).length),['가나','다라','마바']);
  assert.deepEqual(storyTextLines('👨‍👩‍👧‍👦가',1,s=>[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(s)].length),['👨‍👩‍👧‍👦','가']);
  const text='오래된 긴 이야기'.repeat(60),fitted=fittedStoryText(text,45,900,160,(s,size)=>s.length*size);
  assert.equal(fitted.lines.join(''),text);assert.ok(fitted.lines.length*fitted.size*STORY_TEXT_LINE_HEIGHT<=160);
  assert.match(storybookCompletionError('',24),/제목/);assert.match(storybookCompletionError('나의 새 그림책',24),/제목/);
  assert.match(storybookCompletionError('우리의 모험',23),/내지가 최소 24쪽/);assert.equal(storybookCompletionError('우리의 모험',24),'');
});
test('HTTP completion enforces title and 24 inner pages (covers excluded) while drafts preserve an empty title',async t=>{
  const server=await startTestServer({env:{OPENAI_API_KEY:'',SWEETBOOK_API_KEY:''}});t.after(()=>server.dispose());await server.fetch('/api/student');
  const token=randomUUID();await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('completion_teacher','completion@example.test','교사')"),
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('completion_class','completion_teacher','반','4513','join_complete')"),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at) VALUES('completion_student','completion_class','별','cat',CURRENT_TIMESTAMP)"),
    server.DB.prepare("INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,'completion_student',?,CURRENT_TIMESTAMP)").bind(await sha256(token),new Date(Date.now()+3600000).toISOString())
  ]);
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const created=await(await server.fetch('/api/storybooks',{method:'POST',headers,body:'{}'})).json();assert.equal(created.storybook.title,'');
  const id=created.storybook.id;let revision=0;
  async function save(title,count,complete,status){const document=emptyStorybookDocument();document.pages=Array.from({length:count},(_,i)=>emptyStorybookDocument('squarebook-hc','page_test'+String(i).padStart(8,'0'),'element_test'+String(i).padStart(8,'0')).pages[0]);const response=await server.fetch('/api/storybooks/'+id,{method:'PUT',headers,body:JSON.stringify({requestId:'save_'+randomUUID(),expectedRevision:revision,title,document,complete})});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));if(status===200)revision=data.revision;return data;}
  // 2026-11-02: 최소 쪽 수는 앞표지(와 뒷표지)를 뺀 내지 기준이다. 뒷표지 표시가 없는 이 문서는 첫 쪽만 표지라 N쪽 = 내지 N-1쪽.
  await save('',1,false,200);await save('원하는 제목',24,true,400);await save('나의 새 그림책',25,true,400);await save('',25,true,400);
  await save('원하는 제목',25,true,200);let book=await(await server.fetch('/api/storybooks/'+id,{headers})).json();assert.equal(book.storybook.status,'complete');
  await save('26쪽 제목',26,true,200);await save('',26,false,200);book=await(await server.fetch('/api/storybooks/'+id,{headers})).json();assert.equal(book.storybook.title,'');assert.equal(book.storybook.status,'draft');
});
