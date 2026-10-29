# Internal assistant implementation contract

## Delivery and invariants

Implement the accepted internal assistant plan for 2–30 employees at https://8.134.141.217:6069. Keep the existing optimized application unchanged. Browser/PWA only; includes scoped uploaded-document retrieval; no image generation, web search, task board or APK. The original internal.weizhiyu.top entry remains closed until separately configured.

System admins can read all conversations and all memories through dedicated read-only audit endpoints. Project admins can read every conversation in their administered project and review project memory candidates, but cannot directly read others' private memory libraries. Ordinary users can read their own conversations and private memories plus active shared memories in projects they belong to. Neither audit role expands normal chat context. All access decisions use current database roles, not client-supplied claims.

Use Express 4, better-sqlite3, Node 24 LTS, ESM, opaque server-side sessions, scrypt password-only login, Secure/HttpOnly host-only cookies and Origin plus authenticated CSRF checks. API JSON responses use camelCase. Timestamps are milliseconds. SQLite columns use snake_case. Errors are `{error:{code,message}}`, with safe user-facing messages. No real provider calls in automated tests.

## Shared modules

- `lib/errors.js`: export `AppError(status,code,message)`, `fail(status,code,message)` which throws, and `asyncRoute(handler)`.
- `lib/database.js`: export `openDatabase(filename)`, returning the better-sqlite3 database with WAL, foreign keys, bounded busy timeout and core tables initialized. All writes/transactions are short and never span provider requests.
- `lib/access.js`: export `projectRole(db,user,projectId)` (`admin`, `member` or null), `requireProjectMember(db,user,projectId)`, `requireProjectAdmin(db,user,projectId)`, `requireSystemAdmin(user)` and `audit(db,user,action,targetType,targetId,details={})`. `requireReadyEmployee(db,user)` returns `{row,user}` after a fresh account check; `requireProjectContext(db,user,projectId,{write,archivedMessage})` returns `{project,role}`. `assertProjectAdminRemovable(db,projectId,targetUserId,nextRole)` protects the final effective administrator and is shared by both management entrypoints. These throw AppError on denial. System role is not implicitly project membership/adminship.
- `lib/auth.js`: export `createAuth({db,config})` returning `{router,requireUser,requireReadyUser,guardOrigin,bootstrap}`. Middleware sets `req.user` and `req.session` (session id, csrf token). `requireUser` also enforces CSRF on non-GET/HEAD/OPTIONS authenticated requests. `guardOrigin` rejects unsafe requests unless Origin equals config.origin, including login. Bootstrap initializes the initial system admin only when the user table is empty.
- `lib/projects.js`: export `createProjectsRouter({db})`.
- `lib/admin.js`: export `createAdminRouter({db,auth})`.
- `lib/memory.js`: export `createMemoryService({db,config,provider})` returning `{router,start,stop,enqueueTurn,retrieve,health}`. Memory service initializes its own memories/jobs/index schema. `enqueueTurn({userId,conversationId,userMessageId,assistantMessageId})` runs after a completed persisted answer. `retrieve({user,projectId,query})` returns `{memories:[public memory objects],degraded:boolean}` and never uses audit visibility. `provider` has `extractMemory(input,{signal})` and `embed(texts,{signal})`. Source authorization must be rechecked both in extraction and on committing results.
- `lib/chat.js` is the stable service facade, assembling `chat-routes.js` (HTTP/SSE), `chat-service.js` (conversation business logic and context) and `chat-runner.js` (durable queue, generation and recovery). The server consumes the same `router/start/stop/snapshot/health` interface. See ARCHITECTURE.md for frontend and document module boundaries.

`config` is dependency-injected. Shape: `{origin,cookieName,secureCookies,sessionTtlMs,encryptionKey,bootstrapUsername,bootstrapPassword,chatModel,memoryModel,embeddingModel,apiBase,apiKey,dataDirectory,port,host}`. `encryptionKey` is a 32-byte Buffer. Public actor shape: `{id,username,displayName,systemRole:'admin'|'member',autoMemoryEnabled,mustChangePassword,mfaEnabled}`. Never expose hashes, secret values or full session records.

## Core database tables (database agent owns schema)

