# Employee permissions proposal — DESIGN ONLY

Project nmhefwvhoholcjrbbila. No schema, permission or UI rollout authorized by this file.

## Verified current baseline

Production tenants.user_id is the owner. No verified public staff / tenant_memberships table is present. Current read-only DeliveryReviewPanel is restricted to an authenticated owner via server ownedTenant(). Do not broaden without independent approval.

## Proposed future tenant_memberships table

- tenant_id uuid NOT NULL FK tenants(id) ON DELETE CASCADE
- user_id uuid NOT NULL FK auth.users(id) ON DELETE CASCADE
- role enum-like text ('admin','agent','auditor') NOT NULL
- status text ('invited','active','suspended') NOT NULL
- invited_by uuid nullable FK auth.users
- created_at / updated_at timestamptz
- composite PRIMARY KEY (tenant_id,user_id)
- RLS ON; no direct INSERT/UPDATE/DELETE permission for browser roles
- Owner remains tenants.user_id; no owner row duplicated, no non-owner may demote owner
- Member may belong to several tenants; server requires explicit selection and validates membership every request.

## Role access matrix

| Capability | Owner | Admin | Agent | Auditor |
|---|---|---|---|---|
| View uncertain delivery inbox | all tenant | all tenant | assigned conversations only | redacted metadata |
| Reply or take human takeover | yes | yes | assigned only | no |
| Mark uncertain outcome after provider verification | yes | yes | assigned with dual-control for resend | no |
| Invite/suspend users | yes | limited, not owner/admin | no | no |
| Publish/activate flows/change credit | yes | separate granular approval | no | no |
| Metrics | all | all | assigned subset | aggregate |
| View decrypted tokens, service keys | never in UI | never | never | never |

## Enforcement requirements

- Resolve JWT via server auth.getUser, not tenant_id from request body.
- Verify active membership + tenant/account/conversation composite ownership before RPC.
- Suspended or removed membership loses access immediately, fail closed.
- Never expose service_role client to browser. No anon table SELECT of review/credit records.
- Audit privileged actions with actor, tenant, action, object ref, timestamp and outcome, without raw chat or secrets.
- One-time expiring invites and no delegated owner permission.
- Restrict tenant-scoped SQL functions with security-invoker where possible, qualified objects and search_path empty.
- Prevent circular RLS policy via reviewed authorization function.

## Tests required before any GO

1. User A cannot read B conversation/review/metrics or take actions even with forged tenant_id.
2. Suspended agent cannot access data; agent cannot publish/activate, auditor cannot write.
3. Owner retains access without membership row; one user in two tenants cannot leak cross-tenant data.
4. Browser auth missing/expired returns 401, nonmember returns 403.
5. Invitation concurrency never duplicates rows; client never receives Meta tokens.
6. Verify staff notification/assignment is tenant-bound and duplicate-safe.

## Independent approvals needed

GO-R1 create tenant membership SQL with RLS, GO-R2 deploy server role authorization, GO-R3 enable staff UI. They are NOT implemented or authorized here.
