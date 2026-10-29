import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { fixture, gate } from './helpers/application.js';
import { insertMemory } from '../lib/memory-store.js';
import { createGroundingLibrary } from '../lib/grounding-library.js';
import { AppError } from '../lib/errors.js';
import { fetchLocal } from './helpers/fetch-local.js';

async function setup(context, provider) {
    const application = await fixture(context, { start:false });
    const library = createGroundingLibrary({ db:application.db, provider });
    const app = express();
    app.use(express.json());
    app.use('/api', application.auth.guardOrigin, application.auth.requireReadyUser, library.router);
    app.use((error, request, response, next) => response.status(error instanceof AppError ? error.status : 500).json({error:{code:error.code || 'INTERNAL_ERROR'}}));
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base='http://127.0.0.1:'+server.address().port;
    async function call(person, method, path, body, headers={}) {
        const response = await fetchLocal(base+path, {method, headers:{...person?.headers, ...(body!==undefined?{'Content-Type':'application/json'}:{}), ...headers}, body:body===undefined?undefined:JSON.stringify(body)});
        return {status:response.status,body:await response.json()};
    }
    function memory(person, options={}) {
        return insertMemory(application.db,{userId:person.id,scope:'personal',status:'active',content:'清润霜的价格为168元。',...options});
    }
    function project(manager,members=[]) {
        const id=randomUUID(), now=Date.now();
        application.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'合成核验项目',manager.id,now,now);
        for(const person of [manager,...members]) application.db.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?)').run(id,person.id,person===manager?'admin':'member',now);
        return id;
    }
    function file(person,projectId=null,scope='personal') {
        const id=randomUUID(),chunkId=randomUUID(),now=Date.now(),content='清润霜的价格为168元。';
        application.db.prepare(`INSERT INTO knowledge_files(id,scope,user_id,project_id,name,extension,mime_type,size_bytes,sha256,original,text_content,
            status,processing_state,index_state,chunk_count,character_count,created_at,updated_at) VALUES(?,?,?,?,?,'txt','text/plain',?,?,?,?,'active','ready','ready',1,?,?,?)`)
            .run(id,scope,person.id,projectId,'合成价格表.txt',Buffer.byteLength(content),'synthetic-hash',Buffer.from(content),content,content.length,now,now);
        application.db.prepare('INSERT INTO knowledge_chunks(id,file_id,file_version,chunk_index,content) VALUES(?,?,1,0,?)').run(chunkId,id,content);
        return {id,chunkId,version:1,content};
    }
    const fact = original => ({sourceType:original.chunkId?'file':'memory',sourceId:original.id,sourceVersion:original.version,entity:'清润霜',field:'价格',value:'168',unit:'元',aliases:['清润面霜'],evidence:'清润霜的价格为168元。',...(original.chunkId?{evidenceChunkId:original.chunkId}:{})});
    const confirm = (person,type,original) => call(person,'POST',`/api/grounding/sources/${type}/${original.id}/confirm`,{version:original.version});
    return {...application,library,call,memory,project,file,fact,confirm};
}

test('historical and automatic sources stay unconfirmed until explicit authorized confirmation',async context=>{
    const f=await setup(context),owner=f.employee('ground_owner'),other=f.employee('ground_other'),admin=f.employee('ground_auditor','admin');
    const original=f.memory(owner,{origin:'automatic'});
    assert.equal(f.library.catalog({user:{id:owner.id}}).sources.length,0);
    assert.equal((await f.call(other,'GET',`/api/grounding/sources/memory/${original.id}`)).status,404);
    assert.equal((await f.call(admin,'POST',`/api/grounding/sources/memory/${original.id}/confirm`,{version:1})).status,404);
    const result=await f.confirm(owner,'memory',original);
    assert.equal(result.status,200); assert.equal(result.body.source.confirmed,true); assert.ok(result.body.source.confirmationId);
    assert.equal(f.library.catalog({user:{id:owner.id}}).sources[0].content,original.content);
    const columns=f.db.prepare('SELECT * FROM source_confirmations').all();
    assert.equal(columns.length,1); assert.equal(columns[0].confirmed_by,owner.id);
    assert.equal((await f.confirm(owner,'memory',original)).body.source.confirmationId,result.body.source.confirmationId);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM source_confirmations').get().n,1);
});

