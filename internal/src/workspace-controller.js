import { createSelectionLifecycle } from './selection-lifecycle.js';

const active = run => run && ['queued', 'running'].includes(run.state);
const ignored = error => error.name === 'AbortError' || error.code === 'STALE_RESPONSE';
const query = projectId => projectId ? '?projectId=' + encodeURIComponent(projectId) : '';

export function createDraftRepository({ storage, prefix = 'weizhiyu-internal-draft:' }) {
    const revisions = new Map();
    const store = () => { try { return storage(); } catch { return null; } };
    function read(key) { try { return store()?.getItem(key) || ''; } catch { return ''; } }
    function write(key, content) {
        if (!key || read(key) === content) return;
        revisions.set(key, (revisions.get(key) || 0) + 1);
        try { content ? store()?.setItem(key, content) : store()?.removeItem(key); } catch {}
    }
    function clear() {
        const target = store();
        try {
            for (let index = (target?.length || 0) - 1; index >= 0; index--) {
                const key = target.key(index);
                if (key?.startsWith(prefix)) target.removeItem(key);
            }
            target?.removeItem('weizhiyu-internal-draft-owner');
        } catch {}
        revisions.clear();
    }
    return { read, write, clear, revision: key => revisions.get(key) || 0,
        activate(ownerId) {
            const target = store();
            try {
                const previous = target?.getItem('weizhiyu-internal-draft-owner');
                if (previous && previous !== ownerId) clear();
                target?.setItem('weizhiyu-internal-draft-owner', ownerId);
            } catch {}
        },
        capture(key, content) { write(key, content); return Object.freeze({ key, content, revision: revisions.get(key) || 0 }); },
        confirm(draft) {
            if (!draft?.key || read(draft.key) !== draft.content || (revisions.get(draft.key) || 0) !== draft.revision) return false;
            write(draft.key, '');
            return true;
        },
    };
}

// Each mounted composer remembers the version it loaded. A successful request
// may confirm an old selection's draft while that draft is visible in a newly
// mounted composer; matching its key, revision and content clears that binding
// without giving the old selection ownership of the rest of the view.
export function createDraftBinding(repository) {
    let value = { key: null, content: '', revision: 0 };
    function write(content) {
        if (!value.key) return;
        repository.write(value.key, content);
        value = { ...value, content, revision: repository.revision(value.key) };
    }
    return {
        load(key) { value = { key, content: repository.read(key), revision: repository.revision(key) }; return value.content; },
        write,
        capture(content = value.content) { write(content); return Object.freeze({ ...value }); },
        confirm(draft) {
            if (!draft || value.key !== draft.key || value.revision !== draft.revision || value.content !== draft.content) return false;
            value = { ...value, content: '', revision: repository.revision(value.key) };
            return true;
        },
        get value() { return { ...value }; },
    };
}

