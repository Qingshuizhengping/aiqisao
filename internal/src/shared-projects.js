/**
 * @file 共享项目面板 (requirement R4-03/04).
 *
 * A read-only discovery list: it shows the projects that were *marked as shared* by a
 * project administrator **and** granted to this member by the system administrator.
 * Clicking a row leaves the panel and selects that project through the ordinary
 * `selectProject()` flow, so chat, history and permissions behave exactly as if the member
 * had picked it from the sidebar.
 */

import { api } from './api.js';
import { el, button, panel, notice, empty, badge, formatDate, icon } from './ui.js';

/**
 * Opens the 共享项目 panel.
 *
 * @param {{onSelect?: (project: Object) => void, currentProjectId?: string|null}} [options] Options.
 * @returns {{dialog: HTMLDialogElement, close: Function}} Panel handle.
 */
export function openSharedProjectsPanel({ onSelect, currentProjectId = null } = {}) {
    const list = el('div', { className: 'stack-tight shared-project-list', 'aria-label': '共享项目列表' });
    const errors = el('div');
    const view = panel('共享项目', el('div', { className: 'stack' },
        notice('这些是共享给你的项目。你可以直接进入聊天、查看自己的历史；项目设置、成员和归档仍由项目管理员负责。'),
        errors, list), { wide: true, subtitle: '按权限共享，撤销后立即失效。' });

    /**
     * @param {Object} item Project summary from `GET /api/projects/shared`.
     * @returns {HTMLElement} One clickable row.
     */
    function row(item) {
        const manager = item.role === 'admin';
        return el('button', {
            type: 'button',
            className: 'shared-project-row' + (item.id === currentProjectId ? ' current' : ''),
            'aria-current': item.id === currentProjectId ? 'true' : 'false',
            onclick: () => { view.close(); onSelect?.(item); },
        },
        icon('folder', 18),
        el('div', { className: 'shared-project-identity' },
            el('strong', { text: item.name }),
            el('small', { className: 'muted', text: (item.memberCount || 0) + ' 位成员 · 更新于 ' + (formatDate(item.updatedAt) || '—') })),
        badge(manager ? '项目管理员' : '成员', manager ? 'accent' : ''),
        item.archived && badge('只读', 'warning'));
    }

    async function load() {
        list.replaceChildren(empty('正在读取共享项目…'));
        try {
            const data = await api('/api/projects/shared');
            if (!view.dialog.isConnected) return;
            const projects = Array.isArray(data.projects) ? data.projects : [];
            if (!projects.length) {
                list.replaceChildren(empty('还没有共享项目', '管理员把项目标记为共享、并授权给你之后，会出现在这里。'));
                return;
            }
            list.replaceChildren(...projects.map(row));
        } catch (error) {
            if (!view.dialog.isConnected || error.code === 'STALE_RESPONSE') return;
            errors.replaceChildren(notice(error.message, 'error'));
            list.replaceChildren(button('重新读取', load, { className: 'button small' }));
        }
    }

    load();
    return view;
}
