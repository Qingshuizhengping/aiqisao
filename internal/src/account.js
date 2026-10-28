import { api, setSession } from './api.js';
import { el, button, input, panel, notice, submitting, toast, icon } from './ui.js';

function authFrame(title, subtitle, content) {
    const brand = el('div', { className: 'brand-row' }, el('img', { className: 'brand-avatar', src: '/static/img/avatar-192.png', alt: 'AI七嫂·员工专属版' }), el('div', { className: 'brand-wordmark' }, el('strong', { text: 'AI七嫂·员工专属版' }), el('small', { text: '薇之雨 · 内部工作空间' })));
    return el('main', { className: 'auth-screen' },
        el('section', { className: 'auth-story', 'aria-label': '品牌介绍' }, brand,
            el('div', { className: 'story-main' }, el('div', { className: 'eyebrow', text: '一起想清楚 · 一起向前' }), el('h1', {}, '每一次讨论，', el('br'), '都有迹可循。'), el('p', { className: 'story-copy', text: '让AI七嫂·员工专属版记住工作中的细节，连接项目的来龙去脉。把思路理顺，把事情做好。' })),
            el('div', { className: 'story-footer', text: 'WEIZHIYU · INTERNAL WORKSPACE' })),
        el('section', { className: 'auth-card' }, el('h2', { text: title }), el('p', { className: 'auth-subtitle', text: subtitle }), content,
            el('p', { className: 'privacy-note', text: '仅限内部成员。内部账号的聊天与记忆可由系统管理员审计；项目聊天还可由本项目管理员查看。' })));
}

export function loginScreen(onLogin, message = '') {
    const username = input('账号', { name: 'username', autocomplete: 'username', required: true, placeholder: '请输入内部账号', maxlength: 100 });
    const password = input('密码', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '请输入密码' });
    const totp = input('动态验证码', { name: 'totp', autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, placeholder: '已绑定验证器时填写', hint: '未绑定时可留空；系统或项目管理员使用身份验证器中的 6 位验证码。' });
    const errors = el('div');
    const form = el('form', { className: 'auth-form' }, message && notice(message, 'warning'), username.wrapper, password.wrapper, totp.wrapper, errors, button('登录工作空间', null, { className: 'button primary', type: 'submit', glyph: 'arrow' }));
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            const data = await api('/api/auth/login', { method: 'POST', body: { username: username.control.value.trim(), password: password.control.value, ...(totp.control.value.trim() ? { totp: totp.control.value.trim() } : {}) } });
            setSession(data);
            password.control.value = '';
            totp.control.value = '';
            await onLogin(data);
        }, errors);
    });
    return authFrame('欢迎回来', '登录后继续你的项目与讨论', form);
}

export function passwordScreen(user, onChanged, onLogout) {
    const current = input('初始／当前密码', { type: 'password', autocomplete: 'current-password', required: true });
    const password = input('新密码', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6, maxlength: 256, hint: '至少 6 位，可以使用纯数字。' });
    const repeat = input('再输入一次新密码', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6, maxlength: 256 });
    const errors = el('div');
    const form = el('form', { className: 'auth-form' }, notice('首次登录需先设置你自己的密码。其他设备上的登录会同时失效。'), current.wrapper, password.wrapper, repeat.wrapper, errors, button('保存新密码', null, { type: 'submit', className: 'button primary' }));
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitting(form, async () => {
            if (password.control.value !== repeat.control.value) throw new Error('两次输入的新密码不一致。');
            const data = await api('/api/auth/password', { method: 'POST', body: { currentPassword: current.control.value, newPassword: password.control.value } });
            setSession(data);
            form.reset();
            await onChanged(data);
        }, errors);
    });
    if (onLogout) form.append(button('退出此账号', onLogout, { className: 'button quiet' }));
    return authFrame('设置登录密码', user.displayName + '，欢迎加入内部工作空间', form);
}