test('dated or conditional facts require source-backed applicability before confirmation and retain it in history', async context => {
    const f = await setup(context), owner = f.employee('dated_fact_owner');
    const original = f.memory(owner, { content: '2025年1月1日至2025年12月31日期间，清润霜的价格为168元。' });
    await f.confirm(owner, 'memory', original);
    const created = await f.call(owner, 'POST', '/api/grounding/facts', { ...f.fact(original), evidence: original.content });
    assert.equal(created.status, 201);
    const path = '/api/grounding/facts/' + created.body.fact.id;
    assert.equal((await f.call(owner, 'POST', path + '/confirm', { version: 1 })).body.error.code, 'GROUNDING_DATES_REQUIRED');
    const outside = await f.call(owner, 'PATCH', path, { version: 1, validFrom: '2024-01-01', validUntil: '2025-12-31' });
    assert.equal(outside.body.error.code, 'GROUNDING_DATE_EVIDENCE_MISMATCH');
    const updated = await f.call(owner, 'PATCH', path, { version: 1, validFrom: '2025-01-01', validUntil: '2025-12-31' });
    assert.equal(updated.status, 200);
    const confirmed = await f.call(owner, 'POST', path + '/confirm', { version: updated.body.fact.version });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.body.fact.validUntil, '2025-12-31');
    const history = JSON.parse(f.db.prepare('SELECT canonical_value FROM fact_confirmations WHERE fact_id=?').get(created.body.fact.id).canonical_value);
    assert.equal(history.validFrom, '2025-01-01'); assert.equal(history.validUntil, '2025-12-31');
    const edited = await f.call(owner, 'PATCH', path, { version: confirmed.body.fact.version, validUntil: '2025-06-30' });
    assert.equal(edited.body.fact.confirmed, false);

    const limited = f.memory(owner, { content: '清润霜的价格为168元，仅限会员满10瓶起订。' }); await f.confirm(owner, 'memory', limited);
    const candidate = await f.call(owner, 'POST', '/api/grounding/facts', { ...f.fact(limited), evidence: limited.content });
    const route = '/api/grounding/facts/' + candidate.body.fact.id;
    assert.equal((await f.call(owner, 'POST', route + '/confirm', { version: 1 })).body.error.code, 'GROUNDING_CONDITIONS_REQUIRED');
    const conditioned = await f.call(owner, 'PATCH', route, { version: 1, conditions: limited.content });
    const accepted = await f.call(owner, 'POST', route + '/confirm', { version: conditioned.body.fact.version });
    assert.equal(accepted.status, 200); assert.equal(accepted.body.fact.conditions, limited.content);
});

test('shared confirmation belongs to project administrators and never grants private or cross-project access',async context=>{
    const f=await setup(context),manager=f.employee('project_lead'),member=f.employee('project_staff'),outside=f.employee('outside_staff'),sys=f.employee('system_audit','admin');
    const project=f.project(manager,[member]),shared=f.memory(member,{scope:'project_shared',projectId:project}),privateRow=f.memory(member,{scope:'project_private',projectId:project});
    assert.equal((await f.confirm(member,'memory',shared)).status,403);
    assert.equal((await f.confirm(manager,'memory',privateRow)).status,404);
    assert.equal((await f.confirm(sys,'memory',shared)).status,404);
    assert.equal((await f.confirm(manager,'memory',shared)).status,200);
    assert.equal(f.library.catalog({user:{id:member.id},projectId:project}).sources.length,1);
    assert.throws(()=>f.library.catalog({user:{id:outside.id},projectId:project}),error=>error.code==='PROJECT_ACCESS_DENIED');
    f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(member.id);
    assert.equal(f.library.catalog({user:{id:manager.id},projectId:project}).sources.length,1);
    f.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(project);
    assert.equal((await f.call(manager,'POST',`/api/grounding/sources/memory/${shared.id}/revoke`,{version:1})).body.error.code,'PROJECT_ARCHIVED');
});

