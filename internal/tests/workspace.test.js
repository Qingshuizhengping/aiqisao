import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceController, createDraftRepository, createDraftBinding } from '../src/workspace-controller.js';

function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; } };
}
const person = { id: 'alice', displayName: 'Alice' };
const projectA = { id: 'project-A', name: 'A', role: 'member', archived: false };
const projectB = { id: 'project-B', name: 'B', role: 'member', archived: false };
const conversation = (id, projectId = null, extra = {}) => ({ id, projectId, memoryEnabled: true, ...extra });
const run = { id: 'run-A', state: 'running', requestId: 'request-1' };

function fixture(handle = () => undefined, { onDraftCleared = () => {} } = {}) {
    const calls = [], events = [], observers = [];
    const drafts = createDraftRepository({ storage: () => memory });
    const memory = storage();
    let serial = 0;
    const workspace = createWorkspaceController({
        drafts, uuid: () => 'request-' + ++serial,
        async api(path, options = {}) {
            calls.push({ path, ...options });
            const result = handle(path, options);
            if (result !== undefined) return result;
            if (path === '/api/projects') return { projects: [projectA, projectB] };
            if (path.startsWith('/api/conversations?') || path === '/api/conversations' && !options.method) return { conversations: [] };
            if (path === '/api/chat/runs') return { run };
            if (path.startsWith('/api/conversations/')) return { conversation: conversation(path.split('/').pop()), messages: [], run };
            throw new Error('Unhandled synthetic route ' + path);
        },
        observeRun(id, callbacks) {
            const entry = { id, callbacks, disposed: false, synced: false };
            observers.push(entry);
            return { dispose() { entry.disposed = true; }, sync() { entry.synced = true; } };
        },
        onState: state => events.push({ type: 'state', state }),
        onSelection: state => events.push({ type: 'selection', state }),
        onConversation: data => events.push({ type: 'conversation', data }),
        onBusy: busy => events.push({ type: 'busy', busy }),
        onMessage: message => events.push({ type: 'message', message }),
        onRun: value => events.push({ type: 'run', run: value }),
        onConnection: text => events.push({ type: 'connection', text }),
        onError: (error, area) => events.push({ type: 'error', error, area }),
        onDraftCleared(draft) { events.push({ type: 'cleared', draft }); onDraftCleared(draft); },
    });
    workspace.setUser(person); drafts.activate(person.id);
    return { workspace, calls, events, observers, drafts, memory };
}
async function open(workspace, value) {
    if (value.projectId) await workspace.selectProject(value.projectId === projectA.id ? projectA : projectB);
    await workspace.selectConversation(value.id, { conversation: value, messages: [] });
}

test('switching scope while legacy memory PATCH is pending cannot send or overwrite the new workspace', async () => {
    const patch = gate();
    const testbed = fixture((path, options) => options.method === 'PATCH' ? patch.promise : undefined);
    const { workspace, drafts, calls, events } = testbed;
    await open(workspace, conversation('A', projectA.id, { memoryEnabled: false }));
    const draft = drafts.capture('draft-A', 'A text');
    const sending = workspace.send({ content: 'A text', draft, selection: workspace.capture() });
    await workspace.selectProject(projectB);
    drafts.write('draft-B', 'B untouched');
    const marker = events.length;
    patch.resolve({ conversation: conversation('A', projectA.id) });
    assert.equal((await sending).sent, false);
    assert.equal(calls.filter(call => call.path === '/api/chat/runs').length, 0);
    assert.equal(workspace.getState().project.id, projectB.id);
    assert.equal(workspace.getState().conversation, null);
    assert.equal(drafts.read('draft-A'), 'A text');
    assert.equal(drafts.read('draft-B'), 'B untouched');
    assert.equal(events.slice(marker).some(event => event.type === 'conversation' || event.type === 'cleared'), false);
});

