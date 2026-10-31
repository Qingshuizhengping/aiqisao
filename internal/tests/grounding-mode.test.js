import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConfig } from '../lib/config.js';
import { fixture, eventually } from './helpers/application.js';

function environment(overrides = {}) {
    return {
        NODE_ENV: 'production',
        INTERNAL_ORIGIN: 'https://8.134.141.217:6069',
        INTERNAL_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString('base64'),
        ...overrides,
    };
}

// The provider records which pipeline asked for an answer, so the mode's *behaviour*
// can be asserted directly instead of being inferred from the health payload.
function pipelineProbe() {
    const counts = { chat: 0, draft: 0, verify: 0 };
    return { counts, provider: {
        async *chat() { counts.chat++; yield '开放回答。'; },
        async draftGrounded(input) {
            counts.draft++;
            return { claims: input.evidence.map((entry, index) => ({ id: 'c' + index, kind: 'quote',
                text: entry.content, evidenceIds: [entry.id], quote: entry.content })) };
        },
        async verifyGrounded(input) {
            counts.verify++;
            return { verdicts: input.claims.map(claim => ({ claimId: claim.id, supported: true, relevant: true })) };
        },
    } };
}

async function run(f, person, message = '门店该怎样安排这一周的工作？') {
    const conversation = await f.conversation(person);
    const sent = await person.call('POST', '/api/chat/runs', { conversationId: conversation.id, message, requestId: randomUUID() });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    return eventually(async () => {
        const response = await person.call('GET', '/api/chat/runs/' + sent.body.run.id);
        return response.status === 200 && !['queued', 'running'].includes(response.body.run.state) && response.body;
    });
}

test('the default answer mode is free, streams through the provider and never calls the grounded pipeline', async context => {
    // createConfig is the only place the default is decided; an absent variable means 'free'.
    assert.equal(createConfig(environment()).groundingMode, 'free');
    const probe = pipelineProbe();
    // groundingMode: undefined mimics a caller that never expressed a preference.
    const f = await fixture(context, { config: { groundingMode: undefined }, provider: probe.provider });
    const person = f.employee('mode_default_free');
    const done = await run(f, person);
    assert.equal(done.run.state, 'completed');
    assert.ok(done.message.content.trim().length > 0, 'the answer must not be empty');
    assert.equal(probe.counts.chat, 1);
    assert.equal(probe.counts.draft, 0);
    assert.equal(probe.counts.verify, 0);
    assert.equal(done.message.metadata.grounding, undefined);
    const health = await person.call('GET', '/api/health');
    assert.equal(health.body.grounding.mode, 'free');
});

test('explicit strict mode runs the four-stage pipeline and never calls the streaming provider', async context => {
    const probe = pipelineProbe();
    const f = await fixture(context, { config: { groundingMode: 'strict' }, provider: probe.provider });
    const person = f.employee('mode_explicit_strict');
    const done = await run(f, person);
    assert.equal(done.run.state, 'completed');
    assert.equal(probe.counts.chat, 0, 'strict mode must not use the open streaming branch');
    assert.ok(done.message.metadata.grounding, 'strict mode always publishes grounding metadata');
    // No confirmed source exists in this fixture, so the gate answers 'insufficient'
    // (which is exactly the behaviour open mode is replacing).
    assert.equal(done.message.metadata.grounding.status, 'insufficient');
    assert.equal((await person.call('GET', '/api/health')).body.grounding.mode, 'strict');
});

test('injecting a provider never changes the configured mode', async context => {
    // Regression guard for the deleted `strictGrounding !== false || !suppliedProvider`
    // rule: a fake provider used to be an implicit request for the fixture branch.
    const probe = pipelineProbe();
    const f = await fixture(context, { config: { groundingMode: 'free' }, provider: probe.provider });
    const person = f.employee('mode_free_with_provider');
    const done = await run(f, person);
    assert.equal(done.run.state, 'completed');
    assert.equal(probe.counts.draft, 0, 'an injected provider must not promote the run to strict');
    assert.equal(probe.counts.chat, 1);
    assert.equal(done.message.metadata.grounding, undefined);
    assert.equal((await person.call('GET', '/api/health')).body.grounding.mode, 'free');
});

test('the reported mode always matches the observed pipeline for both modes', async context => {
    for (const [mode, expected] of [['free', { chat: 1, grounded: false }], ['strict', { chat: 0, grounded: true }]]) {
        const probe = pipelineProbe();
        const f = await fixture(context, { config: { groundingMode: mode }, provider: probe.provider });
        const person = f.employee('mode_matrix_' + mode);
        const done = await run(f, person);
        assert.equal(done.run.state, 'completed');
        assert.equal(probe.counts.chat, expected.chat, mode + ': provider.chat call count');
        assert.equal(Boolean(done.message.metadata.grounding), expected.grounded, mode + ': grounded metadata present');
        const health = await person.call('GET', '/api/health');
        assert.equal(health.body.grounding.mode, mode, mode + ': health reports what actually ran');
        assert.doesNotMatch(JSON.stringify(health.body), /transport-fixture/);
    }
});

test('an invalid INTERNAL_GROUNDING_MODE fails fast at startup instead of falling back silently', () => {
    for (const value of ['open', 'FREE!', 'true', '0']) {
        assert.throws(() => createConfig(environment({ INTERNAL_GROUNDING_MODE: value })),
            /INTERNAL_GROUNDING_MODE must be strict or free/, 'accepted invalid mode: ' + JSON.stringify(value));
    }
    assert.equal(createConfig(environment({ INTERNAL_GROUNDING_MODE: ' strict ' })).groundingMode, 'strict');
    assert.equal(createConfig(environment({ INTERNAL_GROUNDING_MODE: 'free' })).groundingMode, 'free');
    // The cooldown knob is bounded, so a typo cannot park the breaker for a year.
    assert.equal(createConfig(environment()).chatBreakerCooldownMs, 3000);
    assert.equal(createConfig(environment({ INTERNAL_CHAT_BREAKER_COOLDOWN_MS: '80' })).chatBreakerCooldownMs, 80);
    for (const value of ['49', '600001', 'abc', '1.5']) {
        assert.throws(() => createConfig(environment({ INTERNAL_CHAT_BREAKER_COOLDOWN_MS: value })), /Invalid numeric/);
    }
});