test('version changes and revoke-reconfirm cycles invalidate captured evidence and preserve a confirmation history',async context=>{
    const f=await setup(context),owner=f.employee('evidence_owner'),original=f.file(owner);
    const confirmed=await f.confirm(owner,'file',original),source=confirmed.body.source;
    const evidence={id:'file:'+original.chunkId,sourceType:'file',sourceId:original.id,version:1,chunkId:original.chunkId,confirmationId:source.confirmationId,content:'forged content'};
    const checked=f.library.revalidate({user:{id:owner.id},evidence:[evidence],facts:[]});
    assert.equal(checked.evidence[0].content,original.content);
    await f.call(owner,'POST',`/api/grounding/sources/file/${original.id}/revoke`,{version:1});
    assert.equal(f.library.revalidate({user:{id:owner.id},evidence:[evidence]}).evidence.length,0);
    await f.confirm(owner,'file',original);
    assert.equal(f.library.revalidate({user:{id:owner.id},evidence:[evidence]}).evidence.length,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM source_confirmations').get().n,2);
    f.db.prepare('UPDATE knowledge_files SET version=2 WHERE id=?').run(original.id);
    assert.equal(f.library.catalog({user:{id:owner.id}}).sources.length,0);
    const detail=await f.call(owner,'GET',`/api/grounding/sources/file/${original.id}`);
    assert.equal(detail.body.source.confirmed,false); assert.equal(detail.body.source.needsReconfirmation,true);
    assert.equal((await f.confirm(owner,'file',original)).body.error.code,'GROUNDING_VERSION_CHANGED');
});

test('standard facts are candidates, require exact evidence and source confirmation, and render current canonical fields',async context=>{
    const f=await setup(context),owner=f.employee('facts_owner'),original=f.memory(owner);
    for(const patch of [{value:'1'},{unit:'美元'},{evidence:'清润霜的价格为198元。'},{entity:'其它产品',aliases:[]},{scope:'project_shared'}]){
        const denied=await f.call(owner,'POST','/api/grounding/facts',{...f.fact(original),...patch});
        assert.ok([400,422].includes(denied.status),JSON.stringify(denied));
    }
    const created=await f.call(owner,'POST','/api/grounding/facts',f.fact(original));
    assert.equal(created.status,201); assert.equal(created.body.fact.status,'candidate');
    const id=created.body.fact.id;
    assert.equal((await f.call(owner,'POST',`/api/grounding/facts/${id}/confirm`,{version:1})).body.error.code,'GROUNDING_SOURCE_UNCONFIRMED');
    await f.confirm(owner,'memory',original);
    const confirmed=await f.call(owner,'POST',`/api/grounding/facts/${id}/confirm`,{version:1});
    assert.equal(confirmed.status,200); assert.equal(confirmed.body.fact.confirmed,true); assert.equal(confirmed.body.fact.version,2);
    const record=f.db.prepare('SELECT * FROM fact_confirmations WHERE fact_id=?').get(id);
    assert.equal(record.confirmed_by,owner.id); assert.equal(record.source_version,1); assert.equal(record.fact_version,2);
    assert.equal(JSON.parse(record.canonical_value).value,'168');
    const catalog=f.library.catalog({user:{id:owner.id}});
    assert.equal(catalog.facts[0].value,'168'); assert.equal(catalog.facts[0].unit,'元');
    const validated=f.library.revalidate({user:{id:owner.id},facts:[{...catalog.facts[0],value:'999',entity:'other'}]});
    assert.equal(validated.facts[0].value,'168'); assert.equal(validated.facts[0].entity,'清润霜');
    await f.call(owner,'PATCH',`/api/grounding/facts/${id}`,{version:2,aliases:['清润霜别名']});
    assert.ok(f.db.prepare('SELECT revoked_at FROM fact_confirmations WHERE fact_id=?').get(id).revoked_at);
    assert.equal(f.library.catalog({user:{id:owner.id}}).facts.length,0);
    assert.equal(f.library.revalidate({user:{id:owner.id},facts:catalog.facts}).facts.length,0);
    assert.equal((await f.call(owner,'POST',`/api/grounding/facts/${id}/confirm`,{version:2})).body.error.code,'GROUNDING_VERSION_CHANGED');
});

test('file fact evidence must reference a real current chunk and remains scoped after source revocation',async context=>{
    const f=await setup(context),owner=f.employee('file_facts_owner'),other=f.employee('file_facts_other'),original=f.file(owner);
    await f.confirm(owner,'file',original);
    assert.equal((await f.call(owner,'POST','/api/grounding/facts',{...f.fact(original),evidenceChunkId:randomUUID()})).status,422);
    const created=(await f.call(owner,'POST','/api/grounding/facts',f.fact(original))).body.fact;
    const confirmed=(await f.call(owner,'POST',`/api/grounding/facts/${created.id}/confirm`,{version:created.version})).body.fact;
    assert.equal((await f.call(other,'GET',`/api/grounding/facts/${created.id}`)).status,404);
    assert.equal((await f.call(other,'POST',`/api/grounding/facts/${created.id}/revoke`,{version:confirmed.version})).status,404);
    await f.call(owner,'POST',`/api/grounding/sources/file/${original.id}/revoke`,{version:1});
    assert.equal(f.library.catalog({user:{id:owner.id}}).facts.length,0);
    await f.confirm(owner,'file',original);
    assert.equal(f.library.catalog({user:{id:owner.id}}).facts.length,0);
    const reconfirmed=await f.call(owner,'POST',`/api/grounding/facts/${created.id}/confirm`,{version:confirmed.version});
    assert.equal(reconfirmed.body.fact.confirmed,true);
    f.db.prepare("UPDATE knowledge_files SET status='deleted',original=NULL,text_content='',version=version+1 WHERE id=?").run(original.id);
    assert.equal(f.library.revalidate({user:{id:owner.id},facts:[reconfirmed.body.fact]}).facts.length,0);
});

test('a price cannot borrow its object name from a different paragraph in the same source', async context => {
    const f = await setup(context), owner = f.employee('separate_entity_owner');
    const original = f.memory(owner, {content:'清润霜是甲产品。\n\n舒润霜的价格为168元。'});
    const response = await f.call(owner, 'POST', '/api/grounding/facts', {...f.fact(original), aliases:[], evidence:'舒润霜的价格为168元。'});
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'GROUNDING_ENTITY_MISMATCH');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM standard_facts').get().n, 0);
});