test('switching scope during conversation creation stops before run submission and preserves the captured project target', async () => {
    const creation = gate();
    const { workspace, calls, drafts } = fixture((path, options) => path === '/api/conversations' && options.method === 'POST' ? creation.promise : undefined);
    await workspace.selectProject(projectA);
    const draft = drafts.capture('new-A', 'New discussion');
    const sending = workspace.send({ content: draft.content, draft });
    assert.equal(calls.at(-1).body.projectId, projectA.id);
    await workspace.selectProject(projectB);
    creation.resolve({ conversation: conversation('created-A', projectA.id) });
    await sending;
    assert.equal(calls.some(call => call.path === '/api/chat/runs'), false);
    assert.equal(workspace.getState().project.id, projectB.id);
    assert.equal(drafts.read(draft.key), draft.content);
});

test('accepted POST continues in background, confirms only the original draft, and never stops on navigation', async () => {
    const post = gate();
    const { workspace, drafts, calls, events } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined);
    await open(workspace, conversation('A', projectA.id));
    const draft = drafts.capture('draft-A', 'A request');
    const sending = workspace.send({ content: draft.content, draft });
    const submitted = calls.find(call => call.path === '/api/chat/runs');
    assert.equal(submitted.signal, undefined);
    assert.equal(submitted.body.conversationId, 'A');
    await workspace.selectProject(projectB);
    drafts.write('draft-B', 'B text');
    const marker = events.length;
    post.resolve({ run });
    assert.equal((await sending).sent, true);
    assert.equal(drafts.read(draft.key), '');
    assert.equal(drafts.read('draft-B'), 'B text');
    assert.equal(workspace.knownRun('A').id, run.id);
    assert.equal(workspace.getState().conversation, null);
    assert.equal(events.slice(marker).some(event => ['conversation', 'busy'].includes(event.type)), false);
    assert.equal(calls.some(call => call.path.endsWith('/stop')), false);
    await workspace.selectProject(projectA);
    await workspace.selectConversation('A', { conversation: conversation('A', projectA.id), messages: [{ id: 'saved', content: 'Completed while away' }], run: { ...run, state: 'completed' } });
    assert.equal(events.filter(event => event.type === 'conversation').at(-1).data.messages[0].content, 'Completed while away');
});

test('draft confirmation preserves edits made after the request, even if text is changed back to the original', async () => {
    const post = gate();
    const { workspace, drafts } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined);
    await open(workspace, conversation('A'));
    const draft = drafts.capture('draft-A', 'Original');
    const sending = workspace.send({ content: draft.content, draft });
    workspace.newConversation();
    drafts.write(draft.key, 'Edited'); drafts.write(draft.key, 'Original');
    post.resolve({ run }); await sending;
    assert.equal(drafts.read(draft.key), 'Original');
});

test('A to B to A confirms the newly mounted original draft and cannot revive it on disposal', async () => {
    const post = gate();
    let visible;
    const { workspace, drafts } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined,
        { onDraftCleared(draft) { visible?.confirm(draft); } });
    await open(workspace, conversation('A'));
    visible = createDraftBinding(drafts); visible.load('draft-A'); visible.write('Original A');
    const sending = workspace.send({ content: 'Original A', draft: visible.capture() });
    workspace.newConversation();
    visible = createDraftBinding(drafts); visible.load('draft-B'); visible.write('Keep B');
    await workspace.selectConversation('A', { conversation: conversation('A'), messages: [] });
    visible = createDraftBinding(drafts); assert.equal(visible.load('draft-A'), 'Original A');
    post.resolve({ run }); await sending;
    assert.equal(visible.value.content, '');
    assert.equal(drafts.read('draft-A'), '');
    visible.write(visible.value.content); // The composer's disposal saves its visible value.
    assert.equal(drafts.read('draft-A'), '');
    assert.equal(drafts.read('draft-B'), 'Keep B');
});

