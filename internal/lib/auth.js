import express from 'express';
import { createHash, randomBytes, randomUUID, scrypt as deriveKey, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, asyncRoute, fail } from './errors.js';
import { audit, publicUser } from './access.js';

const scrypt = promisify(deriveKey);
const PASSWORD_PARAMETERS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) fail(400, 'INVALID_PASSWORD', '密码需要 6–256 个字符，可以使用纯数字。');
    return password;
}

export function validateUsername(username) {
    if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(username)) fail(400, 'INVALID_USERNAME', '账号使用 3–64 位字母、数字、下划线、短横线或点。');
    return username.toLowerCase();
}

export async function hashPassword(password) {
    validatePassword(password);
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64, PASSWORD_PARAMETERS);
    return 'scrypt$16384$8$1$' + salt + '$' + hash.toString('hex');
}

async function verifyPassword(password, stored) {
    if (typeof password !== 'string' || password.length > 256 || typeof stored !== 'string') return false;
    const fields = stored.split('$');
    if (fields.length !== 6 || fields.slice(0, 4).join('$') !== 'scrypt$16384$8$1'
        || !/^[0-9a-f]{32}$/.test(fields[4]) || !/^[0-9a-f]{128}$/.test(fields[5])) return false;
    const actual = await scrypt(password, fields[4], 64, PASSWORD_PARAMETERS);
    return timingSafeEqual(actual, Buffer.from(fields[5], 'hex'));
}