test('confirmation mutations retain authentication, origin and CSRF checks and never accept secret-bearing sources',async context=>{
    const f=await setup(context),owner=f.employee('secure_facts_owner'),original=f.memory(owner);
    const route=`/api/grounding/sources/memory/${original.id}/confirm`;
    assert.equal((await f.call(null,'GET','/api/grounding/sources')).status,401);
    assert.equal((await f.call(owner,'POST',route,{version:1},{Origin:'https://hostile.test'})).body.error.code,'ORIGIN_DENIED');
    assert.equal((await f.call(owner,'POST',route,{version:1},{'X-CSRF-Token':''})).body.error.code,'CSRF_INVALID');
    const secret=f.memory(owner,{content:'Synthetic API key: sk-'+'a'.repeat(48)});
    assert.equal((await f.confirm(owner,'memory',secret)).body.error.code,'GROUNDING_SECRET_BLOCKED');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM source_confirmations').get().n,0);
});

test('model suggestions only create atomic candidates and cannot supply their own ownership',async context=>{
    let result={facts:[{entity:'清润霜',field:'价格',value:'168',unit:'元',evidence:'清润霜的价格为168元。'}]};
    const f=await setup(context,{async proposeFacts(){return result;}}),owner=f.employee('suggest_owner'),original=f.memory(owner);
    const path=`/api/grounding/sources/memory/${original.id}/suggest-facts`;
    const suggested=await f.call(owner,'POST',path,{version:1});
    assert.equal(suggested.status,200); assert.equal(suggested.body.facts[0].status,'candidate'); assert.equal(suggested.body.facts[0].confirmed,false);
    assert.equal(f.library.catalog({user:{id:owner.id}}).facts.length,0);
    result={facts:[result.facts[0],{...result.facts[0],value:'999'}]};
    assert.equal((await f.call(owner,'POST',path,{version:1})).status,422);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM standard_facts').get().n,1);
    result={facts:[{...result.facts[0],scope:'project_shared'}]};
    assert.equal((await f.call(owner,'POST',path,{version:1})).status,400);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM standard_facts').get().n,1);
});

test('suggestions recheck session, source version and archive revisions after the provider await',async context=>{
    for(const change of ['session','version','archive']){
        const entered=gate(),release=gate();
        const f=await setup(context,{async proposeFacts(){entered.resolve();await release.promise;return {facts:[{entity:'清润霜',field:'价格',value:'168',unit:'元',evidence:'清润霜的价格为168元。'}]};}});
        const manager=f.employee('suggest_'+change),project=f.project(manager),original=f.memory(manager,{scope:'project_shared',projectId:project});
        const pending=f.call(manager,'POST',`/api/grounding/sources/memory/${original.id}/suggest-facts`,{version:1});
        await entered.promise;
        if(change==='session') f.db.prepare('DELETE FROM sessions WHERE user_id=?').run(manager.id);
        if(change==='version') f.db.prepare('UPDATE memories SET version=version+1 WHERE id=?').run(original.id);
        if(change==='archive'){f.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(project);f.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(project);}
        release.resolve(); const response=await pending;
        assert.ok([401,409].includes(response.status),JSON.stringify(response));
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM standard_facts').get().n,0);
    }
});
