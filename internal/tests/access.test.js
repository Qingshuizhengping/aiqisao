import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.js';
import { assertProjectAdminRemovable, requireProjectContext, requireReadyEmployee } from '../lib/access.js';

function accessFixture(context) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    const employee = (id, role = 'member') => {
        db.prepare('INSERT INTO users(id,username,display_name,password_hash,system_role) VALUES(?,?,?,?,?)')
            .run(id, id, id, 'private-password-hash', role);
        return { id, systemRole: role, mustChangePassword: false };
    };
    const owner = employee('owner');
    const admin = employee('system-admin', 'admin');
    db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('project', 'Project', owner.id, 1, 1);
    db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,'admin',?)").run('project', owner.id, 1);
    return { db, employee, owner, admin };
}

const hasCode = (code, status) => error => error.code === code && error.status === status;

test('ready employee access rereads account lifecycle and exposes an explicit raw/public pair', context => {
    const { db, owner } = accessFixture(context);
    const initial = requireReadyEmployee(db, owner);
    assert.equal(initial.row.password_hash, 'private-password-hash');
    assert.equal(initial.user.id, owner.id);
    assert.equal('password_hash' in initial.user, false);
    db.prepare("UPDATE users SET display_name='Current name',system_role='admin' WHERE id=?").run(owner.id);
    assert.equal(requireReadyEmployee(db, owner).user.displayName, 'Current name');
    assert.equal(requireReadyEmployee(db, owner).user.systemRole, 'admin');
    db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(owner.id);
    assert.throws(() => requireReadyEmployee(db, owner), hasCode('PASSWORD_CHANGE_REQUIRED', 428));
    db.prepare('UPDATE users SET must_change_password=0,active=0 WHERE id=?').run(owner.id);
    assert.throws(() => requireReadyEmployee(db, owner), hasCode('AUTH_REQUIRED', 401));
    db.prepare('UPDATE users SET deleted_at=1 WHERE id=?').run(owner.id);
    assert.throws(() => requireReadyEmployee(db, owner), hasCode('AUTH_REQUIRED', 401));
    assert.throws(() => requireReadyEmployee(db, { id: 'missing' }), hasCode('AUTH_REQUIRED', 401));
});

test('project context preserves explicit membership, archive reads and write denial after live changes', context => {
    const { db, owner, admin } = accessFixture(context);
    assert.equal(requireProjectContext(db, owner, 'project').role, 'admin');
    assert.throws(() => requireProjectContext(db, admin, 'project'), hasCode('PROJECT_ACCESS_DENIED', 403));
    db.prepare('UPDATE projects SET archived=1 WHERE id=?').run('project');
    assert.equal(requireProjectContext(db, owner, 'project').project.archived, 1);
    assert.throws(() => requireProjectContext(db, owner, 'project', { write: true, archivedMessage: 'Custom archive explanation' }),
        error => hasCode('PROJECT_ARCHIVED', 409)(error) && error.message === 'Custom archive explanation');
    db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run('project', owner.id);
    assert.equal(requireProjectContext(db, owner, 'project').role, 'member');
    db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run('project', owner.id);
    assert.throws(() => requireProjectContext(db, owner, 'project'), hasCode('PROJECT_ACCESS_DENIED', 403));
});

test('the final-admin invariant ignores inactive targets and counts only other live project administrators', context => {
    const { db, owner, employee } = accessFixture(context);
    const backup = employee('backup');
    db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,'admin',?)").run('project', backup.id, 1);
    assert.doesNotThrow(() => assertProjectAdminRemovable(db, 'project', owner.id, 'member'));
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(backup.id);
    assert.throws(() => assertProjectAdminRemovable(db, 'project', owner.id, null), hasCode('LAST_PROJECT_ADMIN', 409));
    assert.doesNotThrow(() => assertProjectAdminRemovable(db, 'project', backup.id, null));
    db.prepare('UPDATE users SET deleted_at=1 WHERE id=?').run(backup.id);
    assert.doesNotThrow(() => assertProjectAdminRemovable(db, 'project', backup.id, null));
    assert.doesNotThrow(() => assertProjectAdminRemovable(db, 'project', owner.id, 'admin'));
    assert.doesNotThrow(() => assertProjectAdminRemovable(db, 'project', 'missing', null));
});