- `users`: id, username UNIQUE, display_name, password_hash, system_role, active, must_change_password, auto_memory_enabled, mfa_secret, mfa_last_step, created_at, updated_at. mfa_secret is encrypted, nullable.
- `sessions`: id (opaque-token hash), user_id, csrf_token, pending_mfa_secret, created_at, expires_at. Pending secret encrypted. User/session validation occurs each request.
- `projects`: id, name, description, instructions, archived, created_by, created_at, updated_at.
- `project_members`: project_id, user_id, role, created_at; composite primary key and foreign keys.
- `conversations`: id, user_id, project_id nullable, title, memory_enabled, summary, summary_message_id nullable, deleted_at nullable, created_at, updated_at.
- `messages`: id, conversation_id, role (`user` or `assistant`), content, status (`complete`,`generating`,`stopped`,`failed`,`interrupted`), metadata (JSON text default `{}`), created_at, updated_at.
- `chat_runs`: id, conversation_id, user_id, request_id, input_hash, user_message_id, assistant_message_id, state (`queued`,`running`,`completed`,`stopped`,`failed`,`interrupted`), error_code nullable, created_at, updated_at; unique(user_id,request_id). Metadata persists memory references used for that answer.
- `audit_records`: id, actor_id, action, target_type, target_id, details (JSON without full content), created_at. No update/delete API.

All ids are UUIDs. Defaults: active=1, must_change_password=0, auto_memory_enabled=1, archived=0, memory_enabled=1, description/instructions/summary/content empty strings. Session/user/project foreign keys are indexed. Audit tables should retain evidence if user state changes.

## Authentication API (router mounted at /api/auth)

- POST `/login` `{username,password}` -> `{user,csrfToken}` plus session cookie. All roles use passwords only, including accounts with legacy TOTP bindings. Initial accounts get restricted sessions until their first password change.
- GET `/me` -> `{user,csrfToken}` or 401.
- POST `/logout` -> `{ok:true}` and expires cookie.
- POST `/password` `{currentPassword,newPassword}` -> `{user,csrfToken}`; invalidates other sessions and rotates the current session.
- POST `/mfa/setup` and `/mfa/confirm` are retired compatibility endpoints and return `410 MFA_RETIRED` after normal authentication and CSRF checks. They never expose or update legacy secrets.
- PATCH `/preferences` `{autoMemoryEnabled}` -> `{user}`.

`requireReadyUser` blocks workspace APIs with `PASSWORD_CHANGE_REQUIRED` until satisfied. Auth/me/password/logout remain usable. Admin routes require the current active system administrator role. Legacy MFA setup/confirm endpoints return 410 after authentication and CSRF validation.

## Project and admin APIs

- GET `/api/admin/control-panel` -> `{summary,users,projects,hasMore,limit,offset}`; current system administrators only. Supports bounded `q`, `systemRole`, `status` and pagination filters.
- DELETE `/api/admin/users/:id` soft-deletes and disables an account, revokes every session and preserves historical data. POST `.../:id/restore` restores it as disabled; explicit enabling is required.
- GET `/api/admin/users/:id/projects` lists all project memberships for access administration. PUT/DELETE `.../:id/projects/:projectId` assigns or revokes project roles without automatically joining the acting system administrator.
- Self-administration protections, the last active system administrator and the final active administrator of each live project are enforced transactionally. Archived project membership is read-only. Deleted accounts cannot be enabled or modified through ordinary update routes.

- GET `/api/projects` -> `{projects}`; only active memberships, including archived projects.
- POST `/api/projects` `{name,description?,instructions?}` -> `{project}`; creator is project admin.
- PATCH `/api/projects/:id` `{name?,description?,instructions?,archived?}` -> `{project}`; project admins only.
- GET `/api/projects/:id/members` -> `{members}`; current members.
- PUT `/api/projects/:id/members/:userId` `{role}` and DELETE same path; project admins, prevent removal/demotion of final admin; archived project is read-only.
- GET `/api/users/directory` -> `{users:[{id,username,displayName}]}`; active employee names only.
- GET/POST `/api/admin/users`, PATCH `/api/admin/users/:id`, POST `/api/admin/users/:id/reset-password` (body `{password}`); strict fields, never permit self/final active admin removal, log changes. Creation accepts `{username,displayName,password,systemRole?}`; new passwords require change.
- GET `/api/admin/audit/conversations?userId=&projectId=&q=` -> `{conversations}`; list limited to safe paginated records, all scopes visible. GET `.../conversations/:id` -> `{conversation,messages}`. Both log access and never mutate chat content.
- GET `/api/admin/audit/memories?userId=&projectId=&q=` -> `{memories}` and GET `/api/admin/audit/events` -> `{events}`. Admin agent may register this route using memory tables once initialized; do not require private library access through normal routes.

