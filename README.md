# ProjectFinder

A project-collaboration site: post a project, find people, connect with them,
ask to join a team, or invite someone onto yours.

Express + Supabase (Auth, Postgres, Storage). The frontend is plain HTML/CSS/JS
served by the same Express process, so there is no CORS or separate build step.

---

## Setup (3 steps)

### 1. Database

Open your Supabase project -> **SQL Editor** -> **New query**, paste in
**`backend/database-setup.sql`**, and run it.

That one file is the whole schema. It is idempotent: safe on a fresh project
and safe to re-run on the database you already have, without losing data.
(It replaces all the old separate migration files, which had drifted out of
sync with the code and caused most of the errors you were seeing.)

### 2. Auth settings

In Supabase:

- **Authentication -> Providers -> Email**: enable **Confirm email**.
- **Authentication -> URL Configuration**: set Site URL to `http://localhost:3000`
  and add these redirect URLs:
  - `http://localhost:3000/verify-email.html?status=verified`
  - `http://localhost:3000/reset-password.html`

### 3. Run it

```bash
cd backend
npm install
npm start
```

Then open http://localhost:3000

---

## Checking the database is connected

On startup the server verifies every table and column it needs and prints
either:

```
Database check: OK — every table and column the app needs is present.
```

or a list naming exactly what is missing. You can check the same thing at any
time by opening:

```
http://localhost:3000/api/health
```

If it reports something missing, re-run `backend/database-setup.sql`.

---

## Tests

```bash
cd backend
npm test
```

This runs the real server against an in-memory stand-in for Supabase and
drives the full flow over HTTP: register, log in, connect, request to join,
invite, accept, leave, rejoin, plus the permission rules. 29 checks.

It does **not** test your live Supabase — use `/api/health` for that.

---

## How the two joining flows work

There are two ways someone ends up on a team. They are mirror images.

**Join request** — someone asks to join your project.
1. They open a project and press **Request to join** (Browse projects, or the
   project page).
2. You get a notification, and the request appears under
   *My Teams -> Join requests for my projects*.
3. You Accept or Reject. Accepting adds them to the roster and notifies them.

**Invitation** — you ask someone to join your project.
1. On *My Teams*, find the team you own and use **Invite someone to this team**.
   Enter their public ID (`PTF-XXXXX`) or `@username`, and optionally a role.
2. They get a notification, and it appears under *My Teams -> Invitations for you*.
3. They Accept or Decline. Accepting adds them to the roster and notifies you.
   You can Withdraw a pending invitation from your team card.

Either way the team respects the project's member limit, and the roster shows
everyone with their role. Owners can remove a member; members can leave and
can be invited back later.

---

## Security note

`backend/.env` holds your Supabase keys, including the **service-role key**,
which bypasses all row-level security. Never commit it and never put it in
frontend code. If it has ever been shared or committed, rotate it in
**Supabase -> Settings -> API**.
