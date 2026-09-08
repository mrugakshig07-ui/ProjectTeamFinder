// ============================================================
// End-to-end flow test.
//
//   node test/flows.test.js
//
// It loads the REAL server.js but swaps @supabase/supabase-js for the
// in-memory fake, then drives the API over HTTP exactly like the browser
// does: register, log in, connect, request to join, invite, accept.
//
// This proves the request/response logic is correct. It does NOT test your
// live Supabase — for that, run the server and open /api/health.
// ============================================================
const assert = require("assert");
const path = require("path");
const { createFakeClient, uuid } = require("./fake-supabase");

const store = {
    profiles: [], projects: [], education: [], skills: [], user_skills: [],
    project_members: [], user_settings: [], follows: [], notifications: [],
    connection_requests: [], project_requests: [], project_invitations: []
};
const authState = { users: [], sessions: new Map(), refresh: new Map() };

// Swap the Supabase driver before server.js is required.
const supabaseModulePath = require.resolve("@supabase/supabase-js");
require.cache[supabaseModulePath] = {
    id: supabaseModulePath, filename: supabaseModulePath, loaded: true,
    exports: { createClient: () => createFakeClient(store, authState) }
};

const PORT = 4517;
process.env.PORT = String(PORT);
process.env.APP_URL = `http://localhost:${PORT}`;
process.env.SUPABASE_URL = "http://fake.local";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

require(path.join(__dirname, "..", "server.js"));

const base = `http://localhost:${PORT}`;

