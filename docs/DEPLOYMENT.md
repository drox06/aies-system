# Deployment and Operations Runbook

Written for a competent person who is not a DevOps engineer. Every step names the exact menu path
or command. If something here does not match what you see on screen, the vendor has changed their
UI — the *intent* of each step is stated so you can find the new location.

**Topology** (Spec.md §7.1): GitHub holds the source and runs CI. Vercel runs the app, its cron
jobs and TLS. Supabase holds Postgres and Storage. The Synology DS220+ holds backups. The NAS is
never the authoritative copy while the platform runs on Supabase — the sync is one direction only.

**Monthly cost at five users: roughly USD 45** — Vercel Pro ~$20, Supabase Pro ~$25, plus a few
dollars for email and the domain. §10 explains what makes that grow. Free tiers are fine for
evaluation but Supabase's free tier pauses on inactivity and has no point-in-time recovery: **do
not run the company on it.**

---

## 1. GitHub

The repository is the source of truth. Nothing reaches production except through it.

1. Repo: `github.com/drox06/aies-system`, private.
2. **Settings → Branches → Add branch ruleset**, targeting `main`:
   - Require a pull request before merging (1 approval).
   - Require status checks to pass → select `lint`, `typecheck`, `test`, `build`.
   - Block force pushes.
3. **Settings → Code security → Dependabot**: enable alerts and security updates.
   Spec.md §7.4 requires this plus a documented patch window (§11).
4. **Settings → Secrets and variables → Actions**, add:
   - `DATABASE_URL`, `DIRECT_URL` — the *production* Supabase URLs (§3), so CI can run
     `prisma migrate deploy` on merge.

**Migrations never run by hand against production.** They run in CI on merge to `main`. If you
ever find yourself typing `prisma migrate` against the production URL, stop: that is how a schema
and its migration history get out of sync, and Prisma cannot fix it for you afterwards.

---

## 2. Vercel