test('A to B to A with intervening edits preserves the newer draft even after restoring the same text', async () => {
    const post = gate();
    let visible;
    const { workspace, drafts } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined,
        { onDraftCleared(draft) { visible?.confirm(draft); } });
    await open(workspace, conversation('A'));
    visible = createDraftBinding(drafts); visible.load('draft-A'); visible.write('Original A');
    const original = visible.capture();
    const sending = workspace.send({ content: 'Original A', draft: original });
    workspace.newConversation();
    visible = createDraftBinding(drafts); visible.load('draft-B'); visible.write('Keep B');
    await workspace.selectConversation('A', { conversation: conversation('A'), messages: [] });
    visible = createDraftBinding(drafts); visible.load('draft-A');
    visible.write('Edited A'); visible.write('Original A');
    assert.notEqual(visible.value.revision, original.revision);
    post.resolve({ run }); await sending;
    assert.equal(visible.value.content, 'Original A');
    assert.equal(drafts.read('draft-A'), 'Original A');
    visible.write(visible.value.content);
    assert.equal(drafts.read('draft-A'), 'Original A');
    assert.equal(drafts.read('draft-B'), 'Keep B');
});

test('original draft confirmation cannot clear a different mounted composer', async () => {
    const post = gate();
    let visible;
    const { workspace, drafts } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined,
        { onDraftCleared(draft) { visible?.confirm(draft); } });
    await open(workspace, conversation('A'));
    visible = createDraftBinding(drafts); visible.load('draft-A'); visible.write('Same text');
    const sending = workspace.send({ content: 'Same text', draft: visible.capture() });
    workspace.newConversation();
    visible = createDraftBinding(drafts); visible.load('draft-B'); visible.write('Same text');
    post.resolve({ run }); await sending;
    assert.equal(drafts.read('draft-A'), '');
    assert.equal(visible.value.key, 'draft-B');
    assert.equal(visible.value.content, 'Same text');
    visible.write(visible.value.content);
    assert.equal(drafts.read('draft-B'), 'Same text');
});

test('old POST completion cannot release the busy owner of a newer send', async () => {
    const a = gate(), b = gate();
    const { workspace, drafts, events, calls } = fixture((path, options) => path === '/api/chat/runs' ? (options.body.conversationId === 'A' ? a.promise : b.promise) : undefined);
    await open(workspace, conversation('A'));
    const first = workspace.send({ content: 'A', draft: drafts.capture('A', 'A') });
    await workspace.selectConversation('B', { conversation: conversation('B'), messages: [] });
    const second = workspace.send({ content: 'B', draft: drafts.capture('B', 'B') });
    const marker = events.length;
    a.resolve({ run }); await first;
    assert.equal(events.slice(marker).some(event => event.type === 'busy' && !event.busy), false);
    assert.equal((await workspace.send({ content: 'Duplicate B' })).sent, false);
    assert.equal(calls.filter(call => call.path === '/api/chat/runs').length, 2);
    b.resolve({ run: { ...run, id: 'run-B' } }); await second;
    assert.equal(events.filter(event => event.type === 'busy').at(-1).busy, false);
});

test('out-of-order selection GETs are cancelled and cannot render the previous conversation', async () => {
    const a = gate(), b = gate();
    const { workspace, calls, events } = fixture(path => path === '/api/conversations/A' ? a.promise : path === '/api/conversations/B' ? b.promise : undefined);
    const first = workspace.selectConversation('A');
    const second = workspace.selectConversation('B');
    assert.equal(calls.find(call => call.path.endsWith('/A')).signal.aborted, true);
    b.resolve({ conversation: conversation('B'), messages: [] }); await second;
    a.resolve({ conversation: conversation('A'), messages: [] }); await first;
    assert.equal(workspace.getState().conversation.id, 'B');
    assert.deepEqual(events.filter(event => event.type === 'conversation').map(event => event.data.conversation.id), ['B']);
});