export function mfaScreen(onEnrolled, onLogout) {
    const password = input('确认登录密码', { type: 'password', autocomplete: 'current-password', required: true });
    const errors = el('div');
    const enrollment = el('div', { className: 'stack', hidden: true });
    const start = el('form', { className: 'auth-form' }, notice('系统或项目管理员需绑定身份验证器，才能继续使用内部工作空间。'), password.wrapper, errors, button('获取绑定密钥', null, { type: 'submit', className: 'button primary' }));
    start.addEventListener('submit', event => {
        event.preventDefault();
        submitting(start, async () => {
            const data = await api('/api/auth/mfa/setup', { method: 'POST', body: { password: password.control.value } });
            password.control.value = '';
            const code = input('身份验证器中的验证码', { name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, required: true });
            const confirmErrors = el('div');
            const confirm = el('form', { className: 'auth-form' }, code.wrapper, confirmErrors, button('验证并进入工作空间', null, { type: 'submit', className: 'button primary' }));
            confirm.addEventListener('submit', confirmEvent => {
                confirmEvent.preventDefault();
                submitting(confirm, async () => {
                    const completed = await api('/api/auth/mfa/confirm', { method: 'POST', body: { code: code.control.value.trim() } });
                    setSession(completed);
                    enrollment.replaceChildren();
                    await onEnrolled(completed);
                }, confirmErrors);
            });
            enrollment.replaceChildren(el('p', { className: 'muted', text: '在 Microsoft Authenticator、Google Authenticator 等应用中选择“手动输入密钥”，类型选择基于时间。' }), el('div', { className: 'secret-key', text: data.secret }),
                button('复制绑定密钥', async () => { try { await navigator.clipboard.writeText(data.secret); toast('绑定密钥已复制，请勿转发。'); } catch { toast('请长按上方密钥手动复制。'); } }, { glyph: 'copy' }),
                el('small', { text: '密钥只在此设备页面展示，不会发送给外部二维码服务。绑定完成前不要关闭身份验证器。' }), confirm);
            enrollment.hidden = false;
            start.hidden = true;
            code.control.focus();
        }, errors);
    });
    return authFrame('开启管理员验证', '为管理权限增加一道验证', el('div', { className: 'stack' }, start, enrollment, onLogout && button('退出此账号', onLogout, { className: 'button quiet' })));
}

export function accountPanel(user, { onUserChanged, onLogout }) {
    const memoryEnabled = el('input', { type: 'checkbox', checked: user.autoMemoryEnabled });
    const preferenceErrors = el('div');
    const preferenceForm = el('form', { className: 'stack-tight' }, el('label', { className: 'check-field' }, memoryEnabled, el('span', { text: '自动整理我的长期记忆' })), el('small', { text: '关闭后不再从新对话提取记忆；已保存的记忆仍可在记忆库管理。' }), preferenceErrors);
    memoryEnabled.addEventListener('change', () => submitting(preferenceForm, async () => {
        const data = await api('/api/auth/preferences', { method: 'PATCH', body: { autoMemoryEnabled: memoryEnabled.checked } });
        user = data.user;
        onUserChanged(data.user);
        toast('记忆偏好已保存。');
    }, preferenceErrors).then(() => { memoryEnabled.checked = user.autoMemoryEnabled; }));
    const current = input('当前密码', { type: 'password', autocomplete: 'current-password', required: true });
    const next = input('新密码', { type: 'password', autocomplete: 'new-password', minlength: 6, maxlength: 256, required: true, hint: '至少 6 位，可以使用纯数字。' });
    const repeat = input('确认新密码', { type: 'password', autocomplete: 'new-password', minlength: 6, maxlength: 256, required: true });
    const errors = el('div');
    const passwordForm = el('form', { className: 'stack' }, current.wrapper, next.wrapper, repeat.wrapper, errors, button('更新密码', null, { type: 'submit' }));
    passwordForm.addEventListener('submit', event => {
        event.preventDefault();
        submitting(passwordForm, async () => {
            if (next.control.value !== repeat.control.value) throw new Error('两次输入的新密码不一致。');
            const data = await api('/api/auth/password', { method: 'POST', body: { currentPassword: current.control.value, newPassword: next.control.value } });
            setSession(data);
            onUserChanged(data.user);
            passwordForm.reset();
            toast('密码已更新，其他设备需要重新登录。');
        }, errors);
    });
    panel('账号与偏好', el('div', { className: 'stack' }, el('div', { className: 'row' }, el('span', { className: 'initials', text: user.displayName.slice(0, 1) }), el('div', {}, el('h3', { text: user.displayName }), el('small', { text: user.username + (user.systemRole === 'admin' ? ' · 系统管理员' : ' · 内部成员') }))),
        el('div', { className: 'divider' }), preferenceForm, el('div', { className: 'divider' }), el('h3', { text: '修改密码' }), passwordForm,
        notice('内部账号的聊天与记忆可由系统管理员审计；项目聊天还可由本项目管理员查看。审计查看不会自动进入任何人的聊天上下文。'),
        button('退出登录', onLogout, { className: 'button danger', glyph: 'logout' })));
}