// Minimal cookie jar so each test user keeps their own session.
function newSession() {
    return { cookies: new Map() };
}
async function call(session, method, url, body) {
    const headers = { "Content-Type": "application/json" };
    if (session && session.cookies.size) {
        headers.Cookie = [...session.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const cookie of raw) {
        const [pair] = cookie.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (session) { if (value) session.cookies.set(name, value); else session.cookies.delete(name); }
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) { payload = null; }
    return { status: response.status, body: payload };
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (error) { console.error(`  FAIL  ${name}\n        ${error.message}`); failed++; }
}

async function signUp(name, username, email) {
    const session = newSession();
    const registered = await call(session, "POST", "/api/register", { name, username, email, password: "password123" });
    assert.strictEqual(registered.body.success, true, `register ${username}: ${registered.body && registered.body.message}`);
    const loggedIn = await call(session, "POST", "/api/login", { email, password: "password123", rememberMe: true });
    assert.strictEqual(loggedIn.body.success, true, `login ${username}: ${loggedIn.body && loggedIn.body.message}`);
    const me = await call(session, "GET", "/api/me");
    return { session, profile: me.body.user };
}

(async () => {
    await new Promise(resolve => setTimeout(resolve, 400)); // let the server bind
    console.log("\nProjectFinder flow tests\n");

    const owner = await signUp("Asha Owner", "asha", "asha@example.com");
    const joiner = await signUp("Ravi Joiner", "ravi", "ravi@example.com");
    const invitee = await signUp("Meera Invitee", "meera", "meera@example.com");

    await test("register + login issues a working session", async () => {
        const me = await call(owner.session, "GET", "/api/me");
        assert.strictEqual(me.body.user.username, "asha");
        assert.match(me.body.user.public_id, /^PTF-[2-9A-Z]{5}$/);
    });

    await test("session survives an expired access token via the refresh cookie", async () => {
        const stale = newSession();
        stale.cookies.set("refresh_token", [...owner.session.cookies.entries()].find(([name]) => name === "refresh_token")[1]);
        stale.cookies.set("session_token", "expired-token");
        const me = await call(stale, "GET", "/api/me");
        assert.strictEqual(me.body.success, true, "expired access token should be refreshed, not rejected");
    });

    let projectId;
    await test("owner can post a project", async () => {
        const created = await call(owner.session, "POST", "/api/projects", {
            title: "Tidal Mapper", description: "Ocean data visualiser", skills: "Godot, GDScript",
            category: "Games", status: "Open", rolesNeeded: "Developer", availability: "Weekends", maxMembers: 3
        });
        assert.strictEqual(created.body.success, true, created.body && created.body.message);
        projectId = created.body.project.id;
    });

    // ---------- connection requests ----------
    await test("connection request: send, appear for receiver, accept", async () => {
        const sent = await call(joiner.session, "POST", `/api/profiles/${owner.profile.public_id}/connect`, {});
        assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

        const inbox = await call(owner.session, "GET", "/api/connection-requests");
        assert.strictEqual(inbox.body.requests.length, 1, "receiver should see one pending request");
        assert.strictEqual(inbox.body.requests[0].profile.username, "ravi");

        const outbox = await call(joiner.session, "GET", "/api/connection-requests");
        assert.strictEqual(outbox.body.sent.length, 1, "sender should see their own pending request");

        const accepted = await call(owner.session, "PUT", `/api/connections/${inbox.body.requests[0].id}`, { status: "accepted" });
        assert.strictEqual(accepted.body.success, true, accepted.body && accepted.body.message);

        const connections = await call(owner.session, "GET", "/api/connections");
        assert.strictEqual(connections.body.connections.length, 1);
        assert.strictEqual(connections.body.connections[0].username, "ravi");
    });

    await test("connection accepted notifies the original sender", async () => {
        const notifications = await call(joiner.session, "GET", "/api/notifications");
        assert.ok(notifications.body.notifications.some(item => item.type === "connection_accepted"),
            "sender should get a connection_accepted notification");
    });

    await test("duplicate connection request is rejected", async () => {
        const again = await call(joiner.session, "POST", `/api/profiles/${owner.profile.public_id}/connect`, {});
        assert.strictEqual(again.status, 409, "already connected should be a 409");
    });

    // ---------- join requests ----------
    let requestId;
    await test("join request: send, owner sees it", async () => {
        const requested = await call(joiner.session, "POST", `/api/projects/${projectId}/request`, { message: "I know Godot" });
        assert.strictEqual(requested.status, 201, JSON.stringify(requested.body));

        const pending = await call(owner.session, "GET", "/api/my-project-requests");
        assert.strictEqual(pending.body.requests.length, 1, "owner should see the join request");
        assert.strictEqual(pending.body.requests[0].profile.username, "ravi");
        assert.strictEqual(pending.body.requests[0].message, "I know Godot");
        requestId = pending.body.requests[0].id;
    });

    await test("owner accepting a join request adds the member to the team", async () => {
        const accepted = await call(owner.session, "PUT", `/api/project-requests/${requestId}`, { status: "accepted" });
        assert.strictEqual(accepted.body.success, true, accepted.body && accepted.body.message);

        const teams = await call(owner.session, "GET", "/api/my-teams");
        const team = teams.body.teams.find(entry => entry.project.id === projectId);
        assert.ok(team, "owner should see the team");
        assert.strictEqual(team.members.length, 2, "roster should be owner + new member");
        assert.deepStrictEqual(team.members.map(member => member.team_role).sort(), ["Member", "Owner"]);

        const joinerTeams = await call(joiner.session, "GET", "/api/my-teams");
        assert.strictEqual(joinerTeams.body.teams.length, 1, "the joiner should now see the team too");
    });

    await test("accepted requester is notified", async () => {
        const notifications = await call(joiner.session, "GET", "/api/notifications");
        assert.ok(notifications.body.notifications.some(item => item.type === "project_request_accepted"));
        assert.ok(notifications.body.unread > 0, "unread count should be reported");
    });

    // ---------- invitations ----------
    let invitationId;
    await test("owner can invite a member by public ID", async () => {
        const invited = await call(owner.session, "POST", `/api/projects/${projectId}/invite`, { publicId: invitee.profile.public_id, role: "Designer" });
        assert.strictEqual(invited.status, 201, JSON.stringify(invited.body));
    });

    await test("invitee sees the invitation and the inviter", async () => {
        const invitations = await call(invitee.session, "GET", "/api/my-invitations");
        assert.strictEqual(invitations.body.invitations.length, 1, "invitee should see one invitation");
        const invitation = invitations.body.invitations[0];
        assert.strictEqual(invitation.project.title, "Tidal Mapper");
        assert.strictEqual(invitation.profile.username, "asha");
        assert.strictEqual(invitation.role, "Designer");
        invitationId = invitation.id;
    });

    await test("invitee gets a team_invitation notification", async () => {
        const notifications = await call(invitee.session, "GET", "/api/notifications");
        assert.ok(notifications.body.notifications.some(item => item.type === "team_invitation"));
    });

    await test("owner sees the pending invitation on the team card", async () => {
        const teams = await call(owner.session, "GET", "/api/my-teams");
        const team = teams.body.teams.find(entry => entry.project.id === projectId);
        assert.strictEqual(team.pending_invitations.length, 1);
        assert.strictEqual(team.pending_invitations[0].profile.username, "meera");
    });

    await test("someone else cannot accept an invitation addressed to another user", async () => {
        const stolen = await call(joiner.session, "PUT", `/api/project-invitations/${invitationId}`, { status: "accepted" });
        assert.strictEqual(stolen.status, 403, "only the invitee may accept");
    });

    await test("invitee accepting joins the team", async () => {
        const accepted = await call(invitee.session, "PUT", `/api/project-invitations/${invitationId}`, { status: "accepted" });
        assert.strictEqual(accepted.body.success, true, accepted.body && accepted.body.message);

        const teams = await call(owner.session, "GET", "/api/my-teams");
        const team = teams.body.teams.find(entry => entry.project.id === projectId);
        assert.strictEqual(team.members.length, 3, "roster should now be owner + 2 members");
        assert.ok(team.members.some(member => member.username === "meera" && member.team_role === "Designer"),
            "the invited role should be kept");
        assert.strictEqual(team.pending_invitations.length, 0, "the invitation should no longer be pending");
    });

    await test("inviter is notified that the invitation was accepted", async () => {
        const notifications = await call(owner.session, "GET", "/api/notifications");
        assert.ok(notifications.body.notifications.some(item => item.type === "team_invitation_accepted"));
    });

    // ---------- capacity ----------
    await test("a full team refuses further join requests", async () => {
        const fourth = await signUp("Dev Four", "devfour", "four@example.com");
        const requested = await call(fourth.session, "POST", `/api/projects/${projectId}/request`, {});
        assert.strictEqual(requested.status, 400, "maxMembers was 3 and the team is full");
        assert.match(requested.body.message, /full/i);
    });

    // ---------- leaving and rejoining ----------
    await test("a member can leave, and the freed seat is reusable", async () => {
        const left = await call(invitee.session, "DELETE", `/api/projects/${projectId}/members/${invitee.profile.public_id}`);
        assert.strictEqual(left.body.success, true, left.body && left.body.message);

        const teams = await call(owner.session, "GET", "/api/my-teams");
        const team = teams.body.teams.find(entry => entry.project.id === projectId);
        assert.strictEqual(team.members.length, 2, "the member who left should be off the roster");

        // Rejoining used to fail on the project_members primary key.
        const reinvited = await call(owner.session, "POST", `/api/projects/${projectId}/invite`, { publicId: invitee.profile.public_id });
        assert.strictEqual(reinvited.status, 201, JSON.stringify(reinvited.body));
        const invitations = await call(invitee.session, "GET", "/api/my-invitations");
        const accepted = await call(invitee.session, "PUT", `/api/project-invitations/${invitations.body.invitations[0].id}`, { status: "accepted" });
        assert.strictEqual(accepted.body.success, true, accepted.body && accepted.body.message);
    });

    await test("owner can remove a member", async () => {
        const removed = await call(owner.session, "DELETE", `/api/projects/${projectId}/members/${invitee.profile.public_id}`);
        assert.strictEqual(removed.body.success, true, removed.body && removed.body.message);
        const teams = await call(owner.session, "GET", "/api/my-teams");
        const team = teams.body.teams.find(entry => entry.project.id === projectId);
        assert.strictEqual(team.members.length, 2);
    });

    await test("a member cannot remove someone else", async () => {
        const attempt = await call(joiner.session, "DELETE", `/api/projects/${projectId}/members/${owner.profile.public_id}`);
        assert.strictEqual(attempt.status, 400, "the owner can never be removed");
    });

    // ---------- search ----------
    await test("member search by name works (previously returned nothing)", async () => {
        const found = await call(owner.session, "GET", "/api/members?q=Ravi");
        assert.strictEqual(found.body.success, true, JSON.stringify(found.body));
        assert.ok(found.body.members.some(member => member.username === "ravi"),
            "searching a member's name must find them even with no matching skill or school");
    });

    await test("member search by public ID works", async () => {
        const found = await call(owner.session, "GET", `/api/members?q=${joiner.profile.public_id}`);
        assert.ok(found.body.members.some(member => member.username === "ravi"));
    });

    await test("project discovery reports team size and request state", async () => {
        const discovered = await call(joiner.session, "GET", "/api/projects/discover");
        const project = discovered.body.projects.find(entry => entry.id === projectId);
        assert.ok(project, "the project should be discoverable");
        assert.strictEqual(project.team_size, 2, "left members must not inflate team size");
        assert.strictEqual(project.request_status, "accepted");
    });

    await test("project detail returns the roster", async () => {
        const detail = await call(joiner.session, "GET", `/api/projects/${projectId}`);
        assert.strictEqual(detail.body.success, true);
        assert.strictEqual(detail.body.team.length, 2);
        assert.strictEqual(detail.body.viewer.is_member, true);
        assert.strictEqual(detail.body.project.user_id, undefined, "internal UUID must never be sent to the browser");
    });

    // ---------- notifications ----------
    await test("notifications can be marked read", async () => {
        await call(joiner.session, "PUT", "/api/notifications/read");
        const notifications = await call(joiner.session, "GET", "/api/notifications");
        assert.strictEqual(notifications.body.unread, 0);
    });

    // ---------- authorisation ----------
    await test("signed-out requests are rejected", async () => {
        const anonymous = await call(newSession(), "GET", "/api/my-teams");
        assert.strictEqual(anonymous.status, 401);
    });

    await test("a non-owner cannot invite people to someone else's project", async () => {
        const attempt = await call(joiner.session, "POST", `/api/projects/${projectId}/invite`, { publicId: invitee.profile.public_id });
        assert.strictEqual(attempt.status, 403);
    });

    await test("a non-owner cannot accept a join request", async () => {
        const outsider = await signUp("Nina Outsider", "nina", "nina@example.com");
        const ownProject = await call(outsider.session, "POST", "/api/projects", { title: "Other", maxMembers: 4 });
        const request = await call(joiner.session, "POST", `/api/projects/${ownProject.body.project.id}/request`, {});
        assert.strictEqual(request.status, 201);
        const pending = await call(outsider.session, "GET", "/api/my-project-requests");
        const attempt = await call(owner.session, "PUT", `/api/project-requests/${pending.body.requests[0].id}`, { status: "accepted" });
        assert.strictEqual(attempt.status, 403);
    });

    await test("unknown API routes return JSON, not an HTML error page", async () => {
        const missing = await call(owner.session, "GET", "/api/does-not-exist");
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.body.success, false);
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
