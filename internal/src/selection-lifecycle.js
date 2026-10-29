// A lease describes the UI that owned an operation when it started. Network
// completion never grants an old operation ownership of the current selection.
export function createSelectionLifecycle() {
    let session = 0, scope = 0, selection = 0;
    const levels = { session: 0, scope: 1, selection: 2 };
    function capture(details = {}) { return Object.freeze({ ...details, session, scope, selection }); }
    function current(lease, level = 'selection') {
        const depth = levels[level];
        return Boolean(lease && depth !== undefined && lease.session === session
            && (depth < 1 || lease.scope === scope) && (depth < 2 || lease.selection === selection));
    }
    return { capture, current,
        advance(level = 'selection') {
            if (!(level in levels)) throw new TypeError('Unknown lifecycle level');
            if (level === 'session') session++;
            if (level !== 'selection') scope++;
            selection++;
            return capture();
        },
        commit(lease, callback, level = 'selection') { if (!current(lease, level)) return false; callback(); return true; },
    };
}

// Lists and editors have independent owners: refreshing a list must not reclaim
// an editor that the user has since opened for another account.
export function createLifecycleOwner() {
    const lifecycle = createSelectionLifecycle();
    let disposed = false;
    return {
        capture: details => lifecycle.capture(details),
        advance: () => lifecycle.advance(),
        current: lease => !disposed && lifecycle.current(lease),
        dispose() { disposed = true; lifecycle.advance('session'); },
    };
}
