const paths = {
    plus: 'M12 5v14M5 12h14', menu: 'M4 6h16M4 12h16M4 18h16', close: 'm6 6 12 12M18 6 6 18',
    arrow: 'M12 20V4m-6 6 6-6 6 6', chevron: 'm9 5 7 7-7 7', back: 'm15 5-7 7 7 7',
    chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
    folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    memory: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M8 3v18M13 5h8m-4-4v8M12 13h5m-5 4h5',
    shield: 'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7Zm-4 9 3 3 5-6',
    user: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    settings: 'M9.5 3h5l.8 3 2.2 1.3 3-.8 2.5 4.3-2.2 2.2v2.5l2.2 2.2-2.5 4.3-3-.8-2.2 1.3-.8 3h-5l-.8-3L6.5 21l-3 .8L1 17.5l2.2-2.2v-2.5L1 10.6l2.5-4.3 3 .8L8.7 6ZM15.5 14a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
    moon: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z',
    edit: 'm16 3 5 5L9 20l-6 1 1-6Zm-2 2 5 5',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
    check: 'm5 12 4 4L19 6', stop: 'M6 6h12v12H6Z',
    logout: 'M9 3H3v18h6m6-4 5-5-5-5m-8 5h13',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    spark: 'm12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z',
    lock: 'M5 11h14v10H5ZM8 11V7a4 4 0 0 1 8 0v4',
    archive: 'M3 3h18v5H3Zm2 5v13h14V8m-10 5h6',
};

export function icon(name, size = 20) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.chat);
    svg.append(path);
    return svg;
}

export function el(tag, properties = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
        if (value === undefined || value === null) continue;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'className') node.className = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in node && !key.startsWith('aria')) node[key] = value;
        else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
}

export function button(label, action, { className = 'button', name, glyph, type = 'button', ...properties } = {}) {
    return el('button', { type, className, 'aria-label': name || label, title: name || label, onclick: action, ...properties }, glyph && icon(glyph), label && el('span', { text: label }));
}

export function input(label, { tag = 'input', hint, ...properties } = {}) {
    const control = el(tag, { className: 'input', ...properties });
    const wrapper = el('label', { className: 'field' }, el('span', { className: 'field-label', text: label }), control, hint && el('small', { text: hint }));
    return { control, wrapper };
}

export function select(label, options, value = '') {
    const result = input(label, { tag: 'select' });
    result.control.append(...options.map(option => el('option', { value: option.value, text: option.label })));
    if (options.some(option => String(option.value) === String(value))) result.control.value = value;
    else if (options.length) result.control.value = options[0].value;
    return result;
}

export function notice(text, kind = 'neutral') { return el('div', { className: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status', text }); }
export function empty(text, detail = '') { return el('div', { className: 'empty-state' }, icon('spark', 28), el('strong', { text }), detail && el('p', { text: detail })); }
export function badge(text, className = '') { return el('span', { className: 'badge ' + className, text }); }

export function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '';
}

let currentPanel = null;
export function closePanel() { currentPanel?.close(); }
export function panel(title, content, { wide = false, subtitle = '' } = {}) {
    closePanel();
    const previousFocus = document.activeElement;
    const dialog = el('dialog', { className: 'panel' + (wide ? ' panel-wide' : ''), 'aria-label': title });
    const body = el('div', { className: 'panel-body' }, content);
    dialog.append(el('header', { className: 'panel-header' }, el('div', {}, el('h2', { text: title }), subtitle && el('p', { text: subtitle })), button('', () => dialog.close(), { className: 'icon-button', name: '关闭面板', glyph: 'close' })), body);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
        if (currentPanel === dialog) currentPanel = null;
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
    });
    document.body.append(dialog);
    currentPanel = dialog;
    dialog.showModal();
    return { dialog, body, close: () => dialog.close() };
}

export function confirmAction(title, detail, label = '确认') {
    return new Promise(resolve => {
        let approved = false;
        const view = panel(title, el('div', { className: 'stack' }, el('p', { className: 'muted', text: detail }), el('div', { className: 'actions' }, button('取消', () => view.close()), button(label, () => { approved = true; view.close(); }, { className: 'button danger' }))));
        view.dialog.addEventListener('close', () => resolve(approved), { once: true });
    });
}

let toastTimer;
export function toast(message, kind = 'neutral') {
    let host = document.getElementById('toast');
    if (!host) { host = el('div', { id: 'toast', role: 'status', className: 'toast', hidden: true }); document.body.append(host); }
    host.textContent = message;
    host.className = 'toast ' + kind;
    host.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { host.hidden = true; }, 5000);
}

export async function submitting(form, action, errorHost) {
    const controls = Array.from(form.querySelectorAll('button,input,textarea,select'));
    const states = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    errorHost.replaceChildren();
    try { return await action(); } catch (error) {
        if (error.code !== 'STALE_RESPONSE' && error.name !== 'AbortError') errorHost.replaceChildren(notice(error.message || '操作未完成，请重试。', 'error'));
        return null;
    } finally { controls.forEach((control, index) => { control.disabled = states[index]; }); }
}