export function createAuth({ db, config }) {
    const router = express.Router();
    const cookieName = config.cookieName || 'qisao_internal_session';
    const sessionTtl = Math.min(7 * 86400000, Math.max(60000, Number(config.sessionTtlMs) || 12 * 3600000));
    const now = () => Date.now();
    const attempts = new Map();
    const dummySalt = randomBytes(16).toString('hex');
    const dummyHash = 'scrypt$16384$8$1$' + dummySalt + '$' + scryptSync(randomBytes(32), dummySalt, 64, PASSWORD_PARAMETERS).toString('hex');

    function limited(request, category, limit = 10, identity = request.ip || request.socket.remoteAddress || 'unknown') {
        const time = now();
        for (const [key, entry] of attempts) if (entry.expires <= time) attempts.delete(key);
        const key = category + ':' + identity;
        const entry = attempts.get(key) || { count: 0, expires: time + 60000 };
        if (entry.count >= limit || !attempts.has(key) && attempts.size >= 2048) fail(429, 'AUTH_RATE_LIMIT', '操作过于频繁，请稍后重试。');
        entry.count++;
        attempts.set(key, entry);
    }

    function cookie(response, token) {
        response.cookie(cookieName, token, { httpOnly: true, secure: config.secureCookies !== false,
            sameSite: 'strict', path: '/', maxAge: sessionTtl });
    }

    function clearCookie(response) {
        response.clearCookie(cookieName, { httpOnly: true, secure: config.secureCookies !== false, sameSite: 'strict', path: '/' });
    }

    function tokenHash(token) {
        return createHash('sha256').update(token).digest('hex');
    }

    function readToken(request) {
        const values = String(request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='));
        if (values.length !== 1) return null;
        const token = values[0].slice(cookieName.length + 1);
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }

    function issueSession(userId, response) {
        const time = now();
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(time);
        const token = randomBytes(32).toString('base64url');
        const csrfToken = randomBytes(32).toString('base64url');
        const id = tokenHash(token);
        db.prepare('INSERT INTO sessions(id,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, userId, csrfToken, time, time + sessionTtl);
        cookie(response, token);
        return { id, csrfToken };
    }

    function guardOrigin(request, response, next) {
        if (!SAFE_METHODS.has(request.method) && request.get('Origin') !== config.origin) {
            return next(new AppError(403, 'ORIGIN_DENIED', '请求来源不允许。'));
        }
        next();
    }

    function requireUser(request, response, next) {
        try {
            const token = readToken(request);
            if (!token) fail(401, 'AUTH_REQUIRED', '请先登录。');
            const id = tokenHash(token);
            const session = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(id, now());
            if (!session) fail(401, 'AUTH_REQUIRED', '登录已过期，请重新登录。');
            const row = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id);
            if (!row) fail(401, 'AUTH_REQUIRED', '账号不可用，请联系管理员。');
            if (!SAFE_METHODS.has(request.method)) {
                if (request.get('Origin') !== config.origin) fail(403, 'ORIGIN_DENIED', '请求来源不允许。');
                const csrf = request.get('X-CSRF-Token') || '';
                const actual = Buffer.from(csrf);
                const expected = Buffer.from(session.csrf_token);
                if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(403, 'CSRF_INVALID', '请求验证已失效，请刷新页面。');
            }
            request.user = publicUser(row, db);
            request.session = { id, csrfToken: session.csrf_token };
            next();
        } catch (error) { next(error); }
    }

    function requireReadyUser(request, response, next) {
        requireUser(request, response, error => {
            if (error) return next(error);
            if (request.user.mustChangePassword) return next(new AppError(428, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。'));
            next();
        });
    }

    async function bootstrap() {
        if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) return false;
        const username = validateUsername(config.bootstrapUsername || 'admin');
        const passwordHash = await hashPassword(config.bootstrapPassword);
        const time = now();
        const id = randomUUID();
        const insert = db.transaction(() => {
            if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) return false;
            db.prepare(`INSERT INTO users(id,username,display_name,password_hash,system_role,must_change_password,created_at,updated_at)
                VALUES(?,?,?,?, 'admin',1,?,?)`).run(id, username, '系统管理员', passwordHash, time, time);
            audit(db, { id }, 'user.bootstrap', 'user', id);
            return true;
        });
        return insert();
    }

    router.post('/login', asyncRoute(async (request, response) => {
        limited(request, 'login', 30);
        const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
        limited(request, 'login_account', 8, tokenHash(username.slice(0, 256)));
        const row = username.length <= 64 ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
        const valid = await verifyPassword(request.body?.password, row?.password_hash || dummyHash);
        if (!row?.active || !valid) fail(401, 'LOGIN_FAILED', '账号或密码不正确。');
        const session = db.transaction(() => {
            const current = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(row.id);
            if (!current || current.password_hash !== row.password_hash || current.system_role !== row.system_role) fail(401, 'LOGIN_FAILED', '账号状态已改变，请重新登录。');
            const previous = readToken(request);
            if (previous) db.prepare('DELETE FROM sessions WHERE id=?').run(tokenHash(previous));
            const session = issueSession(row.id, response);
            audit(db, { id: row.id }, 'auth.login', 'user', row.id);
            return session;
        })();
        response.json({ user: publicUser(row, db), csrfToken: session.csrfToken });
    }));

    router.get('/me', requireUser, (request, response) => response.json({ user: request.user, csrfToken: request.session.csrfToken }));

    router.post('/logout', requireUser, (request, response) => {
        db.prepare('DELETE FROM sessions WHERE id=?').run(request.session.id);
        clearCookie(response);
        audit(db, request.user, 'auth.logout', 'user', request.user.id);
        response.json({ ok: true });
    });

    router.post('/password', requireUser, asyncRoute(async (request, response) => {
        limited(request, 'password', 5);
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(request.user.id);
        if (!await verifyPassword(request.body?.currentPassword, row.password_hash)) fail(403, 'PASSWORD_INCORRECT', '当前密码不正确。');
        validatePassword(request.body?.newPassword);
        if (request.body.newPassword === request.body.currentPassword) fail(400, 'PASSWORD_UNCHANGED', '新密码需要与当前密码不同。');
        const passwordHash = await hashPassword(request.body.newPassword);
        const session = db.transaction(() => {
            if (!db.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?').get(request.session.id, now())) fail(401, 'AUTH_REQUIRED', '登录状态已改变，请重新登录。');
            const changed = db.prepare('UPDATE users SET password_hash=?,must_change_password=0,updated_at=? WHERE id=? AND password_hash=? AND active=1')
                .run(passwordHash, now(), row.id, row.password_hash);
            if (!changed.changes) fail(409, 'ACCOUNT_CHANGED', '账号状态已改变，请重新登录。');
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
            audit(db, request.user, 'auth.password_change', 'user', row.id);
            return issueSession(row.id, response);
        })();
        response.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(row.id), db), csrfToken: session.csrfToken });
    }));

    router.post(['/mfa/setup', '/mfa/confirm'], requireUser, (request, response) => {
        fail(410, 'MFA_RETIRED', '动态验证码已停用，请使用账号和密码登录。');
    });

    router.patch('/preferences', requireReadyUser, (request, response, next) => {
        try {
            const body = request.body && typeof request.body === 'object' ? request.body : {};
            const keys = Object.keys(body);
            // R1-06: the whitelist grows by one key and requires at least one of them, so
            // an unknown key (e.g. {systemRole:'admin'}) is still rejected with 400.
            const allowed = ['autoMemoryEnabled', 'searchEnabled'];
            if (!keys.length || keys.some(key => !allowed.includes(key))) fail(400, 'INVALID_PREFERENCES', '偏好设置无效。');
            for (const key of keys) if (typeof body[key] !== 'boolean') fail(400, 'INVALID_PREFERENCES', '偏好设置无效。');
            const current = db.prepare('SELECT auto_memory_enabled,search_enabled FROM users WHERE id=?').get(request.user.id);
            const autoMemoryEnabled = 'autoMemoryEnabled' in body ? body.autoMemoryEnabled : Boolean(current?.auto_memory_enabled);
            const searchEnabled = 'searchEnabled' in body ? body.searchEnabled : current?.search_enabled === undefined ? true : Boolean(current.search_enabled);
            db.prepare('UPDATE users SET auto_memory_enabled=?,search_enabled=?,updated_at=? WHERE id=?')
                .run(Number(autoMemoryEnabled), Number(searchEnabled), now(), request.user.id);
            audit(db, request.user, 'user.preferences', 'user', request.user.id, { autoMemoryEnabled, searchEnabled });
            response.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(request.user.id), db) });
        } catch (error) { next(error); }
    });

    return { router, requireUser, requireReadyUser, guardOrigin, bootstrap, hashPassword };
}