test('stale stream callbacks are ignored, navigation only disposes observation, explicit stop alone sends stop', async () => {
    const { workspace, observers, events, calls } = fixture(path => path.endsWith('/stop') ? { run: { ...run, state: 'stopped' } } : undefined);
    await workspace.selectConversation('A', { conversation: conversation('A'), messages: [], run });
    const previous = observers[0];
    workspace.newConversation();
    assert.equal(previous.disposed, true);
    const marker = events.length;
    previous.callbacks.onUpdate({ id: 'stale', content: 'Must not render' });
    previous.callbacks.onFinished({ ...run, state: 'completed' });
    assert.equal(events.slice(marker).length, 0);
    assert.equal(calls.some(call => call.path.endsWith('/stop')), false);
    await workspace.selectConversation('A', { conversation: conversation('A'), messages: [], run });
    observers[1].callbacks.onUpdate({ id: 'fresh', content: 'Latest durable text' });
    assert.equal(events.at(-1).message.id, 'fresh');
    await workspace.stop(run);
    assert.equal(calls.filter(call => call.path.endsWith('/stop')).length, 1);
    assert.equal(observers[1].synced, true);
});

test('logout and account replacement reject old POST results, UI callbacks, and draft confirmation', async () => {
    const post = gate();
    const { workspace, drafts, events } = fixture(path => path === '/api/chat/runs' ? post.promise : undefined);
    await open(workspace, conversation('A'));
    const sending = workspace.send({ content: 'Private A', draft: drafts.capture('A', 'Private A') });
    workspace.clearSession(); workspace.setUser({ id: 'bob' }); drafts.activate('bob');
    drafts.write('B', 'Bob draft');
    const marker = events.length;
    post.resolve({ run }); await sending;
    assert.equal(events.slice(marker).length, 0);
    assert.equal(workspace.knownRun('A'), null);
    assert.equal(workspace.getState().user.id, 'bob');
    assert.equal(drafts.read('B'), 'Bob draft');
});

test('a lost POST response recovers only its captured request ID after navigation', async () => {
    const post = gate(), recovery = gate();
    const { workspace, calls, drafts } = fixture(path => path === '/api/chat/runs' ? post.promise : path === '/api/conversations/A' ? recovery.promise : undefined);
    await open(workspace, conversation('A'));
    const sending = workspace.send({ content: 'A', draft: drafts.capture('A', 'A') });
    workspace.newConversation();
    post.reject(Object.assign(new Error('Lost response'), { code: 'NETWORK_ERROR' }));
    await Promise.resolve(); await Promise.resolve();
    recovery.resolve({ conversation: conversation('A'), run });
    assert.equal((await sending).sent, true);
    assert.equal(drafts.read('A'), '');
    assert.equal(calls.filter(call => call.path === '/api/chat/runs').length, 1);
});

test('permission metadata refresh reconciles the current project, never the project selected when refresh started', async () => {
    const projects = gate();
    const { workspace } = fixture(path => path === '/api/projects' ? projects.promise : undefined);
    await workspace.selectProject(projectA);
    const refreshing = workspace.refreshProjects();
    await workspace.selectProject(projectB);
    projects.resolve({ projects: [projectB] }); await refreshing;
    assert.equal(workspace.getState().project.id, projectB.id);
});

test('ordinary selection during stop response cannot apply stopped state to a different run', async () => {
    const stopping = gate();
    const { workspace, events } = fixture(path => path.endsWith('/stop') ? stopping.promise : undefined);
    await workspace.selectConversation('A', { conversation: conversation('A'), run, messages: [] });
    const pending = workspace.stop(run);
    await workspace.selectConversation('B', { conversation: conversation('B'), run: { ...run, id: 'run-B' }, messages: [] });
    const marker = events.length;
    stopping.resolve({ run: { ...run, state: 'stopped' }, message: { id: 'old-stop' } }); await pending;
    assert.equal(workspace.getState().run.id, 'run-B');
    assert.equal(events.slice(marker).length, 0);
});
