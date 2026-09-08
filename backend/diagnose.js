// ============================================================
// ProjectFinder — live database diagnostic
//
//   cd backend
//   node diagnose.js
//
// Talks to YOUR Supabase using the same .env the server uses, and
// reports what is actually happening for each failing page. Read-only
// except for one INSERT into project_members that is rolled back by
// deleting the row again.
// ============================================================
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;

const ok = (m) => console.log("  OK    " + m);
const bad = (m) => console.log("  FAIL  " + m);
const info = (m) => console.log("        " + m);

function describeKey(name, key) {
    if (!key) return bad(`${name} is missing from .env`);
    if (key.startsWith("sb_publishable_")) {
        bad(`${name} is a PUBLISHABLE key (sb_publishable_...)`);
        info("This is the public key. It does NOT bypass row-level security.");
        return "publishable";
    }
    if (key.startsWith("sb_secret_")) {
        ok(`${name} is a secret key (sb_secret_...)`);
        return "secret";
    }
    if (key.startsWith("eyJ")) {
        try {
            const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
            if (payload.role === "service_role") { ok(`${name} is a service_role JWT`); return "service_role"; }
            bad(`${name} is a "${payload.role}" JWT, not service_role`);
            info("Supabase -> Settings -> API -> service_role key is the one to use.");
            return payload.role;
        } catch (_) {
            bad(`${name} is not a readable JWT`);
            return "unknown";
        }
    }
    bad(`${name} is in an unrecognised format`);
    return "unknown";
}

(async () => {
    console.log("\n=== 1. Environment ===");
    console.log("  SUPABASE_URL:", URL || "(missing)");
    const serviceKind = describeKey("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
    describeKey("SUPABASE_ANON_KEY", ANON);
    if (SERVICE && ANON && SERVICE === ANON) bad("service-role and anon keys are IDENTICAL — this is the bug");

    if (!URL || !SERVICE) { console.log("\nCannot continue without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n"); return; }
    const db = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

    console.log("\n=== 2. Can the server bypass RLS? ===");
    // profiles only allows a signed-in user to read their OWN row. A key that
    // bypasses RLS sees every row; one that does not sees zero.
    const { data: rows, error: readError, count } = await db
        .from("profiles").select("user_id", { count: "exact" }).limit(5);
    if (readError) {
        bad("Reading profiles failed: " + readError.message);
    } else if ((count || 0) === 0) {
        bad("profiles returned 0 rows.");
        info("Either the table is genuinely empty, or RLS is blocking reads.");
        info("If you have registered users, RLS is blocking = wrong key.");
    } else {
        ok(`profiles readable, ${count} row(s) visible — RLS is being bypassed correctly`);
    }

    console.log("\n=== 3. The actual My Teams failure: project_members INSERT ===");
    const { data: project } = await db.from("projects").select("id, title, user_id").limit(1).maybeSingle();
    // Must not be the project's own owner: the database correctly refuses to
    // ever give an owner a project_members row (they're implicit), and that
    // guard would otherwise look identical to an RLS/service-role failure
    // below — picking any other profile avoids a false positive here.
    const { data: outsider } = project
        ? await db.from("profiles").select("user_id, name").neq("user_id", project.user_id).limit(1).maybeSingle()
        : { data: null };
    if (!project || !outsider) {
        info("Need a project and a profile who isn't its owner to test this. Skipping.");
    } else {
        const probe = { project_id: project.id, user_id: outsider.user_id, role: "__diagnostic__" };
        const { error: insertError } = await db.from("project_members").upsert(probe, { onConflict: "project_id,user_id" });
        if (!insertError) {
            ok("INSERT into project_members succeeded — RLS is not blocking your server");
            info("So the RLS error you saw did NOT come from this server's service-role client.");
            await db.from("project_members").delete().eq("project_id", project.id).eq("user_id", outsider.user_id).eq("role", "__diagnostic__");
            info("(diagnostic row removed)");
        } else {
            bad("INSERT into project_members failed: " + insertError.message);
            info("code: " + (insertError.code || "n/a"));
            if (insertError.code === "42501") {
                info("42501 = row-level security. A service_role key would not hit this.");
                info("=> The key in SUPABASE_SERVICE_ROLE_KEY is not a service-role key.");
            }
        }
    }

    console.log("\n=== 4. The queries behind each failing page ===");
    const checks = [
        ["Projects page   ", () => db.from("projects").select("id, user_id, title, status, max_members, created_at, profiles(name, username, public_id, photo)").limit(3)],
        ["Members page    ", () => db.from("profiles").select("user_id, public_id, username, name, bio, role_title, photo, rating").limit(3)],
        ["  member skills ", () => db.from("user_skills").select("user_id, skills(name)").limit(3)],
        ["  member edu    ", () => db.from("education").select("user_id, institution").limit(3)],
        ["  settings      ", () => db.from("user_settings").select("user_id, profile_visibility, discoverability").limit(3)],
        ["  connections   ", () => db.from("connection_requests").select("id, sender_user_id, receiver_user_id, status").limit(3)],
        ["My Teams        ", () => db.from("project_members").select("project_id, user_id, role, joined_at, left_at").limit(3)],
        ["  invitations   ", () => db.from("project_invitations").select("id, project_id, inviter_user_id, invitee_user_id, status").limit(3)],
        ["  join requests ", () => db.from("project_requests").select("id, project_id, requester_user_id, message, status").limit(3)],
        ["  notifications ", () => db.from("notifications").select("id, recipient_user_id, type, message, link, read_at").limit(3)],
        ["  follows       ", () => db.from("follows").select("id, follower_user_id, following_user_id").limit(3)]
    ];
    for (const [label, run] of checks) {
        const { data, error } = await run();
        if (error) bad(`${label} ${error.message}  [${error.code || "n/a"}]`);
        else ok(`${label} ${data.length} row(s)`);
    }

    console.log("\n=== 5. Row counts ===");
    for (const table of ["profiles", "projects", "project_members", "project_requests", "project_invitations", "notifications"]) {
        const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
        console.log(`  ${table.padEnd(22)} ${error ? "error: " + error.message : count}`);
    }

    console.log("\n=== 6. Orphaned / inconsistent rows ===");
    const [{ data: members }, { data: projects }, { data: profiles }] = await Promise.all([
        db.from("project_members").select("project_id, user_id, left_at"),
        db.from("projects").select("id, user_id"),
        db.from("profiles").select("user_id")
    ]);
    if (members && projects && profiles) {
        const projectIds = new Set(projects.map(p => p.id));
        const userIds = new Set(profiles.map(p => p.user_id));
        const orphanProject = members.filter(m => !projectIds.has(m.project_id));
        const orphanUser = members.filter(m => !userIds.has(m.user_id));
        // A membership row for the owner is redundant: the code counts the
        // owner separately, so such a row inflates team size.
        const ownerRows = members.filter(m => projects.some(p => p.id === m.project_id && p.user_id === m.user_id) && !m.left_at);
        console.log("  memberships pointing at a missing project:", orphanProject.length);
        console.log("  memberships pointing at a missing profile:", orphanUser.length);
        console.log("  memberships duplicating the project OWNER:", ownerRows.length, ownerRows.length ? "<-- inflates the x/5 count" : "");
    }
    console.log("\nDone.\n");
})().catch(error => { console.error("\nDiagnostic crashed:", error.message, "\n"); });