1. **Add New → Project**, import the GitHub repo. Framework preset: Next.js. Root directory: `./`.
2. **Settings → Environment Variables.** Add for **Production** and **Preview** separately:

   | Name | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | Supabase **pooled** URL, port 6543, `?pgbouncer=true` | The app. Serverless opens many short connections; the pooler is what stops that exhausting Postgres. |
   | `DIRECT_URL` | Supabase **session** URL, port 5432 | Prisma Migrate only. |
   | `AUTH_SECRET` | `openssl rand -base64 32` | Changing this signs everyone out. |
   | `AUTH_URL` | `https://erp.aieselectromech.com` | |
   | `AUTH_TRUST_HOST` | `true` | |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` | |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role JWT | **Server-side only.** Never prefix with `NEXT_PUBLIC_`. It bypasses every row-level security policy. |
   | `SUPABASE_STORAGE_BUCKET` | `aies-files` | |
   | `CRON_SECRET` | `openssl rand -hex 32` | Guards the cron endpoints. |

3. **Settings → Domains**: add `erp.aieselectromech.com`. Vercel shows a CNAME to create at your
   DNS provider. TLS is automatic once it resolves.
4. **Cron Jobs.** Declared in `vercel.json` (committed), not clicked in the UI:
   - `/api/cron/drain` every minute — relays the event outbox into the job queue. Without it,
     nothing that depends on an event ever happens.

   > Spec.md §7 also calls for a daily `/api/cron/nightly` (media-archive lifecycle, digest
   > email). **Not built as of module 00** — nothing yet needs it, and an endpoint that exists but
   > does nothing is worse than one that is honestly absent. Add it to `vercel.json` at
   > `0 18 * * *` (02:00 Manila) when module 10's lifecycle job lands.
5. Preview deploys are automatic per PR. Point them at a Supabase **branch** database (§3.6), never
   at production.

---

## 3. Supabase

1. Create the project (region **ap-southeast-1**, Singapore — nearest to Manila).
2. **Project Settings → Database → Connection string.** You need two, and they are not
   interchangeable:
   - **Transaction pooler**, port 6543 → `DATABASE_URL`. Append `?pgbouncer=true`.
   - **Session pooler**, port 5432 → `DIRECT_URL`.

   > Use the *session pooler* rather than the true direct host (`db.<ref>.supabase.co`) for
   > `DIRECT_URL`. The direct host is IPv6-only unless you buy the IPv4 add-on, and GitHub Actions
   > runners are IPv4. This is Supabase's own recommended pattern for Prisma.
   > (docs/DECISIONS.md #1 addendum.)

3. **Storage → New bucket**: name `aies-files`, **Private**. Or run `npm run storage:bucket`,
   which creates it idempotently. It must be private: downloads are issued as short-lived signed
   URLs after a server-side permission check (Spec.md §7.4), never served from a public bucket.
4. **Database → Extensions**: `pg_trgm` is enabled by a tracked migration, not by hand. `pg_cron`
   is only needed if you move the nightly job off Vercel Cron.
5. **Settings → Add-ons → Point in Time Recovery: ON.** This is the first line of recovery and the
   single most important switch on this page. Requires the Pro plan.
6. **Branching** (optional, for PR previews): **Database → Branches**. Each PR gets its own
   database so a migration is exercised before it reaches production.

---

## 3b. First logins — the step that locks people out if it is skipped

Do this **before the URL goes to anybody else**, and again every time an account is created.

The platform forces TOTP enrolment at first login and **has no TOTP reset in the admin UI**. That
absence is deliberate: an admin who can reset a second factor is a second factor that can be reset by
whoever compromises the admin. The consequence is that the recovery codes issued at enrolment are the
**only** way back in.

- [ ] Each of the five named users logs in once, sets their own password, and enrols an authenticator.
      EA has already done this.
- [ ] **Each person saves their recovery codes somewhere that is not the phone running the
      authenticator.** A wiped or lost phone with the codes on it is a permanent lockout, and nobody —
      including the president — can undo it from inside the app.
- [ ] The same applies to every account created later in Admin → Users. The screen says so beside the
      temporary password; say it out loud as well.

If somebody does get locked out with no codes, the only route is a direct database intervention, which
means a developer and downtime for that user. Cheaper to spend the minute now.

## 4. Email — SPF, DKIM, DMARC

Notification email is sent from `no-reply@aieselectromech.com`. Without these three records it
lands in spam, and a quotation approval nobody sees is worse than no email at all.

At your DNS provider, add:

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:<provider-spf-domain> ~all` |
| TXT | `<selector>._domainkey` | the DKIM key your provider issues |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:admin@aieselectromech.com; pct=100` |

Start DMARC at `p=none`, read the reports for two weeks, then move to `p=quarantine`. Going
straight to `p=reject` before SPF and DKIM are verified will silently drop your own mail.

Verify at [mail-tester.com](https://www.mail-tester.com) — aim for 10/10 before going live.

> **Not yet wired up.** The `notify_email` queue currently has no consumer by design
> (docs/DECISIONS.md #10); jobs dead-letter visibly rather than failing silently. Choose a provider
> and register a handler before relying on email.

---

## 5. NAS — nightly backup

**Create the share.** DSM → **Control Panel → Shared Folder → Create**:
- Name `aies-backups`, on a **Btrfs** volume (required for the snapshots in §7).
- Tick *Hide this shared folder in "My Network Places"* and *Encrypt this shared folder*.

**Install the tools.** DSM → **Package Center**: install *Text Editor* and enable **SSH**
(Control Panel → Terminal & SNMP → Enable SSH service). Then over SSH install `rclone` and the
Postgres client — on DSM 7 the simplest route is the Community package source, or run them from a
Docker container via **Container Manager**.

> **The Postgres client must be version 16 or newer.** Supabase runs Postgres 16, and `pg_dump`
> refuses to dump a server newer than itself. Synology's packaged client is routinely several major
> versions behind, and the error — `server version mismatch` — arrives only when the scheduled task
> first runs, where it reads like a connection fault. Check with `pg_dump --version` before
> scheduling anything; the script now refuses to start on an older client rather than failing
> obscurely at 02:00. If Package Center has nothing recent enough, run the dump from a
> `postgres:16-alpine` container via Container Manager, which is the more reliable route anyway.

> **DSM Task Scheduler runs with a minimal `PATH`.** A binary you installed and tested over SSH can
> still be "not found" when the task runs. Either use absolute paths in the task command, or export
> a `PATH` that includes them — see the task settings below.

**Configure rclone** for the Supabase storage bucket (S3-compatible):
```
rclone config
# n) New remote → name: aies-storage → type: s3 → provider: Other
# endpoint: https://<ref>.supabase.co/storage/v1/s3
# access_key_id / secret_access_key: Supabase → Project Settings → Storage → S3 access keys
```

**Schedule it.** DSM → **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined
script**:
- General: name `AIES nightly backup`, user `root`.
- Schedule: daily at **02:00** (after the Manila working day, before the morning).
- Task Settings → Run command:
  ```bash
  # PATH first: Task Scheduler does not inherit your SSH shell's environment.
  export PATH="/usr/local/bin:/opt/bin:/usr/bin:/bin:$PATH"
  export DIRECT_URL='postgresql://...:5432/postgres'
  export BACKUP_ROOT='/volume1/aies-backups'
  export RCLONE_REMOTE='aies-storage:aies-files'
  /volume1/aies-backups/bin/backup-to-nas.sh
  ```
- **`DIRECT_URL`, not the pooled URL.** `pg_dump` needs a real session; the pooler will refuse or
  truncate. It is the `:5432` host, not `:6543`.
- **Tick "Send run details by email" and "only when the script terminates abnormally".** A backup
  job that fails silently is the most common way companies discover they have no backups.

`scripts/backup-to-nas.sh` writes to `<date>.partial` and renames only on success, so an
interrupted run can never be mistaken for a good backup. It also runs `pg_restore --list` against
the dump before accepting it, refuses a dump under 1 KB, and refuses to run at all on a `pg_dump`
older than the server — a dump that cannot be read is not a backup, and neither is one that was
never written.

**Prove it before trusting it.** Run the task once by hand (Task Scheduler → select → *Run*), then:

```bash
ls -la /volume1/aies-backups/$(date +%F)/     # database.dump, storage/, manifest.json, toc.txt
cat /volume1/aies-backups/$(date +%F)/manifest.json
```

A `.partial` directory left behind means it failed; the log says on which line. The backup is not
finished being set up until §8's restore drill has been done once — until then it is an untested
assumption, not a backup.

---

## 6. NAS — the rest of what it does

**Btrfs snapshots** (protects the backups themselves from ransomware and mistakes):
**Snapshot Replication → Snapshots → Settings** on `aies-backups` — hourly, keep 24 hourly / 7
daily / 4 weekly. Tick *Make snapshot immutable*.

**Hyper Backup** (the off-site third copy): **Hyper Backup → Create → Folders and Packages** →
destination C2, another NAS, or Google Drive → source `aies-backups` → schedule daily 04:00 →
enable client-side encryption and **store the key somewhere that is not the NAS.**

That gives three copies, two media, one off-site.

**Synology Drive mirror** (Spec.md §7.2): **Synology Drive Admin Console → Team Folder** → enable
for the published-documents share, permission **read-only**, so the current SOP set is reachable
from the office even if the internet is down.

---

## 7. Monitoring

| What | Where | Alert to |
|---|---|---|
| Uptime on `/api/health` | any external checker, 1-minute interval | president, operations manager |
| Backup failure | DSM Task Scheduler email (§5) | admin manager |
| Volume above 80% | Control Panel → Notification → Rules | admin manager |
| Dead-lettered jobs | admin UI job queue view | operations manager |
| Vercel deploy failure | Vercel → Settings → Notifications | president |
| Supabase disk / connection limits | Supabase → Reports | president |

`/api/health` is deliberately unauthenticated and returns only liveness — it is safe to point a
third-party checker at it.

---

## 8. Quarterly restore drill

**A backup you have not restored is not a backup.** This is also ISO 9001 evidence, so the record
matters as much as the act.

1. Create a scratch database: Supabase → **Database → Branches**, or any throwaway Postgres.
2. Run:
   ```bash
   ./scripts/restore.sh /volume1/aies-backups/<date> "postgresql://.../aies_restore_test"
   ```
   It refuses to run against a database whose name does not contain `restore`, `scratch` or
   `test`. That guard is deliberate: the drill must never be the thing that damages production.
3. Work through the checklist the script prints, and record the result below.

| Date performed | By | Backup date restored | Result | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

*(Never performed as of module 00. The first drill is due once production data exists.)*

---

## 9. Patching

Second Tuesday of each month, 17:00 Manila:

1. Review Dependabot PRs. Security updates merge first.
2. `npm audit` — CI fails the build on high or critical.
3. Confirm the preview deploy is healthy, then merge.
4. Watch the production deploy and `/api/health`.

Anything rated critical is applied within 48 hours, not held for the window.

---

## 10. What makes the bill grow

In rough order of likelihood:

1. **Storage.** Site photos and video are the largest objects the system holds. The 12-month
   media-archive lifecycle job (module 10 §6) moves them to the NAS and keeps this flat — it is
   the main lever, and until it exists this line grows steadily.
2. **Database size.** Supabase Pro includes 8GB. `AuditLog` and `EventOutbox` grow forever by
   design; `Job` rows do not need to. Archive completed jobs before archiving anything else.
3. **Vercel function invocations.** The per-minute cron drain is the largest single contributor.
   If it becomes material, move the drain to `pg_cron` inside Supabase.
4. **Bandwidth.** Serving original-resolution images rather than the `sharp`-generated web
   derivative. The derivative already exists — check that call sites request it.

**Pull the storage lever first.** It is the largest, the easiest, and it does not degrade anything
anyone experiences.

---

## 11. Self-host fallback

Not the deployment path, kept working so AIES is never locked in (Spec.md §7.2). CI boots it on
every push, because a fallback nobody exercises rots within two months.

Requires a host with **6GB RAM** — the current DS220+ has 2GB and cannot run it, which is why
Vercel and Supabase were chosen (Spec.md §3.1).

```bash
cp .env.example docker/.env     # set POSTGRES_PASSWORD, AUTH_SECRET, APP_DOMAIN
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml exec app npx prisma migrate deploy
docker compose -f docker/docker-compose.yml exec app npm run seed
```

Caddy obtains TLS automatically once `APP_DOMAIN` resolves to the host. Migrations also run on
every container start, so a redeploy needs no manual step.

To move the data across: restore the newest NAS dump into the compose Postgres with
`scripts/restore.sh` (using `ALLOW_UNSAFE_TARGET=1`, since this is a real recovery rather than a
drill), and `rclone sync` the storage directory back into whatever object store you point
`SUPABASE_URL` at.