// No browser or DOM dependencies. Mutations retain their fixed target; leases
// control only which responses may change the visible workspace.
export function createWorkspaceController({ api, observeRun, drafts, uuid = () => globalThis.crypto.randomUUID(),
    onState = () => {}, onSelection = () => {}, onConversation = () => {}, onBusy = () => {},
    onMessage = () => {}, onRun = () => {}, onConnection = () => {}, onError = () => {}, onDraftCleared = () => {} }) {
    const lifecycle = createSelectionLifecycle();
    let state = { user: null, project: null, projects: [], conversation: null, conversations: [], run: null };
    let observer, operation = null, pendingSelection = false;
    let sequence = 0;
    const reads = new Map();
    const accepted = new Map();
    let sessionController = new AbortController();
    const snapshot = () => ({ ...state, projects: [...state.projects], conversations: [...state.conversations] });
    const emit = () => onState(snapshot());
    const capture = details => lifecycle.capture({ ownerId: state.user?.id, projectId: state.project?.id || null, conversationId: state.conversation?.id || null, ...details });
    const current = (lease, level) => Boolean(state.user && lifecycle.current(lease, level));
    function report(error, lease, area = 'chat', level = 'selection') {
        if (!ignored(error) && current(lease, level)) onError(error, area);
    }
    function cancelReads(level) {
        for (const [name, read] of reads) if (level === 'session' || level === 'scope' && read.level !== 'session' || level === 'selection' && read.level === 'selection') {
            read.controller.abort(); reads.delete(name);
        }
    }
    function beginRead(name, level, lease = capture()) {
        reads.get(name)?.controller.abort();
        const read = { lease, level, controller: new AbortController(), id: ++sequence };
        reads.set(name, read);
        return { signal: read.controller.signal, current: () => reads.get(name) === read && current(lease, level) };
    }
    function releaseSelection(level) {
        lifecycle.advance(level); cancelReads(level);
        observer?.dispose(); observer = null;
        operation = null; pendingSelection = false;
        state.run = null;
    }
    function renderSelection() { emit(); onSelection(snapshot()); onBusy(false); onConnection(''); }
    async function refreshProjects() {
        if (!state.user) return false;
        const read = beginRead('projects', 'session');
        try {
            const data = await api('/api/projects', { signal: read.signal });
            if (!read.current()) return false;
            state.projects = data.projects || []; emit();
            const previous = state.project;
            if (previous) {
                const updated = state.projects.find(item => item.id === previous.id);
                if (!updated) await selectProject(null);
                else if (updated.role !== previous.role || updated.archived !== previous.archived) {
                    const conversationId = state.conversation?.id;
                    if (await selectProject(updated) && conversationId) await selectConversation(conversationId);
                } else { state.project = updated; emit(); }
            }
            return true;
        } catch (error) { if (read.current()) report(error, capture(), 'projects', 'session'); return false; }
    }
    async function refreshConversations() {
        if (!state.user) return false;
        const lease = capture();
        const read = beginRead('conversations', 'scope', lease);
        try {
            const data = await api('/api/conversations' + query(lease.projectId), { signal: read.signal });
            if (!read.current()) return false;
            state.conversations = data.conversations || []; emit();
            return true;
        } catch (error) { if (read.current()) report(error, lease, 'conversations', 'scope'); return false; }
    }
    async function selectProject(value) {
        if (!state.user) return false;
        releaseSelection('scope');
        state.project = value; state.conversation = null; state.conversations = [];
        const lease = capture(); renderSelection();
        await refreshConversations();
        return current(lease);
    }
    function newConversation() {
        if (!state.user) return;
        releaseSelection('selection'); state.conversation = null;
        renderSelection();
    }
    async function selectConversation(id, preloaded) {
        if (!state.user) return false;
        releaseSelection('selection'); state.conversation = null;
        const lease = capture({ requestedConversationId: id });
        renderSelection(); pendingSelection = true; onBusy(true);
        const read = beginRead('selection', 'selection', lease);
        try {
            const data = preloaded || await api('/api/conversations/' + encodeURIComponent(id), { signal: read.signal });
            if (!read.current()) return false;
            // A stale sidebar entry cannot place a conversation in another scope.
            if ((data.conversation.projectId || null) !== lease.projectId) throw new Error('这段讨论不属于当前项目空间。');
            state.conversation = data.conversation; state.run = data.run || null; emit();
            onConversation(data); attachRun(data.run, lease);
            return true;
        } catch (error) { if (read.current()) report(error, lease); return false; }
        finally { if (current(lease)) { pendingSelection = false; onBusy(Boolean(operation)); } }
    }
    function attachRun(run, lease = capture()) {
        observer?.dispose(); observer = null;
        state.run = active(run) ? run : null; onRun(state.run);
        if (!active(run)) return;
        observer = observeRun(run.id, {
            onUpdate(message) { if (current(lease)) onMessage(message); },
            onState(value) { if (current(lease)) { state.run = active(value) ? value : null; onRun(state.run); } },
            onConnection(text) { if (current(lease)) onConnection(text); },
            onFinished(value) {
                if (!current(lease)) return;
                state.run = null; onRun(null); onConnection('');
                if (['failed', 'interrupted'].includes(value.state)) onError(new Error('本次生成未完成，已保存收到的内容。你可以发送新消息继续。'), 'chat');
                refreshConversations();
            },
            onDenied(error) {
                if (!current(lease) || error.status === 401) return;
                refreshProjects().then(() => { if (current(lease)) selectProject(null); });
            },
        });
    }
    async function send({ content, draft, selection } = {}) {
        if (!state.user || !content?.trim() || operation || pendingSelection || active(state.run) || state.conversation?.readOnly || state.project?.archived || selection && !current(selection)) return { sent: false };
        const lease = capture({ requestId: uuid(), draft });
        const operationId = ++sequence;
        operation = operationId; onBusy(true);
        let target = state.conversation;
        try {
            if (target?.memoryEnabled === false) {
                const data = await api('/api/conversations/' + encodeURIComponent(target.id), { method: 'PATCH', body: { memoryEnabled: true } });
                if (!current(lease)) return { sent: false };
                target = data.conversation;
            }
            if (!target) {
                const data = await api('/api/conversations', { method: 'POST', body: { ...(lease.projectId ? { projectId: lease.projectId } : {}), title: content.slice(0, 42), memoryEnabled: true } });
                target = data.conversation;
                if (!current(lease)) return { sent: false };
                state.conversation = target;
                state.conversations = [target, ...state.conversations.filter(item => item.id !== target.id)]; emit();
            }
            // From this boundary onward the durable server job may exist. View
            // disposal must never abort the mutation or send a stop request.
            let data;
            try {
                data = await api('/api/chat/runs', { method: 'POST', body: { conversationId: target.id, message: content, requestId: lease.requestId } });
            } catch (error) {
                if (error.code !== 'NETWORK_ERROR' || !current(lease, 'session')) throw error;
                const recovered = await api('/api/conversations/' + encodeURIComponent(target.id), { signal: sessionController.signal });
                if (!current(lease, 'session')) return { sent: false };
                if (recovered.run?.requestId === lease.requestId) data = { run: recovered.run };
                else throw new Error('发送结果尚未确认，草稿已保留。请重新打开此对话核对，避免重复发送。');
            }
            if (!current(lease, 'session')) return { sent: false };
            accepted.set(target.id, data.run);
            const cleared = drafts?.confirm(draft);
            if (cleared) onDraftCleared(draft);
            if (!current(lease)) return { sent: true, run: data.run };
            state.conversation = target;
            state.run = data.run || null; emit(); onRun(active(data.run) ? data.run : null);
            const read = beginRead('selection', 'selection', lease);
            try {
                const detail = await api('/api/conversations/' + encodeURIComponent(target.id), { signal: read.signal });
                if (!read.current()) return { sent: true, run: data.run };
                state.conversation = detail.conversation; state.run = detail.run || data.run || null; emit();
                onConversation({ ...detail, run: detail.run || data.run });
                attachRun(detail.run || data.run, lease);
                refreshConversations();
            } catch (error) {
                if (read.current()) { report(error, lease); attachRun(data.run, lease); }
            }
            return { sent: true, run: data.run };
        } catch (error) { report(error, lease); return { sent: false }; }
        finally { if (current(lease) && operation === operationId) { operation = null; onBusy(pendingSelection); } }
    }
    async function stop(run) {
        if (!state.user || !run?.id || state.run?.id !== run.id) return;
        const lease = capture();
        try {
            const data = await api('/api/chat/runs/' + encodeURIComponent(run.id) + '/stop', { method: 'POST' });
            if (!current(lease)) return;
            if (data.message) onMessage(data.message);
            if (data.run) { state.run = active(data.run) ? data.run : null; onRun(state.run); }
            observer?.sync();
        } catch (error) { report(error, lease); }
    }
    function clearSession() {
        releaseSelection('session'); sessionController.abort(); sessionController = new AbortController(); accepted.clear();
        state = { user: null, project: null, projects: [], conversation: null, conversations: [], run: null }; emit();
    }
    return { getState: snapshot, capture, current, refreshProjects, refreshConversations, selectProject, selectConversation, newConversation, send, stop, clearSession,
        setUser(user) { if (state.user?.id && state.user.id !== user?.id) clearSession(); state.user = user; emit(); },
        updateConversation(value, lease) {
            if (!current(lease) || state.conversation?.id !== value.id) return false;
            state.conversation = value; emit(); return true;
        },
        knownRun(conversationId) { return accepted.get(conversationId) || null; },
    };
}
