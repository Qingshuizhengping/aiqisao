import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../lib/provider.js';
import { fixture, eventually } from './helpers/application.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = { apiBase: 'https://persona-provider.invalid/v1', apiKey: 'fixture-persona-key',
    chatModel: 'mock-chat', memoryModel: 'mock-memory', providerTimeoutMs: 10000 };

function providerFixture(value) {
    const calls = [];
    const provider = createProvider({ config, fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
            message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
    return { provider, calls };
}

function assertPersona(system) {
    for (const name of ['体系替代个人', '源头重构', '身份杠杆', '量变引爆', '老板解放']) {
        assert.ok(system.includes(name), 'missing mental model: ' + name);
    }
    assert.equal([...system.matchAll(/^### 模型\d+：/gm)].length, 5);
    const heuristics = /## 决策启发式\s*\n([\s\S]*?)\n## 表达DNA/.exec(system)?.[1];
    assert.ok(heuristics, 'complete original heuristic section is present');
    assert.deepEqual([...heuristics.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.match(heuristics, /如果要复制成功/);
    assert.match(system, /# 03 七嫂表达DNA分析/);
    assert.match(system, /## 七、信息来源标注/);
    assert.doesNotMatch(system, /## 角色扮演规则|## 回答工作流（Agentic Protocol）/);
    assert.doesNotMatch(system, /⚠️ 必须使用工具（WebSearch等）获取真实信息/);
}

function assertNoPersona(system) {
    assert.doesNotMatch(system, /### 模型1：体系替代个人|# 03 七嫂表达DNA分析|## 决策启发式/);
}

test('grounded answer drafts receive the recovered persona without weakening their structured evidence contract', async () => {
    const f = providerFixture({ claims: [] });
    const input = { question: '门店该怎样安排工作？', evidence: [{ id: 'source-1', content: '先明确职责，再安排工作。' }], facts: [] };
    assert.deepEqual(await f.provider.draftGrounded(input), { claims: [] });
    assert.equal(f.calls.length, 1);
    const body = f.calls[0].body;
    const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assertPersona(system);
    assert.ok(/不是创始人本人|不得冒充.{0,12}创始人|并非创始人本人/.test(system), 'persona cannot impersonate the real founder');
    assert.ok(/已确认.{0,30}资料|资料.{0,30}已确认/s.test(system), 'confirmed evidence remains required');
    assert.ok(/不能作为业务事实|不是.{0,30}回答证据/s.test(system), 'persona examples cannot become business evidence');
    assert.ok(/不能声称已联网|不能声称.{0,30}搜索|不得.{0,30}搜索|不能假称.{0,30}搜索/s.test(system), 'persona cannot invent research activity');
    assert.match(system, /仅输出严格JSON|只输出严格JSON/);
    assert.match(system, /fact的实际值由程序填充/);
    assert.match(system, /quote类型的text必须保留完整原文段落和限定条件/);
    assert.deepEqual(JSON.parse(body.messages.at(-1).content), input);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
});

test('verification, canonical fact proposals and automatic memory extraction retain their specialist prompts', async () => {
    for (const [method, input, result] of [
        ['verifyGrounded', { question: '如何工作？', claims: [], evidence: [], facts: [] }, { verdicts: [] }],
        ['proposeFacts', { source: { content: '资料中的原始信息。' } }, { facts: [] }],
        ['extractMemory', { userMessage: { content: '我喜欢先看结论。' }, allowedScopes: ['personal'] }, { memories: [] }],
    ]) {
        const f = providerFixture(result);
        assert.deepEqual(await f.provider[method](input), result);
        const body = f.calls[0].body;
        assertNoPersona(body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'));
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.equal(body.stream, false);
    }
});

test('ordinary chat receives the same complete persona while retaining identity and tool limits', async context => {
    const f = await fixture(context);
    const employee = f.employee('persona_context');
    const conversation = await f.conversation(employee);
    const sent = await employee.call('POST', '/api/chat/runs', { conversationId: conversation.id,
        message: '帮我整理门店工作思路。', requestId: randomUUID() });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await eventually(() => f.db.prepare('SELECT state FROM chat_runs WHERE id=?').get(sent.body.run.id).state === 'completed');
    assert.equal(f.calls.length, 1);
    const system = f.calls[0].filter(message => message.role === 'system').map(message => message.content).join('\n');
    assertPersona(system);
    assert.match(system, /不是创始人本人/);
    assert.match(system, /没有联网或项目操作工具/);
    assert.match(system, /不能改变.{0,20}访问权限/);
    assert.equal(f.calls[0].at(-1).content, '帮我整理门店工作思路。');
});

test('persona files remain server-side and cannot be fetched as public static assets', async context => {
    for (const directory of ['public', 'dist']) {
        const base = path.join(root, directory);
        if (!fs.existsSync(base)) continue;
        const files = fs.readdirSync(base, { recursive: true, withFileTypes: true });
        for (const file of files.filter(entry => entry.isFile())) {
            const filename = path.join(file.parentPath, file.name);
            assert.doesNotMatch(filename, /meiye-qi-sao-perspective|SKILL\.md|03-expression-dna\.md/i);
            if (!/\.(?:js|css|html|json|md|txt)$/i.test(filename)) continue;
            assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /### 模型1：体系替代个人|# 03 七嫂表达DNA分析/);
        }
    }
    const f = await fixture(context);
    const employee = f.employee('persona_static');
    for (const url of ['/skills/meiye-qi-sao-perspective/SKILL.md', '/lib/persona.js',
        '/skills/meiye-qi-sao-perspective/references/research/03-expression-dna.md']) {
        const response = await employee.call('GET', url);
        assert.equal(response.status, 404, url);
        assertNoPersona(String(response.body));
    }
});