## Conversation/chat APIs (root owns)

- GET `/api/conversations?projectId=` -> `{conversations}`. Omitted project means own personal chats. Project list includes others' conversations only when current user is that project's admin; each row has `readOnly` and `ownerName`.
- POST `/api/conversations` `{projectId?,title?,memoryEnabled?}` -> `{conversation}`.
- GET `/api/conversations/:id` -> `{conversation,messages,run?}`; owner or current project admin, log non-owner read. PATCH same path `{title?,memoryEnabled?}` and DELETE only owner; project archived means read-only.
- POST `/api/chat/runs` `{conversationId,message,requestId}` -> `{run}`; only owner, ready/active project membership, no other active run in same conversation, user-bound idempotency with conflicting payload rejected.
- GET `/api/chat/runs/:id` -> `{run,message}`; normal read authorization; POST `.../:id/stop` only owner.
- GET `/api/chat/runs/:id/events` SSE authenticated, read-only subscription, snapshots and deltas, durable final message is authoritative. Tokens never appear in URLs. Disconnect does not cancel upstream, explicit stop does.

## Memory API (memory agent owns)

- GET `/api/memories?scope=personal|project_private|project_shared&projectId=&q=` -> `{memories}`. Private libraries remain own-only even for admin accounts. Shared lists include active shared entries to members; candidate entries to author/project admins. System audit uses separate admin router.
- POST `/api/memories` `{scope,projectId?,content}` -> `{memory}`. Own private entries active; project_shared becomes candidate unless creator is current project admin.
- PATCH `/api/memories/:id` `{content?,active?}` and DELETE same path. Private entries only owner; shared entries only project admin (candidate author may withdraw own pending candidate). Audit access never grants mutation.
- POST `/api/memories/:id/review` `{decision:'approve'|'reject'}` only current project admin.
- GET `/api/memory/jobs?conversationId=` -> `{jobs}` own source only; POST `/api/memory/jobs/:id/retry` explicit retry, never regenerate chat.
- Memory object minimum fields `{id,scope,projectId,userId,content,status,createdAt,updatedAt,sourceConversationId?,sourceMessageId?,canEdit,canReview}`. Schema must support provenance, version/tombstone guards, embedding model/dimension metadata and background job state.

## Frontend

The uploaded-document library follows the same personal/project-private/project-shared scopes and uses dedicated read-only global file audit routes. Shared file candidates require project administrator approval. Once approved, shared files belong to the project: uploader disable/departure does not prevent current administrators from rebuilding indexes or managing the files. Private files and pending candidates retain author authorization. See KNOWLEDGE.md for parser limits, durable processing, retrieval revalidation, preview and download routes.

Left: brand, own chats, project selector/list. Center: safe streamed Markdown conversation, mobile-safe composer, explicit project/admin visibility notice. Memory library with scope selector/editor/candidate review and per-answer memory references. Project details/membership management. User preferences and first-login password setup. System-only account management and global audit view; project admin can open readonly member chats. Audit UI must not offer compose/edit controls for others.

Never persist raw conversations/memories in localStorage or Service Worker. Drafts are user+conversation bound sessionStorage, cleared on logout/account switch. Theme is safe local preference. PWA shell cache prefix must be internal-specific; API is network-only. All dialogs must fit 390px and use 16px inputs, 44px touch targets, safe-area/visualViewport keyboard handling.

## Completion evidence

Automated tests for every role boundary/revocation, admin readonly audit, password authentication/CSRF, idempotent durable generation/stop/reload, scoped semantic retrieval, extraction conflicts and deleted memory not resurrecting, disabled memory, source access and private browser storage. Browser validate desktop/390px flows and no console errors. Actual Node24 Linux staging tests, database restore drill, TLS/domain checks, provider smoke using non-sensitive synthetic data. DNS points internal.weizhiyu.top to 8.134.141.217; the user confirmed ICP filing and Alibaba access completion on 2026-10-27. Do not substitute UI-only stubs for working APIs.
