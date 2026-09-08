require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const requiredEnvironment = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

if (requiredEnvironment.some((name) => !process.env[name])) {
    // process.exit() would kill the whole runtime on a serverless platform
    // (Vercel etc.), not just this request, so this throws instead. Locally
    // that surfaces the same message and still stops the process before
    // app.listen() runs; on a serverless platform it surfaces as a clear
    // 500 in the function logs instead of an opaque crash.
    throw new Error("Missing Supabase settings. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (locally: copy backend/.env.example to backend/.env; on a host like Vercel: set them as project environment variables).");
}

// The browser-facing anon key is not sufficient for this server: registration
// must create a profile immediately after Supabase Auth creates the user.
// Catch the common copy/paste mistake before the app starts. New `sb_secret_`
// keys are opaque, so only validate legacy JWT-shaped keys here.
try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (key.startsWith("eyJ")) {
        const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
        if (payload.role && payload.role !== "service_role") throw new Error("not-service-role");
    }
} catch (_) {
    console.error("SUPABASE_SERVICE_ROLE_KEY must be the Service Role key from Supabase Settings → API, not the anon/public key.");
    process.exit(1);
}

// Service-role client: bypasses RLS. Used for almost everything since
// ownership/permission checks are enforced in the routes below.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// A separate client, on the public anon key, used only to verify a visitor's
// own access token (auth.getUser below). It must never share an instance
// with the service-role client above: calling .auth.getUser() repeatedly on
// a long-lived GoTrueClient was observed to eventually leave the shared
// client issuing requests as the last-verified user instead of the service
// role, so every insert/update after that point failed RLS — for everyone,
// not just that user — until the process was restarted. Keeping the two
// concerns on two instances removes the shared mutable state entirely.
const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const AVATAR_BUCKET = "avatars";

// Creates the "avatars" Storage bucket on startup if it doesn't exist yet,
// so there's no manual dashboard step required to use photo upload.
async function ensureAvatarBucket() {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) { console.error("Could not check Storage buckets:", error.message); return; }
    if (buckets.some((bucket) => bucket.name === AVATAR_BUCKET)) return;
    const { error: createError } = await supabase.storage.createBucket(AVATAR_BUCKET, {
        public: true,
        fileSizeLimit: "3MB",
        allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"]
    });
    if (createError) console.error("Could not create the avatars bucket:", createError.message);
    else console.log(`Created Storage bucket "${AVATAR_BUCKET}".`);
}

const TEAM_FILES_BUCKET = "team-files";

// Creates the private "team-files" Storage bucket on startup if it doesn't exist
// yet. Unlike avatars, this bucket is never accessed directly by the browser —
// every read/write goes through the service-role client in the file endpoints
// below, so it needs no public flag and no client-facing Storage RLS policies.
async function ensureTeamFilesBucket() {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) { console.error("Could not check Storage buckets:", error.message); return; }
    if (buckets.some((bucket) => bucket.name === TEAM_FILES_BUCKET)) return;
    const { error: createError } = await supabase.storage.createBucket(TEAM_FILES_BUCKET, {
        public: false,
        fileSizeLimit: "3MB",
        allowedMimeTypes: [
            "image/jpeg", "image/png", "image/webp", "image/gif",
            "application/pdf", "text/plain", "text/csv",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/zip", "application/json"
        ]
    });
    if (createError) console.error("Could not create the team-files bucket:", createError.message);
    else console.log(`Created Storage bucket "${TEAM_FILES_BUCKET}".`);
}

// Supabase/Postgres errors must never reach the browser verbatim: strings like
// "new row violates row-level security policy for table ..." are meaningless to
// a user and leak schema details. Full detail still goes to the server log.
// Auth errors (no Postgres code) are already user-facing, so they pass through.
const DB_MESSAGES = {
    "42501": "You do not have permission to do that.",
    "23505": "That already exists.",
    "23503": "That item no longer exists.",
    "23514": "Some of those details are not valid.",
    "42703": "The database is missing a required column. Run backend/database-setup.sql, then restart the server.",
    "42P01": "The database is missing a required table. Run backend/database-setup.sql, then restart the server.",
    "PGRST116": "That item could not be found."
};
function safeMessage(error, fallback = "Something went wrong. Please try again.") {
    if (!error) return fallback;
    const code = String(error.code || "");
    console.error("Supabase error:", code || "(no code)", error.message, error.details || "");
    if (DB_MESSAGES[code]) return DB_MESSAGES[code];
    // A Postgres SQLSTATE is 5 characters; anything else is an auth/network
    // error whose message is safe and useful to show.
    if (/^[0-9A-Z]{5}$/.test(code) || code.startsWith("PGRST")) return fallback;
    return error.message || fallback;
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Kept under Vercel's hard 4.5MB serverless request-body cap: a 3MB file
// becomes ~4MB once base64-encoded, plus a little JSON overhead. Raising
// this alone would not help on Vercel — the platform rejects an oversized
// body before Express ever sees it — so the upload limits below are capped
// to match, not just this parser.
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "../frontend")));

// ---------------------------------------------------------------
// Public ID: PTF-XXXXX using an unambiguous alphabet (no 0/O/1/I).
// This is what appears everywhere the client sees a user — the raw
// Postgres UUID primary key (user_id) is never sent to the browser.
// ---------------------------------------------------------------
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function randomPublicId() {
    let code = "";
    for (let i = 0; i < 5; i++) code += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    return `PTF-${code}`;
}
async function uniquePublicId() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = randomPublicId();
        const { data } = await supabase.from("profiles").select("user_id").eq("public_id", candidate).maybeSingle();
        if (!data) return candidate;
    }
    throw new Error("Could not generate a unique public ID. Try again.");
}

async function uniqueUsernameFromAuthUser(user) {
    const raw = String(user.user_metadata?.username || user.user_metadata?.name || user.email?.split("@")[0] || "member");
    let base = normalizeUsername(raw).replace(/[^a-z0-9_]/g, "").slice(0, 15);
    if (base.length < 3) base = "member";
    for (let attempt = 0; attempt < 20; attempt++) {
        const suffix = attempt === 0 ? "" : String(Math.floor(1000 + Math.random() * 9000));
        const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
        const { data, error } = await supabase.from("profiles").select("user_id").eq("username", candidate).maybeSingle();
        if (error) throw error;
        if (!data) return candidate;
    }
    throw new Error("Could not generate a unique username.");
}

async function ensureProfileForAuthUser(user) {
    const { data: existing, error: lookupError } = await supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return;
    const username = await uniqueUsernameFromAuthUser(user);
    const name = String(user.user_metadata?.name || user.email?.split("@")[0] || "ProjectFinder member").trim();
    const { error } = await supabase.from("profiles").insert({ user_id: user.id, public_id: await uniquePublicId(), username, name, email: String(user.email || "").toLowerCase() });
    if (error) throw error;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
function normalizeUsername(raw) { return String(raw || "").trim().toLowerCase(); }
function uniqueViolation(error) { return error && error.code === "23505"; }
function profileSetupMessage(error) {
    const text = String((error && error.message) || "").toLowerCase();
    if (uniqueViolation(error)) return "An account with this email or username already exists. Try signing in, or use a different username.";
    if (error && error.code === "42703") return "Your Supabase profiles table is missing a required column. Run the current schema/migration SQL, then try again.";
    if (text.includes("row-level security") || text.includes("permission denied")) return "Server configuration cannot create profiles. Set SUPABASE_SERVICE_ROLE_KEY to the Service Role key from Supabase Settings → API, then restart the server.";
    if (text.includes("foreign key")) return "Supabase could not link the account to its profile. Check the profiles table uses user_id uuid references auth.users(id), then try again.";
    return "Profile setup failed. Check the server terminal for the Supabase error, then run the current profile schema migration if needed.";
}
function cleanUrl(value, label) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
        const url = new URL(text);
        if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
        return url.toString();
    } catch (_) {
        const error = new Error(`${label} must be a valid http:// or https:// URL.`);
        error.statusCode = 400;
        throw error;
    }
}

// A Supabase access token only lives about an hour. Storing just that token
// logged people out mid-session. The refresh token is now stored alongside it
// and used to mint a new access token transparently when the old one expires.
function cookieOptions(rememberMe) {
    return {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
    };
}

function setSession(res, session, rememberMe) {
    const options = cookieOptions(rememberMe);
    res.cookie("session_token", session.access_token, options);
    if (session.refresh_token) res.cookie("refresh_token", session.refresh_token, options);
    res.cookie("session_remember", rememberMe ? "1" : "0", { ...options, httpOnly: false });
}

function clearSession(res) {
    const options = { path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production" };
    res.clearCookie("session_token", options);
    res.clearCookie("refresh_token", options);
    res.clearCookie("session_remember", options);
}

async function getCurrentUser(req, res) {
    const token = req.cookies.session_token;
    if (token) {
        const { data, error } = await authClient.auth.getUser(token);
        if (!error && data.user) return data.user;
    }
    // Access token missing or expired — try the refresh token before giving up.
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken || !res) return null;
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) { clearSession(res); return null; }
    setSession(res, data.session, req.cookies.session_remember === "1");
    return data.user;
}

function requireAuth(handler) {
    return asyncHandler(async (req, res) => {
        const user = await getCurrentUser(req, res);
        if (!user) return res.status(401).json({ success: false, message: "You must be logged in.", code: "auth_required" });
        return handler(req, res, user);
    });
}

// For pages that are useful signed out (project and member discovery) but show
// extra state when signed in. `user` is null for anonymous visitors instead of
// the whole request being rejected.
function optionalAuth(handler) {
    return asyncHandler(async (req, res) => {
        let user = null;
        try { user = await getCurrentUser(req, res); } catch (_) { user = null; }
        return handler(req, res, user);
    });
}

// =================================================================
// Health
// =================================================================
// Open http://localhost:3000/api/health in a browser to confirm the database
// is connected and complete. It names any table or column that is missing.
app.get("/api/health", asyncHandler(async (req, res) => {
    let problems;
    try {
        problems = await verifyDatabase();
    } catch (error) {
        return res.status(503).json({ success: false, message: `Supabase not reachable: ${error.message}` });
    }
    if (problems.length) {
        return res.status(503).json({
            success: false,
            message: "Connected to Supabase, but the schema is incomplete. Run backend/database-setup.sql in the Supabase SQL Editor.",
            problems
        });
    }
    res.json({ success: true, message: "Server and Supabase connection are healthy. All tables present." });
}));

// =================================================================
// Auth (unchanged from the existing app — reused as-is)
// =================================================================
app.post("/api/register", asyncHandler(async (req, res) => {
    const { name, email, password, username } = req.body || {};
    if (!name || !email || !password || !username) return res.status(400).json({ success: false, message: "Name, username, email and password are required." });
    const cleanUsername = normalizeUsername(username);
    if (!USERNAME_PATTERN.test(cleanUsername)) return res.status(400).json({ success: false, message: "Username must be 3-20 characters: lowercase letters, numbers, and underscores only." });
    const cleanEmail = String(email).toLowerCase().trim();

    const { data: usernameTaken } = await supabase.from("profiles").select("user_id").eq("username", cleanUsername).maybeSingle();
    if (usernameTaken) return res.status(400).json({ success: false, message: "That username is already taken." });

    const { data, error } = await authClient.auth.signUp({
        email: cleanEmail,
        password,
        options: { data: { name: String(name).trim(), username: cleanUsername }, emailRedirectTo: `${APP_URL}/verify-email.html?status=verified` }
    });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (!data.user) return res.status(400).json({ success: false, message: "That email is already registered. Try logging in instead." });

    // Supabase intentionally obscures duplicate-email signups in some
    // configurations. A retry can therefore return an existing auth user.
    // Never try to insert a second profile for that identity.
    const { data: existingProfile, error: existingProfileError } = await supabase.from("profiles").select("user_id").eq("user_id", data.user.id).maybeSingle();
    if (existingProfileError) {
        console.error("Profile preflight failed:", existingProfileError.code, existingProfileError.message);
        return res.status(500).json({ success: false, message: profileSetupMessage(existingProfileError) });
    }
    if (existingProfile) return res.status(400).json({ success: false, message: "An account with this email already exists. Please sign in instead." });

    const publicId = await uniquePublicId();
    const { error: profileError } = await supabase.from("profiles").insert({ user_id: data.user.id, public_id: publicId, username: cleanUsername, name: String(name).trim(), email: cleanEmail });
    if (profileError) {
        console.error("Profile creation failed:", profileError.code, profileError.message);
        // Clean up only this exact newly-created Auth user. This avoids a
        // broken account that can never finish signup, without touching other
        // users if the service role was not configured correctly.
        const { error: deleteError } = await supabase.auth.admin.deleteUser(data.user.id);
        if (deleteError) console.error("Registration rollback failed:", deleteError.message);
        return res.status(500).json({ success: false, message: profileSetupMessage(profileError) });
    }
    return res.json({ success: true, message: "Account created. Check your email to verify it before logging in.", userId: data.user.id });
}));

app.post("/api/login", asyncHandler(async (req, res) => {
    const { email, password, rememberMe } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password are required." });
    const { data, error } = await authClient.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password });
    if (error) {
        console.error("Login failed:", error.status, error.message);
        const message = error.message.toLowerCase().includes("confirm") ? "Please verify your email before logging in." : "Invalid email or password.";
        return res.status(401).json({ success: false, message });
    }
    // Repairs Auth users created by an earlier interrupted signup. It uses
    // stored signup metadata where available and never exposes the UUID.
    try {
        await ensureProfileForAuthUser(data.user);
    } catch (profileError) {
        console.error("Login profile recovery failed:", profileError.code, profileError.message);
        return res.status(500).json({ success: false, message: profileSetupMessage(profileError) });
    }
    setSession(res, data.session, rememberMe === true);
    return res.json({ success: true, message: "Login successful." });
}));

app.post("/api/resend-verification", asyncHandler(async (req, res) => {
    const email = String((req.body || {}).email || "").trim();
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });
    const { error } = await authClient.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${APP_URL}/verify-email.html?status=verified` } });
    return error ? res.status(400).json({ success: false, message: safeMessage(error) }) : res.json({ success: true, message: "A new verification email has been sent." });
}));

app.post("/api/forgot-password", asyncHandler(async (req, res) => {
    const email = String((req.body || {}).email || "").trim();
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });
    const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/reset-password.html` });
    return error ? res.status(400).json({ success: false, message: safeMessage(error) }) : res.json({ success: true, message: "If that account exists, a password-reset email has been sent." });
}));

app.post("/api/set-password", asyncHandler(async (req, res) => {
    const { accessToken, refreshToken, password } = req.body || {};
    if (!accessToken || !refreshToken || !password) return res.status(400).json({ success: false, message: "Your reset link is incomplete or expired." });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: sessionError } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (sessionError) return res.status(400).json({ success: false, message: "This reset link is invalid or expired." });
    const { error } = await client.auth.updateUser({ password });
    return error ? res.status(400).json({ success: false, message: safeMessage(error) }) : res.json({ success: true, message: "Password updated successfully." });
}));

app.post("/api/logout", (req, res) => { clearSession(res); res.json({ success: true }); });

// =================================================================
// Profile (identity foundation)
// =================================================================
app.get("/api/me", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("profiles").select("*").eq("user_id", user.id).single();
    if (error) return res.status(404).json({ success: false, message: "Profile not found." });
    const [{ count: followers }, { count: following }] = await Promise.all([
        supabase.from("follows").select("id", { count: "exact", head: true }).eq("following_user_id", user.id),
        supabase.from("follows").select("id", { count: "exact", head: true }).eq("follower_user_id", user.id)
    ]);

    return res.json({
        success: true,
        // This is an authenticated owner's private profile response. Public
        // project endpoints select only display-safe profile columns.
        user: data,
        stats: { followers: followers || 0, following: following || 0 }
    });
}));

app.put("/api/profile", requireAuth(async (req, res, user) => {
    const body = req.body || {};
    const update = {};

    if ("username" in body) {
        const cleanUsername = normalizeUsername(body.username);
        if (!USERNAME_PATTERN.test(cleanUsername)) return res.status(400).json({ success: false, message: "Username must be 3-20 characters: lowercase letters, numbers, and underscores only." });
        update.username = cleanUsername;
    }
    if ("name" in body) {
        if (!String(body.name).trim()) return res.status(400).json({ success: false, message: "Name cannot be empty." });
        update.name = String(body.name).trim();
    }
    const textFields = { bio: "bio", roleTitle: "role_title" };
    for (const [bodyKey, column] of Object.entries(textFields)) if (bodyKey in body) update[column] = String(body[bodyKey] || "").trim();
    const links = { linkedin: "LinkedIn", github: "GitHub", portfolio: "Portfolio", otherWebsite: "Other website" };
    for (const [bodyKey, label] of Object.entries(links)) {
        if (bodyKey in body) update[bodyKey === "otherWebsite" ? "other_website" : bodyKey] = cleanUrl(body[bodyKey], label);
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ success: false, message: "Nothing to update." });

    const { error } = await supabase.from("profiles").update(update).eq("user_id", user.id);
    if (uniqueViolation(error)) return res.status(400).json({ success: false, message: "That username is already taken." });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    return res.json({ success: true, message: "Profile updated successfully." });
}));

// =================================================================
// Settings — one private row per user; no auth UUIDs are returned.
// =================================================================
const SETTINGS_DEFAULTS = {
    profile_visibility: "public", discoverability: "everyone", connection_requests: "everyone",
    show_email: false, show_profile_details: true, notify_new_followers: true,
    notify_follow_activity: true, notify_connection_requests: true, notify_connection_accepted: true,
    notify_team_invitations: true, notify_project_requests: true, notify_messages: true,
    notify_system: true, appearance: "system"
};
async function getSettings(userId) {
    const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;
    const { data: created, error: createError } = await supabase.from("user_settings").insert({ user_id: userId, ...SETTINGS_DEFAULTS }).select().single();
    if (uniqueViolation(createError)) {
        const { data: concurrent, error: retryError } = await supabase.from("user_settings").select("*").eq("user_id", userId).single();
        if (retryError) throw retryError;
        return concurrent;
    }
    if (createError) throw createError;
    return created;
}
app.get("/api/settings", requireAuth(async (req, res, user) => {
    const settings = await getSettings(user.id);
    res.json({ success: true, settings });
}));
app.put("/api/settings", requireAuth(async (req, res, user) => {
    const body = req.body || {}, update = {};
    const enums = {
        profile_visibility: ["public", "connections", "private"],
        discoverability: ["everyone", "connections", "nobody"],
        connection_requests: ["everyone", "connections", "nobody"],
        appearance: ["light", "dark", "system"]
    };
    for (const [key, values] of Object.entries(enums)) {
        if (key in body) {
            if (!values.includes(body[key])) return res.status(400).json({ success: false, message: `Invalid ${key.replaceAll("_", " ")} setting.` });
            update[key] = body[key];
        }
    }
    const booleans = ["show_email", "show_profile_details", "notify_new_followers", "notify_follow_activity", "notify_connection_requests", "notify_connection_accepted", "notify_team_invitations", "notify_project_requests", "notify_messages", "notify_system"];
    for (const key of booleans) if (key in body) {
        if (typeof body[key] !== "boolean") return res.status(400).json({ success: false, message: `Invalid ${key.replaceAll("_", " ")} setting.` });
        update[key] = body[key];
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "Nothing to update." });
    update.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("user_settings").upsert({ user_id: user.id, ...SETTINGS_DEFAULTS, ...update }, { onConflict: "user_id" }).select().single();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "Settings saved.", settings: data });
}));

app.post("/api/settings/change-password", requireAuth(async (req, res, user) => {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ success: false, message: "Complete all password fields." });
    if (String(newPassword).length < 8) return res.status(400).json({ success: false, message: "Your new password must be at least 8 characters." });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: "New passwords do not match." });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: signedIn, error: verifyError } = await client.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (verifyError || !signedIn.session) return res.status(400).json({ success: false, message: "Your current password is incorrect." });
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "Password changed successfully." });
}));

app.delete("/api/account", requireAuth(async (req, res, user) => {
    const { confirmation, currentPassword } = req.body || {};
    if (confirmation !== "DELETE") return res.status(400).json({ success: false, message: 'Type DELETE to confirm account deletion.' });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: verifyError } = await client.auth.signInWithPassword({ email: user.email, password: currentPassword || "" });
    if (verifyError) return res.status(400).json({ success: false, message: "Your current password is incorrect." });
    await supabase.storage.from(AVATAR_BUCKET).remove([`${user.id}.jpg`]);
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    clearSession(res);
    res.json({ success: true, message: "Your account and associated ProjectFinder data were deleted." });
}));

// =================================================================
// Follows — public IDs are the only profile identifiers sent to browsers.
// =================================================================
const PUBLIC_PROFILE_COLUMNS = "user_id, public_id, username, name, bio, role_title, photo, linkedin, github, portfolio, other_website, last_seen_at";

// "Online" / "Away" / "Offline" from a real last_seen_at timestamp (updated
// by POST /api/presence/ping while the app is open) — never a fake status.
function presenceStatus(lastSeenAt) {
    if (!lastSeenAt) return "offline";
    const minutesAgo = (Date.now() - new Date(lastSeenAt).getTime()) / 60000;
    if (minutesAgo <= 2) return "online";
    if (minutesAgo <= 15) return "away";
    return "offline";
}
async function profileByPublicId(publicId) {
    const { data, error } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).eq("public_id", publicId).maybeSingle();
    if (error) throw error;
    return data;
}
async function followCounts(userId) {
    const [{ count: followers }, { count: following }] = await Promise.all([
        supabase.from("follows").select("id", { count: "exact", head: true }).eq("following_user_id", userId),
        supabase.from("follows").select("id", { count: "exact", head: true }).eq("follower_user_id", userId)
    ]);
    return { followers: followers || 0, following: following || 0 };
}
function safeProfile(profile) {
    // last_seen_at is dropped here too: it's raw enough to be a minor privacy
    // leak if it rode along on every profile payload (project owners, team
    // rosters, search results...). Only the Members list computes and
    // attaches a derived online/away/offline `status` from it, where it's
    // actually shown.
    const { user_id, last_seen_at, ...safe } = profile;
    return safe;
}

// The single row that describes the relationship between two users, whatever
// its state. Returns null when they have never interacted.
async function connectionBetween(a, b) {
    const { data, error } = await supabase.from("connection_requests")
        .select("id, sender_user_id, receiver_user_id, status")
        .or(`and(sender_user_id.eq.${a},receiver_user_id.eq.${b}),and(sender_user_id.eq.${b},receiver_user_id.eq.${a})`)
        .in("status", ["pending", "accepted"])
        .order("updated_at", { ascending: false })
        .limit(1);
    if (error) throw error;
    return data && data.length ? data[0] : null;
}
async function areConnected(a, b) {
    if (a === b) return true;
    const relation = await connectionBetween(a, b);
    return Boolean(relation && relation.status === "accepted");
}
// Everyone user `id` is connected to.
async function connectionIds(id) {
    const { data, error } = await supabase.from("connection_requests")
        .select("sender_user_id, receiver_user_id").eq("status", "accepted")
        .or(`sender_user_id.eq.${id},receiver_user_id.eq.${id}`);
    if (error) throw error;
    return new Set(data.map(row => row.sender_user_id === id ? row.receiver_user_id : row.sender_user_id));
}
// True when the two users have at least one connection in common — what the
// "connections" option on the connection_requests setting actually means.
async function sharesAConnection(a, b) {
    const [mine, theirs] = await Promise.all([connectionIds(a), connectionIds(b)]);
    if (mine.has(b)) return true;
    for (const id of mine) if (theirs.has(id)) return true;
    return false;
}
// "connections" visibility now means what it says: connected members can see
// the profile, everyone else cannot. Previously it was treated as private.
async function canViewProfile(viewerId, ownerId, settings) {
    if (viewerId === ownerId) return true;
    if (settings.profile_visibility === "public") return true;
    if (settings.profile_visibility === "private") return false;
    return areConnected(viewerId, ownerId);
}

app.get("/api/profiles/:publicId", requireAuth(async (req, res, user) => {
    const profile = await profileByPublicId(req.params.publicId);
    if (!profile) return res.status(404).json({ success: false, message: "Profile not found." });
    const isOwner = profile.user_id === user.id;
    const preferences = isOwner ? null : await getSettings(profile.user_id);
    if (!isOwner && !(await canViewProfile(user.id, profile.user_id, preferences))) {
        return res.status(403).json({ success: false, message: "This profile is private." });
    }
    const [stats, relation, connection] = await Promise.all([
        followCounts(profile.user_id),
        isOwner ? Promise.resolve({ data: null }) : supabase.from("follows").select("id").eq("follower_user_id", user.id).eq("following_user_id", profile.user_id).maybeSingle(),
        isOwner ? Promise.resolve(null) : connectionBetween(user.id, profile.user_id)
    ]);
    if (relation.error) return res.status(500).json({ success: false, message: relation.error.message });
    const publicProfile = safeProfile(profile);
    if (!preferences || preferences.show_profile_details) {
        const { data: skillRows } = await supabase.from("user_skills").select("skills(name)").eq("user_id", profile.user_id);
        publicProfile.skills = (skillRows || []).map(row => row.skills && row.skills.name).filter(Boolean);
    }
    if (preferences && !preferences.show_profile_details) publicProfile.bio = "";
    if (preferences && preferences.show_email) {
        // PUBLIC_PROFILE_COLUMNS deliberately excludes email, so read it only
        // for the one case where the owner asked for it to be shown.
        const { data: contact } = await supabase.from("profiles").select("email").eq("user_id", profile.user_id).maybeSingle();
        publicProfile.email = contact ? contact.email : "";
    }
    res.json({
        success: true, profile: publicProfile, stats, is_owner: isOwner, is_following: Boolean(relation.data),
        // Lets the member profile page render the right Connect / Pending / Connected state.
        connection: connection ? { id: connection.id, status: connection.status, direction: connection.sender_user_id === user.id ? "sent" : "received" } : null,
        can_receive_connection: !isOwner && preferences.connection_requests !== "nobody"
    });
}));
app.post("/api/profiles/:publicId/follow", requireAuth(async (req, res, user) => {
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Profile not found." });
    if (target.user_id === user.id) return res.status(400).json({ success: false, message: "You cannot follow yourself." });
    const settings = await getSettings(target.user_id);
    if (!(await canViewProfile(user.id, target.user_id, settings))) return res.status(403).json({ success: false, message: "This profile is private." });
    const { data: follow, error } = await supabase.from("follows").insert({ follower_user_id: user.id, following_user_id: target.user_id }).select("id").single();
    if (uniqueViolation(error)) return res.status(409).json({ success: false, message: "You already follow this profile." });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (settings.notify_new_followers) {
        const { data: actor } = await supabase.from("profiles").select("name").eq("user_id", user.id).single();
        await supabase.from("notifications").insert({ recipient_user_id: target.user_id, actor_user_id: user.id, follow_id: follow.id, type: "follow", message: `${actor ? actor.name : "A ProjectFinder member"} started following you.` });
    }
    res.status(201).json({ success: true, message: "Following.", stats: await followCounts(target.user_id) });
}));
app.delete("/api/profiles/:publicId/follow", requireAuth(async (req, res, user) => {
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Profile not found." });
    const { data, error } = await supabase.from("follows").delete().eq("follower_user_id", user.id).eq("following_user_id", target.user_id).select("id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "You do not follow this profile." });
    res.json({ success: true, message: "Unfollowed.", stats: await followCounts(target.user_id) });
}));
async function listFollowProfiles(user, direction) {
    const column = direction === "followers" ? "following_user_id" : "follower_user_id";
    const other = direction === "followers" ? "follower_user_id" : "following_user_id";
    const { data: rows, error } = await supabase.from("follows").select(`${other}, created_at`).eq(column, user.id).order("created_at", { ascending: false });
    if (error) throw error;
    const ids = rows.map(row => row[other]);
    if (!ids.length) return [];
    const [{ data: profiles, error: profileError }, { data: myFollows, error: relationError }] = await Promise.all([
        supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids),
        supabase.from("follows").select("following_user_id").eq("follower_user_id", user.id).in("following_user_id", ids)
    ]);
    if (profileError || relationError) throw profileError || relationError;
    const followingSet = new Set(myFollows.map(row => row.following_user_id));
    const byId = new Map(profiles.map(profile => [profile.user_id, profile]));
    return rows.map(row => byId.get(row[other])).filter(Boolean).map(profile => ({ ...safeProfile(profile), is_following: followingSet.has(profile.user_id) }));
}
app.get("/api/followers", requireAuth(async (req, res, user) => res.json({ success: true, people: await listFollowProfiles(user, "followers") })));
app.get("/api/following", requireAuth(async (req, res, user) => res.json({ success: true, people: await listFollowProfiles(user, "following") })));
app.get("/api/notifications", requireAuth(async (req, res, user) => {
    const [{ data, error }, { count, error: countError }] = await Promise.all([
        supabase.from("notifications").select("id, type, message, link, read_at, created_at, actor_user_id, connection_request_id").eq("recipient_user_id", user.id).order("created_at", { ascending: false }).limit(50),
        supabase.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_user_id", user.id).is("read_at", null)
    ]);
    if (error || countError) return res.status(500).json({ success: false, message: safeMessage(error || countError) });

    const actorIds = [...new Set(data.map(n => n.actor_user_id).filter(Boolean))];
    const { data: actors, error: actorsError } = actorIds.length
        ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", actorIds)
        : { data: [], error: null };
    if (actorsError) return res.status(500).json({ success: false, message: safeMessage(actorsError) });
    const actorMap = new Map(actors.map(profile => [profile.user_id, safeProfile(profile)]));

    // A connection-request notification carries a live Accept/Reject action,
    // but only while the underlying request is still pending — a notification
    // for a request that was already handled elsewhere must not show dead
    // buttons that would 409 if pressed.
    const requestIds = [...new Set(data.filter(n => n.type === "connection_request" && n.connection_request_id).map(n => n.connection_request_id))];
    const { data: liveRequests, error: liveRequestsError } = requestIds.length
        ? await supabase.from("connection_requests").select("id, status").in("id", requestIds)
        : { data: [], error: null };
    if (liveRequestsError) return res.status(500).json({ success: false, message: safeMessage(liveRequestsError) });
    const requestStatusById = new Map(liveRequests.map(r => [r.id, r.status]));

    // Real mutual-connection counts for the (usually 0-2) people behind a
    // still-pending request — cheap at this scale, and an honest number
    // rather than a guess.
    const pendingActorIds = [...new Set(data
        .filter(n => n.type === "connection_request" && n.connection_request_id && requestStatusById.get(n.connection_request_id) === "pending")
        .map(n => n.actor_user_id))];
    const mutualByActor = new Map();
    if (pendingActorIds.length) {
        const myMap = await relationshipMap(user.id);
        const myAccepted = new Set([...myMap.entries()].filter(([, r]) => r.status === "accepted").map(([id]) => id));
        for (const actorId of pendingActorIds) {
            const theirMap = await relationshipMap(actorId);
            let count = 0;
            for (const [id, r] of theirMap.entries()) if (r.status === "accepted" && myAccepted.has(id)) count++;
            mutualByActor.set(actorId, count);
        }
    }

    const notifications = data.map(n => {
        const isPendingConnectionRequest = n.type === "connection_request" && n.connection_request_id && requestStatusById.get(n.connection_request_id) === "pending";
        return {
            id: n.id, type: n.type, message: n.message, link: n.link, read_at: n.read_at, created_at: n.created_at,
            actor: n.actor_user_id ? actorMap.get(n.actor_user_id) || null : null,
            connection_request: isPendingConnectionRequest
                ? { id: n.connection_request_id, mutual_connections: mutualByActor.get(n.actor_user_id) || 0 }
                : null
        };
    });
    res.json({ success: true, notifications, unread: count || 0 });
}));
// read_at existed in the schema but nothing ever wrote to it, so every
// notification stayed unread forever. These two endpoints close that gap.
app.put("/api/notifications/read", requireAuth(async (req, res, user) => {
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("recipient_user_id", user.id).is("read_at", null);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "All notifications marked as read." });
}));
app.put("/api/notifications/:id/read", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", req.params.id).eq("recipient_user_id", user.id).select("id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Notification not found." });
    res.json({ success: true });
}));

// =================================================================
// Member discovery and professional connections
// =================================================================
const PAGE_SIZE = 24;
async function relationshipMap(userId) {
    const { data, error } = await supabase.from("connection_requests").select("id, sender_user_id, receiver_user_id, status").or(`sender_user_id.eq.${userId},receiver_user_id.eq.${userId}`).order("updated_at", { ascending: false });
    if (error) throw error;
    const map = new Map();
    data.forEach(row => { const other = row.sender_user_id === userId ? row.receiver_user_id : row.sender_user_id; if (!map.has(other)) map.set(other, row); });
    return map;
}
// `hideRestricted` controls whether privacy settings can remove someone from
// the result. That is right for public discovery (/api/members), but wrong for
// a list the viewer is already entitled to see — your own team roster or your
// own connections — where it used to make people silently vanish.
async function enrichMembers(profiles, viewerId, { hideRestricted = true } = {}) {
    const ids = profiles.map(profile => profile.user_id);
    if (!ids.length) return [];
    const [skillsResult, educationResult, followersResult, projectsResult, teamsResult, followsResult, connectionsResult, preferencesResult, savedResult] = await Promise.all([
        supabase.from("user_skills").select("user_id, skills(name)").in("user_id", ids),
        supabase.from("education").select("user_id, institution, degree_course, field_of_study").in("user_id", ids),
        supabase.from("follows").select("following_user_id").in("following_user_id", ids),
        supabase.from("projects").select("user_id").in("user_id", ids),
        supabase.from("project_members").select("user_id").in("user_id", ids).is("left_at", null),
        viewerId ? supabase.from("follows").select("following_user_id").eq("follower_user_id", viewerId).in("following_user_id", ids) : Promise.resolve({ data: [], error: null }),
        viewerId ? relationshipMap(viewerId) : Promise.resolve(new Map()),
        supabase.from("user_settings").select("user_id, profile_visibility, show_profile_details").in("user_id", ids),
        viewerId ? supabase.from("saved_members").select("saved_user_id").eq("user_id", viewerId).in("saved_user_id", ids) : Promise.resolve({ data: [], error: null })
    ]);
    const failed = [skillsResult, educationResult, followersResult, projectsResult, teamsResult, followsResult, preferencesResult, savedResult].find(result => result.error);
    if (failed) throw failed.error;
    const skillMap = new Map(), educationMap = new Map(), followerCount = new Map(), projectCount = new Map(), teamCount = new Map();
    skillsResult.data.forEach(row => { if (!skillMap.has(row.user_id)) skillMap.set(row.user_id, []); if (row.skills) skillMap.get(row.user_id).push(row.skills.name); });
    educationResult.data.forEach(row => { if (!educationMap.has(row.user_id)) educationMap.set(row.user_id, []); educationMap.get(row.user_id).push([row.institution, row.degree_course, row.field_of_study].filter(Boolean).join(" · ")); });
    followersResult.data.forEach(row => followerCount.set(row.following_user_id, (followerCount.get(row.following_user_id) || 0) + 1));
    projectsResult.data.forEach(row => projectCount.set(row.user_id, (projectCount.get(row.user_id) || 0) + 1));
    teamsResult.data.forEach(row => teamCount.set(row.user_id, (teamCount.get(row.user_id) || 0) + 1));
    const following = new Set(followsResult.data.map(row => row.following_user_id));
    const saved = new Set(savedResult.data.map(row => row.saved_user_id));
    const preferences = new Map(preferencesResult.data.map(row => [row.user_id, row]));
    const connectedIds = new Set([...connectionsResult.entries()].filter(([, row]) => row.status === "accepted").map(([otherId]) => otherId));
    return profiles.filter(profile => {
        if (!hideRestricted || profile.user_id === viewerId) return true;
        const pref = preferences.get(profile.user_id);
        if (!pref) return true;
        if (pref.discoverability === "nobody") return false;
        if (pref.discoverability === "connections" && !connectedIds.has(profile.user_id)) return false;
        if (pref.profile_visibility === "private") return false;
        if (pref.profile_visibility === "connections" && !connectedIds.has(profile.user_id)) return false;
        return true;
    }).map(profile => {
        const pref = preferences.get(profile.user_id), detailsVisible = !pref || pref.show_profile_details;
        const relationship = connectionsResult.get(profile.user_id);
        return {
            ...safeProfile(profile), bio: detailsVisible ? profile.bio : "", skills: detailsVisible ? (skillMap.get(profile.user_id) || []) : [],
            education: detailsVisible ? (educationMap.get(profile.user_id) || []) : [], followers: followerCount.get(profile.user_id) || 0,
            projects: projectCount.get(profile.user_id) || 0, teams: teamCount.get(profile.user_id) || 0,
            status: presenceStatus(profile.last_seen_at), is_following: following.has(profile.user_id), is_saved: saved.has(profile.user_id),
            connection: relationship ? { id: relationship.id, status: relationship.status, direction: relationship.sender_user_id === viewerId ? "sent" : "received" } : null
        };
    });
}
// Category pills on Members: a real keyword match against role_title, since
// there is no separate "category" field on a profile — the same honest
// pattern as the category pills on Find Teams.
const MEMBER_ROLE_CATEGORIES = {
    developers: ["develop", "engineer", "program", "backend", "frontend", "full stack", "software", "web dev"],
    designers: ["design", "ui/ux", "ui", "ux", "figma", "graphic"],
    marketers: ["market", "seo", "growth", "ads", "brand"],
    data: ["data", "analy", "sql", "machine learning", " ai", "ml "],
    content: ["content", "writer", "copywrit", "video edit", "creator"]
};
const MEMBER_SORTS = { relevant: null, newest: { column: "created_at", ascending: false }, name: { column: "name", ascending: true } };

app.get("/api/members", optionalAuth(async (req, res, user) => {
    const query = String(req.query.q || "").trim().slice(0, 80), skill = String(req.query.skill || "").trim().slice(0, 60), education = String(req.query.education || "").trim().slice(0, 80), role = String(req.query.role || "").trim().slice(0, 80), availability = String(req.query.availability || "").trim().slice(0, 80);
    const roleCategory = String(req.query.roleCategory || "").trim().toLowerCase();
    const sort = MEMBER_SORTS[String(req.query.sort || "relevant").trim().toLowerCase()];
    if (sort === undefined) return res.status(400).json({ success: false, message: "Invalid sort option." });
    if (roleCategory && roleCategory !== "other" && !MEMBER_ROLE_CATEGORIES[roleCategory]) return res.status(400).json({ success: false, message: "Invalid category." });
    const minRating = req.query.min_rating === "" || req.query.min_rating === undefined ? null : Number(req.query.min_rating);
    const page = Math.max(0, Number.parseInt(req.query.page, 10) || 0);
    if (minRating !== null && (!Number.isFinite(minRating) || minRating < 0 || minRating > 5)) return res.status(400).json({ success: false, message: "Rating must be between 0 and 5." });
    const clean = value => value.replace(/[%_,]/g, "");
    const empty = () => res.json({ success: true, members: [], page, has_more: false, total: 0 });

    // Explicit filters (skill / education / availability) NARROW the result:
    // each one must match, so they are intersected. A free-text query is a
    // separate, wider search handled below.
    //
    // The old version mixed the two: a free-text query pushed an (often empty)
    // skill/education id set into the same list and then returned early when
    // that set was empty. Searching a member by name found nothing unless the
    // name also happened to match a skill or a school.
    let filterIds = null;
    const intersect = ids => { const next = new Set(ids); filterIds = filterIds === null ? next : new Set([...filterIds].filter(id => next.has(id))); };

    if (skill) {
        const { data, error } = await supabase.from("skills").select("id").ilike("name", `%${clean(skill)}%`).limit(100);
        if (error) throw error;
        if (!data.length) return empty();
        const { data: rows, error: rowError } = await supabase.from("user_skills").select("user_id").in("skill_id", data.map(row => row.id));
        if (rowError) throw rowError;
        intersect(rows.map(row => row.user_id));
    }
    if (education) {
        const term = clean(education);
        const { data, error } = await supabase.from("education").select("user_id").or(`institution.ilike.%${term}%,degree_course.ilike.%${term}%,field_of_study.ilike.%${term}%`).limit(500);
        if (error) throw error;
        intersect(data.map(row => row.user_id));
    }
    if (availability) {
        const { data, error } = await supabase.from("projects").select("user_id").ilike("availability", `%${clean(availability)}%`).limit(500);
        if (error) throw error;
        intersect(data.map(row => row.user_id));
    }
    if (filterIds !== null && filterIds.size === 0) return empty();

    // Free text matches a profile field OR a skill OR a school — a union.
    let searchIds = null;
    if (query) {
        const term = clean(query);
        const [direct, skillRows, educationRows] = await Promise.all([
            supabase.from("profiles").select("user_id").or(`name.ilike.%${term}%,username.ilike.%${term}%,public_id.ilike.%${term}%,role_title.ilike.%${term}%,bio.ilike.%${term}%`).limit(500),
            supabase.from("skills").select("id").ilike("name", `%${term}%`).limit(100),
            supabase.from("education").select("user_id").or(`institution.ilike.%${term}%,degree_course.ilike.%${term}%,field_of_study.ilike.%${term}%`).limit(500)
        ]);
        if (direct.error) throw direct.error;
        if (skillRows.error) throw skillRows.error;
        if (educationRows.error) throw educationRows.error;
        const union = new Set([...direct.data.map(row => row.user_id), ...educationRows.data.map(row => row.user_id)]);
        if (skillRows.data.length) {
            const { data: rows, error: rowError } = await supabase.from("user_skills").select("user_id").in("skill_id", skillRows.data.map(row => row.id));
            if (rowError) throw rowError;
            rows.forEach(row => union.add(row.user_id));
        }
        if (!union.size) return empty();
        searchIds = union;
    }

    let candidates = null;
    if (filterIds !== null && searchIds !== null) candidates = [...filterIds].filter(id => searchIds.has(id));
    else if (filterIds !== null) candidates = [...filterIds];
    else if (searchIds !== null) candidates = [...searchIds];
    if (candidates !== null && !candidates.length) return empty();
    let request = supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS, { count: "exact" });
    request = sort ? request.order(sort.column, { ascending: sort.ascending }) : request.order("created_at", { ascending: false });
    if (user) request = request.neq("user_id", user.id);
    if (candidates) request = request.in("user_id", candidates);
    if (role) request = request.ilike("role_title", `%${role.replace(/[%_,]/g, "")}%`);
    if (minRating !== null) request = request.gte("rating", minRating);
    if (roleCategory === "other") {
        for (const keywords of Object.values(MEMBER_ROLE_CATEGORIES)) for (const kw of keywords) request = request.not("role_title", "ilike", `%${kw}%`);
    } else if (roleCategory) {
        request = request.or(MEMBER_ROLE_CATEGORIES[roleCategory].map(kw => `role_title.ilike.%${kw}%`).join(","));
    }
    const { data, error, count } = await request.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const members = await enrichMembers(data.slice(0, PAGE_SIZE), user ? user.id : null);
    res.json({ success: true, members, page, has_more: data.length > PAGE_SIZE, total: count || 0, signed_in: Boolean(user) });
}));
// Called periodically by the client while the app is open (see app.js) so
// presenceStatus() above has a real timestamp to work from.
app.post("/api/presence/ping", requireAuth(async (req, res, user) => {
    const { error } = await supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("user_id", user.id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true });
}));

// Real counts for the Members sidebar — nothing hardcoded.
app.get("/api/members/stats", asyncHandler(async (req, res) => {
    const onlineSince = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const [totalMembers, onlineNow, totalProjects, teamMemberships] = await Promise.all([
        supabase.from("profiles").select("user_id", { count: "exact", head: true }),
        supabase.from("profiles").select("user_id", { count: "exact", head: true }).gte("last_seen_at", onlineSince),
        supabase.from("projects").select("id", { count: "exact", head: true }),
        supabase.from("project_members").select("project_id").is("left_at", null)
    ]);
    const failed = [totalMembers, onlineNow, totalProjects, teamMemberships].find(r => r.error);
    if (failed) return res.status(500).json({ success: false, message: safeMessage(failed.error) });
    // "Teams" = projects that actually have more than one person on them
    // (the owner plus at least one active member) — a solo project isn't
    // really a team yet.
    const teamsWithMembers = new Set((teamMemberships.data || []).map(r => r.project_id)).size;
    res.json({
        success: true,
        stats: { total_members: totalMembers.count || 0, online_now: onlineNow.count || 0, projects: totalProjects.count || 0, teams: teamsWithMembers }
    });
}));

// "Similar interests & skills": real members who share at least one skill
// with the viewer, ranked by how many they share, excluding people already
// connected or followed. Signed out gets no personalized copy so this isn't
// called.
app.get("/api/members/suggested", requireAuth(async (req, res, user) => {
    // Capped well below the total member count so this always stays a
    // "picked for you" shortlist, never a full member-directory dump.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 4, 1), 24);
    const { data: mySkillRows, error: mySkillError } = await supabase.from("user_skills").select("skill_id").eq("user_id", user.id);
    if (mySkillError) return res.status(500).json({ success: false, message: safeMessage(mySkillError) });
    const mySkillIds = mySkillRows.map(r => r.skill_id);
    if (!mySkillIds.length) return res.json({ success: true, members: [], reason: "no_skills" });

    const [{ data: matches, error: matchError }, { data: myFollows, error: followError }, connectionsResult] = await Promise.all([
        supabase.from("user_skills").select("user_id, skill_id").in("skill_id", mySkillIds).neq("user_id", user.id),
        supabase.from("follows").select("following_user_id").eq("follower_user_id", user.id),
        relationshipMap(user.id)
    ]);
    if (matchError || followError) return res.status(500).json({ success: false, message: safeMessage(matchError || followError) });
    const followingIds = new Set(myFollows.map(r => r.following_user_id));
    const connectedIds = new Set([...connectionsResult.entries()].filter(([, row]) => row.status === "accepted" || row.status === "pending").map(([id]) => id));
    const sharedCount = new Map();
    matches.forEach(row => { if (!followingIds.has(row.user_id) && !connectedIds.has(row.user_id)) sharedCount.set(row.user_id, (sharedCount.get(row.user_id) || 0) + 1); });
    const topIds = [...sharedCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
    if (!topIds.length) return res.json({ success: true, members: [], reason: "no_matches" });
    const { data: profiles, error: profileError } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", topIds);
    if (profileError) return res.status(500).json({ success: false, message: safeMessage(profileError) });
    // .in() doesn't preserve list order, so re-sort by shared-skill rank
    // (already computed above) before enriching.
    const rank = new Map(topIds.map((id, i) => [id, i]));
    profiles.sort((a, b) => rank.get(a.user_id) - rank.get(b.user_id));
    res.json({ success: true, members: await enrichMembers(profiles, user.id) });
}));

// Members page "My Connections" / "Following" tabs — the same rich card
// data as the main list, sourced from the existing connections/follows
// tables rather than duplicating them.
app.get("/api/members/connections", requireAuth(async (req, res, user) => {
    const { data: rows, error } = await supabase.from("connection_requests").select("sender_user_id, receiver_user_id").eq("status", "accepted").or(`sender_user_id.eq.${user.id},receiver_user_id.eq.${user.id}`);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = rows.map(row => row.sender_user_id === user.id ? row.receiver_user_id : row.sender_user_id);
    if (!ids.length) return res.json({ success: true, members: [] });
    const { data: profiles, error: profileError } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids);
    if (profileError) return res.status(500).json({ success: false, message: safeMessage(profileError) });
    res.json({ success: true, members: await enrichMembers(profiles, user.id, { hideRestricted: false }) });
}));

app.get("/api/members/following", requireAuth(async (req, res, user) => {
    const { data: rows, error } = await supabase.from("follows").select("following_user_id").eq("follower_user_id", user.id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = rows.map(row => row.following_user_id);
    if (!ids.length) return res.json({ success: true, members: [] });
    const { data: profiles, error: profileError } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids);
    if (profileError) return res.status(500).json({ success: false, message: safeMessage(profileError) });
    res.json({ success: true, members: await enrichMembers(profiles, user.id, { hideRestricted: false }) });
}));

app.post("/api/profiles/:publicId/save", requireAuth(async (req, res, user) => {
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Profile not found." });
    if (target.user_id === user.id) return res.status(400).json({ success: false, message: "You cannot save yourself." });
    const { error } = await supabase.from("saved_members").upsert({ user_id: user.id, saved_user_id: target.user_id }, { onConflict: "user_id,saved_user_id" });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "Saved." });
}));
app.delete("/api/profiles/:publicId/save", requireAuth(async (req, res, user) => {
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Profile not found." });
    const { error } = await supabase.from("saved_members").delete().eq("user_id", user.id).eq("saved_user_id", target.user_id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "Removed." });
}));

app.post("/api/profiles/:publicId/connect", requireAuth(async (req, res, user) => {
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Profile not found." });
    if (target.user_id === user.id) return res.status(400).json({ success: false, message: "You cannot connect with yourself." });
    const settings = await getSettings(target.user_id);
    if (settings.connection_requests === "nobody") return res.status(403).json({ success: false, message: "This member is not accepting connection requests." });
    if (settings.connection_requests === "connections" && !(await sharesAConnection(user.id, target.user_id))) {
        return res.status(403).json({ success: false, message: "This member only accepts requests from people they share a connection with." });
    }
    // An old row for this pair may exist in any state. Only a live one blocks a
    // new request; a rejected or cancelled one is reopened instead of inserting
    // a duplicate, which the unique pair index would reject anyway.
    const existing = await connectionBetween(user.id, target.user_id);
    if (existing) return res.status(409).json({ success: false, message: existing.status === "accepted" ? "You are already connected." : "A connection request is already pending." });
    const { data: stale } = await supabase.from("connection_requests").select("id")
        .or(`and(sender_user_id.eq.${user.id},receiver_user_id.eq.${target.user_id}),and(sender_user_id.eq.${target.user_id},receiver_user_id.eq.${user.id})`)
        .in("status", ["rejected", "cancelled"]).limit(1);
    const { data: request, error } = stale && stale.length
        ? await supabase.from("connection_requests").update({ sender_user_id: user.id, receiver_user_id: target.user_id, status: "pending", updated_at: new Date().toISOString() }).eq("id", stale[0].id).select("id, status").single()
        : await supabase.from("connection_requests").insert({ sender_user_id: user.id, receiver_user_id: target.user_id }).select("id, status").single();
    if (uniqueViolation(error)) return res.status(409).json({ success: false, message: "A connection request is already pending." });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (settings.notify_connection_requests) {
        const { data: actor } = await supabase.from("profiles").select("name").eq("user_id", user.id).single();
        await supabase.from("notifications").insert({ recipient_user_id: target.user_id, actor_user_id: user.id, connection_request_id: request.id, type: "connection_request", message: `${actor ? actor.name : "A ProjectFinder member"} sent you a connection request.` });
    }
    res.status(201).json({ success: true, message: "Connection request sent.", connection: { status: "pending", direction: "sent" } });
}));
app.put("/api/connections/:id", requireAuth(async (req, res, user) => {
    const status = String((req.body || {}).status || "");
    if (!["accepted", "rejected", "cancelled"].includes(status)) return res.status(400).json({ success: false, message: "Invalid connection action." });
    const { data: request, error: requestError } = await supabase.from("connection_requests").select("*").eq("id", req.params.id).maybeSingle();
    if (requestError || !request) return res.status(404).json({ success: false, message: "Connection request not found." });
    if (request.status !== "pending") return res.status(409).json({ success: false, message: "This request is no longer pending." });
    if ((status === "cancelled" && request.sender_user_id !== user.id) || ((status === "accepted" || status === "rejected") && request.receiver_user_id !== user.id)) return res.status(403).json({ success: false, message: "You cannot update this connection request." });
    const { error } = await supabase.from("connection_requests").update({ status, updated_at: new Date().toISOString() }).eq("id", request.id).eq("status", "pending");
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (status === "accepted") { const senderSettings = await getSettings(request.sender_user_id); if (senderSettings.notify_connection_accepted) { const { data: actor } = await supabase.from("profiles").select("name").eq("user_id", user.id).single(); await supabase.from("notifications").insert({ recipient_user_id: request.sender_user_id, actor_user_id: user.id, connection_request_id: request.id, type: "connection_accepted", message: `${actor ? actor.name : "A ProjectFinder member"} accepted your connection request.` }); } }
    res.json({ success: true, message: status === "accepted" ? "Connection accepted." : status === "rejected" ? "Connection request rejected." : "Connection request cancelled." });
}));
app.delete("/api/connections/:id", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("connection_requests").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("status", "accepted").or(`sender_user_id.eq.${user.id},receiver_user_id.eq.${user.id}`).select("id").maybeSingle();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Connection not found." });
    res.json({ success: true, message: "Connection removed." });
}));
app.get("/api/connection-requests", requireAuth(async (req, res, user) => {
    // Both directions: requests waiting on you, and requests you sent that are
    // still pending (so you can cancel them). Only received ones were returned
    // before, which left sent requests with no way to be withdrawn.
    const [received, sent] = await Promise.all([
        supabase.from("connection_requests").select("id, sender_user_id, created_at").eq("receiver_user_id", user.id).eq("status", "pending").order("created_at", { ascending: false }),
        supabase.from("connection_requests").select("id, receiver_user_id, created_at").eq("sender_user_id", user.id).eq("status", "pending").order("created_at", { ascending: false })
    ]);
    if (received.error || sent.error) return res.status(500).json({ success: false, message: safeMessage(received.error || sent.error) });
    const ids = [...new Set([...received.data.map(row => row.sender_user_id), ...sent.data.map(row => row.receiver_user_id)])];
    const { data: people, error: peopleError } = ids.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids) : { data: [], error: null };
    if (peopleError) return res.status(500).json({ success: false, message: safeMessage(peopleError) });
    const map = new Map(people.map(person => [person.user_id, safeProfile(person)]));
    res.json({
        success: true,
        requests: received.data.map(row => ({ id: row.id, created_at: row.created_at, profile: map.get(row.sender_user_id) })).filter(row => row.profile),
        sent: sent.data.map(row => ({ id: row.id, created_at: row.created_at, profile: map.get(row.receiver_user_id) })).filter(row => row.profile)
    });
}));
app.get("/api/connections", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("connection_requests").select("id, sender_user_id, receiver_user_id, created_at").eq("status", "accepted").or(`sender_user_id.eq.${user.id},receiver_user_id.eq.${user.id}`).order("updated_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = data.map(row => row.sender_user_id === user.id ? row.receiver_user_id : row.sender_user_id);
    const { data: people, error: peopleError } = ids.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids) : { data: [], error: null };
    if (peopleError) return res.status(500).json({ success: false, message: safeMessage(peopleError) });
    const byId = new Map(people.map(person => [person.user_id, person]));
    const enriched = await enrichMembers(data.map(row => byId.get(row.sender_user_id === user.id ? row.receiver_user_id : row.sender_user_id)).filter(Boolean), user.id, { hideRestricted: false });
    res.json({ success: true, connections: enriched });
}));

// ---- Education (one owner can have many records) ----
function educationPayload(body) {
    const institution = String(body.institution || "").trim();
    if (!institution) { const error = new Error("Institution is required."); error.statusCode = 400; throw error; }
    const year = (value, label) => {
        if (value === "" || value === null || value === undefined) return null;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2200) { const error = new Error(`${label} must be a valid year.`); error.statusCode = 400; throw error; }
        return parsed;
    };
    const currentlyStudying = body.currentlyStudying === true;
    const startYear = year(body.startYear, "Start year");
    const endYear = currentlyStudying ? null : year(body.endYear, "End year");
    if (startYear && endYear && endYear < startYear) { const error = new Error("End year cannot be earlier than start year."); error.statusCode = 400; throw error; }
    return { institution, degree_course: String(body.degreeCourse || "").trim(), field_of_study: String(body.fieldOfStudy || "").trim(), start_year: startYear, end_year: endYear, currently_studying: currentlyStudying, updated_at: new Date().toISOString() };
}

app.get("/api/profile/education", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("education").select("*").eq("user_id", user.id).order("currently_studying", { ascending: false }).order("start_year", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, education: data });
}));
app.post("/api/profile/education", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("education").insert({ ...educationPayload(req.body || {}), user_id: user.id }).select().single();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.status(201).json({ success: true, message: "Education added.", education: data });
}));
app.put("/api/profile/education/:id", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("education").update(educationPayload(req.body || {})).eq("id", req.params.id).eq("user_id", user.id).select().maybeSingle();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Education record not found." });
    res.json({ success: true, message: "Education updated.", education: data });
}));
app.delete("/api/profile/education/:id", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("education").delete().eq("id", req.params.id).eq("user_id", user.id).select("id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Education record not found." });
    res.json({ success: true, message: "Education deleted." });
}));

// ---- Skills (catalogue plus a unique per-user relation) ----
app.get("/api/skills", requireAuth(async (req, res) => {
    const query = String(req.query.q || "").trim();
    let request = supabase.from("skills").select("id, name").order("name").limit(12);
    if (query) request = request.ilike("name", `%${query.replace(/[%_,]/g, "")}%`);
    const { data, error } = await request;
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, skills: data });
}));
app.get("/api/profile/skills", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("user_skills").select("skill_id, skills(id, name)").eq("user_id", user.id).order("created_at");
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, skills: data.map(row => row.skills).filter(Boolean) });
}));
app.post("/api/profile/skills", requireAuth(async (req, res, user) => {
    const name = String((req.body || {}).name || "").trim();
    if (!name || name.length > 60) return res.status(400).json({ success: false, message: "Enter a skill between 1 and 60 characters." });
    const { data: skill, error: skillError } = await supabase.from("skills").upsert({ name }, { onConflict: "normalized_name" }).select("id, name").single();
    if (skillError) return res.status(400).json({ success: false, message: safeMessage(skillError) });
    const { error } = await supabase.from("user_skills").insert({ user_id: user.id, skill_id: skill.id });
    if (uniqueViolation(error)) return res.status(409).json({ success: false, message: "That skill is already on your profile." });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.status(201).json({ success: true, message: "Skill added.", skill });
}));
app.delete("/api/profile/skills/:id", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("user_skills").delete().eq("user_id", user.id).eq("skill_id", req.params.id).select("skill_id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Skill not found on your profile." });
    res.json({ success: true, message: "Skill removed." });
}));

// Existing projects are used as-is. A project owner participates by default;
// a `project_members` row represents a real additional collaborator.
app.get("/api/profile/projects", requireAuth(async (req, res, user) => {
    const projectFields = "id, user_id, title, description, skills, category, status, created_at";
    const [ownedResult, membershipResult] = await Promise.all([
        supabase.from("projects").select(projectFields).eq("user_id", user.id),
        supabase.from("project_members").select(`role, joined_at, left_at, projects(${projectFields})`).eq("user_id", user.id)
    ]);
    if (ownedResult.error || membershipResult.error) return res.status(500).json({ success: false, message: (ownedResult.error || membershipResult.error).message });
    const map = new Map();
    ownedResult.data.forEach(project => map.set(project.id, { ...project, member_role: "Owner", joined_at: project.created_at, active_member: project.status !== "Closed" }));
    membershipResult.data.forEach(row => { if (row.projects) map.set(row.projects.id, { ...row.projects, member_role: row.role, joined_at: row.joined_at, active_member: !row.left_at && row.projects.status !== "Closed" }); });
    const projects = [...map.values()];
    const ids = projects.map(project => project.id);
    const { data: memberships, error: memberError } = ids.length ? await supabase.from("project_members").select("project_id, user_id").in("project_id", ids).is("left_at", null) : { data: [], error: null };
    if (memberError) return res.status(500).json({ success: false, message: safeMessage(memberError) });
    const teamSize = Object.fromEntries(ids.map(id => [id, 1]));
    memberships.forEach(member => { if (!projects.find(project => project.id === member.project_id && project.user_id === member.user_id)) teamSize[member.project_id]++; });
    projects.forEach(project => project.team_size = teamSize[project.id]);
    const current = projects.filter(project => project.active_member);
    const completed = projects.filter(project => project.status === "Closed");
    const teamsJoined = membershipResult.data.filter(row => row.left_at === null).length;
    const { count: skillsCount, error: skillsError } = await supabase.from("user_skills").select("skill_id", { count: "exact", head: true }).eq("user_id", user.id);
    if (skillsError) return res.status(500).json({ success: false, message: safeMessage(skillsError) });
    const safe = project => ({ id: project.id, title: project.title, description: project.description, skills: project.skills, category: project.category, status: project.status, created_at: project.created_at, member_role: project.member_role, joined_at: project.joined_at, team_size: project.team_size, can_manage: project.user_id === user.id });
    res.json({ success: true, current: current.map(safe), completed: completed.map(safe), stats: { projects_joined: projects.length, current_projects: current.length, completed_projects: completed.length, teams_joined: teamsJoined, teams_created: ownedResult.data.length, skills_count: skillsCount || 0, rating: null } });
}));

// ---- Profile photo (Supabase Storage) ----
// One file per user at "{user_id}.jpg" — uploading again simply
// replaces it (upsert), which is also how "change photo" is implemented.
app.post("/api/profile/photo", requireAuth(async (req, res, user) => {
    const { imageDataUrl } = req.body || {};
    if (!imageDataUrl || typeof imageDataUrl !== "string") return res.status(400).json({ success: false, message: "No image was provided." });

    const match = imageDataUrl.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!match) return res.status(400).json({ success: false, message: "Only JPEG, PNG, or WebP images are supported." });
    const [, mimeType, , base64Data] = match;
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ success: false, message: "Image must be smaller than 3MB." });

    const path = `${user.id}.jpg`; // always normalized to jpeg client-side before upload
    const { error: uploadError } = await supabase.storage.from(AVATAR_BUCKET).upload(path, buffer, { contentType: mimeType, upsert: true });
    if (uploadError) return res.status(500).json({ success: false, message: `Could not upload photo: ${uploadError.message}` });

    const { data: publicUrlData } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const photoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`; // cache-bust so the new photo shows immediately

    const { error: updateError } = await supabase.from("profiles").update({ photo: photoUrl }).eq("user_id", user.id);
    if (updateError) return res.status(500).json({ success: false, message: safeMessage(updateError) });

    return res.json({ success: true, message: "Photo updated.", photo: photoUrl });
}));

app.delete("/api/profile/photo", requireAuth(async (req, res, user) => {
    await supabase.storage.from(AVATAR_BUCKET).remove([`${user.id}.jpg`]); // best-effort; fine if it never existed
    const { error } = await supabase.from("profiles").update({ photo: "" }).eq("user_id", user.id);
    return error ? res.status(500).json({ success: false, message: safeMessage(error) }) : res.json({ success: true, message: "Photo removed." });
}));

// =================================================================
// Projects (existing functionality — unchanged)
// =================================================================
const PROJECT_STATUSES = ["Open", "In Progress", "On Hold", "Closed"];
const PROJECT_FIELDS = ["title", "description", "skills", "category", "status", "rolesNeeded", "availability", "link", "maxMembers", "dueDate", "progress"];
const PROJECT_COLUMN = { rolesNeeded: "roles_needed", maxMembers: "max_members", dueDate: "due_date" };
const projectPayload = (body) => {
    const out = {};
    for (const key of PROJECT_FIELDS) {
        if (!(key in (body || {})) || ["maxMembers", "dueDate", "progress"].includes(key)) continue;
        out[PROJECT_COLUMN[key] || key] = String(body[key] ?? "").trim();
    }
    if ("status" in out && !PROJECT_STATUSES.includes(out.status)) throw Object.assign(new Error("Invalid project status."), { statusCode: 400 });
    if ("maxMembers" in (body || {})) { const value = Number(body.maxMembers); if (!Number.isInteger(value) || value < 1 || value > 100) throw Object.assign(new Error("Maximum members must be between 1 and 100."), { statusCode: 400 }); out.max_members = value; }
    if ("progress" in (body || {})) { const value = Number(body.progress); if (!Number.isInteger(value) || value < 0 || value > 100) throw Object.assign(new Error("Progress must be a whole number between 0 and 100."), { statusCode: 400 }); out.progress = value; }
    if ("dueDate" in (body || {})) { const value = String(body.dueDate ?? "").trim(); if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error("Due date must be in YYYY-MM-DD form."), { statusCode: 400 }); out.due_date = value || null; }
    return out;
};

async function enrichProjects(projects, viewerId) {
    const ids = projects.map(project => project.id); if (!ids.length) return [];
    // viewerId is null for signed-out visitors: skip the per-viewer lookups
    // rather than querying with an undefined id, which returned no rows and
    // made the whole page fail.
    const [{ data: members, error: membersError }, { data: requests, error: requestsError }, { data: invitations, error: invitationsError }] = await Promise.all([
        // .is("left_at", null): people who left a team were still being counted,
        // which inflated team size and could wrongly report a project as full.
        supabase.from("project_members").select("project_id, user_id").in("project_id", ids).is("left_at", null),
        viewerId ? supabase.from("project_requests").select("project_id, status").eq("requester_user_id", viewerId).in("project_id", ids) : Promise.resolve({ data: [], error: null }),
        viewerId ? supabase.from("project_invitations").select("project_id, status").eq("invitee_user_id", viewerId).in("project_id", ids) : Promise.resolve({ data: [], error: null })
    ]);
    if (membersError || requestsError || invitationsError) throw membersError || requestsError || invitationsError;
    const sizes = new Map(ids.map(id => [id, 1])); // the owner always counts as one
    const memberIds = new Map(ids.map(id => [id, new Set()]));
    members.forEach(row => {
        const project = projects.find(p => p.id === row.project_id);
        if (!project || project.user_id === row.user_id) return;
        sizes.set(row.project_id, (sizes.get(row.project_id) || 1) + 1);
        memberIds.get(row.project_id).add(row.user_id);
    });

    // A small avatar stack per card (owner + up to 3 members) — real
    // photos/initials, not placeholders, so this needs one more query.
    const memberUserIds = [...new Set(members.map(row => row.user_id))];
    const { data: memberProfiles, error: memberProfilesError } = memberUserIds.length
        ? await supabase.from("profiles").select("user_id, name, photo, public_id").in("user_id", memberUserIds)
        : { data: [], error: null };
    if (memberProfilesError) throw memberProfilesError;
    const profileByUserId = new Map(memberProfiles.map(p => [p.user_id, p]));

    const requestMap = new Map(requests.map(row => [row.project_id, row.status]));
    const invitationMap = new Map(invitations.map(row => [row.project_id, row.status]));
    return projects.map(project => {
        const owner = project.profiles || {};
        const teammateAvatars = [...memberIds.get(project.id)].slice(0, 3)
            .map(id => profileByUserId.get(id))
            .filter(Boolean)
            .map(p => ({ name: p.name, photo: p.photo, public_id: p.public_id }));
        return {
            ...project,
            team_size: sizes.get(project.id) || 1,
            max_members: project.max_members || 0,
            request_status: requestMap.get(project.id) || null,
            invitation_status: invitationMap.get(project.id) || null,
            is_owner: project.user_id === viewerId,
            is_member: memberIds.get(project.id).has(viewerId),
            member_avatars: [{ name: owner.name, photo: owner.photo, public_id: owner.public_id }, ...teammateAvatars]
        };
    });
}
app.get("/api/projects/discover", optionalAuth(async (req, res, user) => {
    const q = String(req.query.q || "").trim().slice(0, 100), category = String(req.query.category || "").trim().slice(0, 80), skills = String(req.query.skills || "").trim().slice(0, 80), roles = String(req.query.roles || "").trim().slice(0, 80), status = String(req.query.status || "").trim(), availability = String(req.query.availability || "").trim().slice(0, 80); const page = Math.max(0, Number.parseInt(req.query.page, 10) || 0);
    if (status && !PROJECT_STATUSES.includes(status)) return res.status(400).json({ success: false, message: "Invalid project status." });
    let request = supabase.from("projects").select("id, user_id, title, description, skills, category, status, roles_needed, availability, link, max_members, due_date, progress, created_at, profiles!projects_user_id_fkey(name, username, public_id, photo)").order("created_at", { ascending: false });
    if (q) { const term = q.replace(/[%_,]/g, ""); request = request.or(`title.ilike.%${term}%,description.ilike.%${term}%,category.ilike.%${term}%,skills.ilike.%${term}%,roles_needed.ilike.%${term}%,status.ilike.%${term}%,availability.ilike.%${term}%`); }
    if (category) request = request.ilike("category", `%${category.replace(/[%_,]/g, "")}%`); if (skills) request = request.ilike("skills", `%${skills.replace(/[%_,]/g, "")}%`); if (roles) request = request.ilike("roles_needed", `%${roles.replace(/[%_,]/g, "")}%`); if (status) request = request.eq("status", status); if (availability) request = request.ilike("availability", `%${availability.replace(/[%_,]/g, "")}%`);
    const { data, error } = await request.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE); if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, projects: await enrichProjects(data.slice(0, PAGE_SIZE), user ? user.id : null), page, has_more: data.length > PAGE_SIZE, signed_in: Boolean(user) });
}));

// Real counts for the Find Teams sidebar — every number here is a direct
// count from the database, nothing hardcoded or estimated.
app.get("/api/teams/stats", asyncHandler(async (req, res) => {
    const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
    const [activeTeams, totalProjects, newToday, owners, activeMembers] = await Promise.all([
        supabase.from("projects").select("id", { count: "exact", head: true }).in("status", ["Open", "In Progress"]),
        supabase.from("projects").select("id", { count: "exact", head: true }),
        supabase.from("projects").select("id", { count: "exact", head: true }).gte("created_at", startOfToday.toISOString()),
        supabase.from("projects").select("user_id"),
        supabase.from("project_members").select("user_id").is("left_at", null)
    ]);
    const failed = [activeTeams, totalProjects, newToday, owners, activeMembers].find(r => r.error);
    if (failed) return res.status(500).json({ success: false, message: safeMessage(failed.error) });
    const memberIds = new Set([...(owners.data || []).map(r => r.user_id), ...(activeMembers.data || []).map(r => r.user_id)]);
    res.json({
        success: true,
        stats: {
            active_teams: activeTeams.count || 0,
            total_members: memberIds.size,
            projects_started: totalProjects.count || 0,
            new_today: newToday.count || 0
        }
    });
}));

app.get("/api/projects", asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from("projects").select("id, title, description, skills, category, status, roles_needed, availability, link, created_at, profiles!projects_user_id_fkey(name, photo, public_id, username)").order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    return res.json({ success: true, projects: data });
}));

// The owner's management dashboard: every project they created, bucketed by
// Active / On Hold / Completed, with team size so progress and headcount
// render without a second round trip per card.
app.get("/api/my-projects", requireAuth(async (req, res, user) => {
    const { data: projects, error } = await supabase.from("projects").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = projects.map(project => project.id);
    const { data: members, error: memberError } = ids.length
        ? await supabase.from("project_members").select("project_id, user_id").in("project_id", ids).is("left_at", null)
        : { data: [], error: null };
    if (memberError) return res.status(500).json({ success: false, message: safeMessage(memberError) });
    const sizes = new Map(ids.map(id => [id, 1])); // the owner always counts as one
    members.forEach(row => sizes.set(row.project_id, (sizes.get(row.project_id) || 1) + 1));
    const withSize = projects.map(project => ({ ...project, team_size: sizes.get(project.id) || 1 }));
    const active = withSize.filter(project => project.status === "Open" || project.status === "In Progress");
    const onHold = withSize.filter(project => project.status === "On Hold");
    const completed = withSize.filter(project => project.status === "Closed");
    return res.json({
        success: true,
        projects: withSize,
        active, onHold, completed,
        stats: { active: active.length, on_hold: onHold.length, completed: completed.length, total: withSize.length }
    });
}));

app.get("/api/projects/:id", asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from("projects").select("id, title, description, skills, category, status, roles_needed, availability, link, max_members, due_date, progress, created_at, user_id, profiles!projects_user_id_fkey(name, photo, public_id, username)").eq("id", req.params.id).maybeSingle();
    if (error) return res.status(400).json({ success: false, message: "Project not found." });
    if (!data) return res.status(404).json({ success: false, message: "Project not found." });

    // Roster (owner first, then active members) so the detail page can show who
    // is on the team without a second round trip.
    const { data: members, error: membersError } = await supabase.from("project_members")
        .select("user_id, role, joined_at").eq("project_id", data.id).is("left_at", null);
    if (membersError) return res.status(500).json({ success: false, message: safeMessage(membersError) });
    const { data: people } = members.length
        ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", members.map(row => row.user_id))
        : { data: [] };
    const byId = new Map((people || []).map(person => [person.user_id, person]));
    const team = [
        { ...(data.profiles || {}), team_role: "Owner" },
        ...members.map(row => { const person = byId.get(row.user_id); return person ? { ...safeProfile(person), team_role: row.role || "Member" } : null; }).filter(Boolean)
    ];

    // Viewer state is optional: this endpoint stays readable when signed out.
    const viewer = await getCurrentUser(req, res);
    let viewerState = { signed_in: false, is_owner: false, is_member: false, request_status: null, invitation_status: null };
    if (viewer) {
        const [request, invitation, membership] = await Promise.all([
            supabase.from("project_requests").select("status").eq("project_id", data.id).eq("requester_user_id", viewer.id).maybeSingle(),
            supabase.from("project_invitations").select("id, status").eq("project_id", data.id).eq("invitee_user_id", viewer.id).maybeSingle(),
            supabase.from("project_members").select("user_id").eq("project_id", data.id).eq("user_id", viewer.id).is("left_at", null).maybeSingle()
        ]);
        viewerState = {
            signed_in: true,
            is_owner: data.user_id === viewer.id,
            is_member: Boolean(membership.data),
            request_status: request.data ? request.data.status : null,
            invitation_status: invitation.data ? invitation.data.status : null,
            invitation_id: invitation.data && invitation.data.status === "pending" ? invitation.data.id : null
        };
    }

    const { user_id, ...publicProject } = data;
    return res.json({
        success: true,
        project: { ...publicProject, team_size: team.length, seats_left: data.max_members ? Math.max(0, data.max_members - team.length) : null },
        team,
        viewer: viewerState
    });
}));

// Current team size (owner + members who have not left) and remaining seats.
async function teamCapacity(project) {
    const { count, error } = await supabase.from("project_members")
        .select("user_id", { count: "exact", head: true })
        .eq("project_id", project.id).is("left_at", null);
    if (error) throw error;
    const size = (count || 0) + 1; // +1 for the owner, who has no member row
    const max = project.max_members || 0;
    return { size, max, isFull: max > 0 && size >= max };
}

// Adds someone to a team. A person who joined and later left already has a row
// (the primary key is project_id + user_id), so a plain insert failed with a
// duplicate-key error and made rejoining impossible. This upserts and clears
// left_at instead.
async function addProjectMember(projectId, userId, role = "Member") {
    const { error } = await supabase.from("project_members")
        .upsert({ project_id: projectId, user_id: userId, role, joined_at: new Date().toISOString(), left_at: null }, { onConflict: "project_id,user_id" });
    if (error) throw error;
    await logActivity(projectId, userId, "member_joined", `${await actorName(userId)} joined the team.`);
}

async function actorName(userId) {
    const { data } = await supabase.from("profiles").select("name").eq("user_id", userId).maybeSingle();
    return data ? data.name : "A ProjectFinder member";
}

// Team activity is best-effort, like notifications: a logging failure must
// never fail the action the user actually asked for.
async function logActivity(projectId, actorUserId, type, message) {
    try {
        const { error } = await supabase.from("project_activity").insert({ project_id: projectId, actor_user_id: actorUserId, type, message });
        if (error) console.error("Activity log insert failed:", error.message);
    } catch (error) {
        console.error("Activity log failed:", error.message);
    }
}

// Notifications are best-effort: a failure here must never fail the action the
// user actually asked for.
async function notify(recipientUserId, settingKey, payload) {
    try {
        const settings = await getSettings(recipientUserId);
        if (settingKey && settings[settingKey] === false) return;
        const { error } = await supabase.from("notifications").insert({ recipient_user_id: recipientUserId, ...payload });
        if (error) console.error("Notification insert failed:", error.message);
    } catch (error) {
        console.error("Notification failed:", error.message);
    }
}

app.post("/api/projects/:id/request", requireAuth(async (req, res, user) => {
    const message = String((req.body || {}).message || "").trim().slice(0, 500);
    const { data: project, error: projectError } = await supabase.from("projects").select("id, user_id, title, status, max_members").eq("id", req.params.id).maybeSingle();
    if (projectError || !project) return res.status(404).json({ success: false, message: "Project not found." });
    if (project.user_id === user.id) return res.status(400).json({ success: false, message: "You already own this project." });
    if (project.status !== "Open") return res.status(400).json({ success: false, message: "This project is not recruiting." });

    const { data: existingMember } = await supabase.from("project_members").select("project_id").eq("project_id", project.id).eq("user_id", user.id).is("left_at", null).maybeSingle();
    if (existingMember) return res.status(409).json({ success: false, message: "You are already a project member." });

    const capacity = await teamCapacity(project);
    if (capacity.isFull) return res.status(400).json({ success: false, message: "This project team is already full." });

    // An open invitation makes a join request redundant.
    const { data: invitation } = await supabase.from("project_invitations").select("id").eq("project_id", project.id).eq("invitee_user_id", user.id).eq("status", "pending").maybeSingle();
    if (invitation) return res.status(409).json({ success: false, message: "You already have an invitation to this project — check My Teams to accept it." });

    // A previous rejected/cancelled request keeps its row (project_id +
    // requester_user_id is unique), so reopen it rather than failing.
    const { data: existing } = await supabase.from("project_requests").select("id, status").eq("project_id", project.id).eq("requester_user_id", user.id).maybeSingle();
    if (existing && existing.status === "pending") return res.status(409).json({ success: false, message: "You have already requested to join this project." });
    if (existing && existing.status === "accepted") return res.status(409).json({ success: false, message: "You are already a project member." });

    const { data: request, error } = existing
        ? await supabase.from("project_requests").update({ status: "pending", message, updated_at: new Date().toISOString() }).eq("id", existing.id).select("id").single()
        : await supabase.from("project_requests").insert({ project_id: project.id, requester_user_id: user.id, message }).select("id").single();
    if (uniqueViolation(error)) return res.status(409).json({ success: false, message: "You have already requested to join this project." });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });

    await notify(project.user_id, "notify_project_requests", {
        actor_user_id: user.id, project_request_id: request.id, type: "project_request",
        message: `${await actorName(user.id)} requested to join ${project.title}.`, link: "team-dashboard.html"
    });
    res.status(201).json({ success: true, message: "Join request sent.", request_status: "pending" });
}));

app.put("/api/project-requests/:id", requireAuth(async (req, res, user) => {
    const status = String((req.body || {}).status || "");
    if (!["accepted", "rejected", "cancelled"].includes(status)) return res.status(400).json({ success: false, message: "Invalid request action." });
    const { data: request, error } = await supabase.from("project_requests").select("*, projects(id, user_id, title, status, max_members)").eq("id", req.params.id).maybeSingle();
    if (error || !request || !request.projects) return res.status(404).json({ success: false, message: "Project request not found." });
    if (request.status !== "pending") return res.status(409).json({ success: false, message: "This request is no longer pending." });

    const isOwner = request.projects.user_id === user.id;
    if (status === "cancelled" ? request.requester_user_id !== user.id : !isOwner) {
        return res.status(403).json({ success: false, message: "You cannot update this request." });
    }

    if (status === "accepted") {
        if (request.projects.status === "Closed") return res.status(400).json({ success: false, message: "This project is closed." });
        const capacity = await teamCapacity(request.projects);
        if (capacity.isFull) return res.status(400).json({ success: false, message: `This team is full (${capacity.size}/${capacity.max}).` });
        try {
            await addProjectMember(request.project_id, request.requester_user_id);
        } catch (memberError) {
            return res.status(400).json({ success: false, message: safeMessage(memberError) });
        }
    }

    // The status guard makes this a no-op if two owners act at the same time.
    const { data: updated, error: updateError } = await supabase.from("project_requests")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", request.id).eq("status", "pending").select("id").maybeSingle();
    if (updateError) return res.status(400).json({ success: false, message: safeMessage(updateError) });
    if (!updated) return res.status(409).json({ success: false, message: "This request was already handled." });

    if (status !== "cancelled") {
        await notify(request.requester_user_id, "notify_project_requests", {
            actor_user_id: user.id,
            project_request_id: request.id,
            type: status === "accepted" ? "project_request_accepted" : "project_request_rejected",
            message: status === "accepted"
                ? `${await actorName(user.id)} accepted your request to join ${request.projects.title}.`
                : `Your request to join ${request.projects.title} was declined.`,
            link: "team-dashboard.html"
        });
    }
    res.json({ success: true, message: status === "accepted" ? "Member added to the project." : status === "rejected" ? "Join request rejected." : "Join request cancelled." });
}));

// =================================================================
// Project invitations — the owner invites, the invitee accepts.
// This is the mirror image of the join-request flow above.
// =================================================================
async function ownedProject(projectId, ownerId) {
    const { data, error } = await supabase.from("projects").select("id, user_id, title, status, max_members").eq("id", projectId).maybeSingle();
    if (error || !data) return { error: { status: 404, message: "Project not found." } };
    if (data.user_id !== ownerId) return { error: { status: 403, message: "Only the project owner can do that." } };
    return { project: data };
}

app.post("/api/projects/:id/invite", requireAuth(async (req, res, user) => {
    const { publicId, role, message } = req.body || {};
    const identifier = String(publicId || "").trim();
    if (!identifier) return res.status(400).json({ success: false, message: "Enter the member's public ID (for example PTF-7K29A) or their @username." });

    const { project, error: ownerError } = await ownedProject(req.params.id, user.id);
    if (ownerError) return res.status(ownerError.status).json({ success: false, message: safeMessage(ownerError) });
    if (project.status === "Closed") return res.status(400).json({ success: false, message: "This project is closed, so you cannot invite anyone to it." });

    // Accept a public ID, a @username, or a plain username.
    const lookup = identifier.replace(/^@/, "");
    let invitee = await profileByPublicId(lookup.toUpperCase());
    if (!invitee) {
        const { data, error } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).eq("username", lookup.toLowerCase()).maybeSingle();
        if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
        invitee = data;
    }
    if (!invitee) return res.status(404).json({ success: false, message: "No member found with that public ID or username." });
    if (invitee.user_id === user.id) return res.status(400).json({ success: false, message: "You already own this project." });

    const { data: alreadyMember } = await supabase.from("project_members").select("project_id").eq("project_id", project.id).eq("user_id", invitee.user_id).is("left_at", null).maybeSingle();
    if (alreadyMember) return res.status(409).json({ success: false, message: `${invitee.name} is already on this team.` });

    const capacity = await teamCapacity(project);
    if (capacity.isFull) return res.status(400).json({ success: false, message: `This team is full (${capacity.size}/${capacity.max}). Raise the member limit first.` });

    // If they already asked to join, accept that request instead of creating a
    // competing invitation.
    const { data: openRequest } = await supabase.from("project_requests").select("id").eq("project_id", project.id).eq("requester_user_id", invitee.user_id).eq("status", "pending").maybeSingle();
    if (openRequest) return res.status(409).json({ success: false, message: `${invitee.name} has already asked to join. Accept their request below instead.` });

    const { data: existing } = await supabase.from("project_invitations").select("id, status").eq("project_id", project.id).eq("invitee_user_id", invitee.user_id).maybeSingle();
    if (existing && existing.status === "pending") return res.status(409).json({ success: false, message: `${invitee.name} already has a pending invitation.` });

    const payload = {
        project_id: project.id, inviter_user_id: user.id, invitee_user_id: invitee.user_id,
        role: String(role || "Member").trim().slice(0, 40) || "Member",
        message: String(message || "").trim().slice(0, 500),
        status: "pending", updated_at: new Date().toISOString()
    };
    const { data: invitation, error } = existing
        ? await supabase.from("project_invitations").update(payload).eq("id", existing.id).select("id").single()
        : await supabase.from("project_invitations").insert(payload).select("id").single();
    if (uniqueViolation(error)) return res.status(409).json({ success: false, message: `${invitee.name} already has an invitation to this project.` });
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });

    await notify(invitee.user_id, "notify_team_invitations", {
        actor_user_id: user.id, project_invitation_id: invitation.id, type: "team_invitation",
        message: `${await actorName(user.id)} invited you to join ${project.title}.`, link: "team-dashboard.html"
    });
    res.status(201).json({ success: true, message: `Invitation sent to ${invitee.name}.` });
}));

// Invitations waiting on the signed-in user.
app.get("/api/my-invitations", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("project_invitations")
        .select("id, role, message, created_at, inviter_user_id, projects!inner(id, title, description, status, max_members)")
        .eq("invitee_user_id", user.id).eq("status", "pending").order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = [...new Set(data.map(row => row.inviter_user_id))];
    const { data: people, error: peopleError } = ids.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids) : { data: [], error: null };
    if (peopleError) return res.status(500).json({ success: false, message: safeMessage(peopleError) });
    const byId = new Map(people.map(person => [person.user_id, safeProfile(person)]));
    res.json({
        success: true,
        invitations: data.map(row => ({
            id: row.id, role: row.role, message: row.message, created_at: row.created_at,
            project: { id: row.projects.id, title: row.projects.title, description: row.projects.description, status: row.projects.status },
            profile: byId.get(row.inviter_user_id) || null
        }))
    });
}));

app.put("/api/project-invitations/:id", requireAuth(async (req, res, user) => {
    const status = String((req.body || {}).status || "");
    if (!["accepted", "declined", "cancelled"].includes(status)) return res.status(400).json({ success: false, message: "Invalid invitation action." });
    const { data: invitation, error } = await supabase.from("project_invitations")
        .select("*, projects(id, user_id, title, status, max_members)").eq("id", req.params.id).maybeSingle();
    if (error || !invitation || !invitation.projects) return res.status(404).json({ success: false, message: "Invitation not found." });
    if (invitation.status !== "pending") return res.status(409).json({ success: false, message: "This invitation is no longer pending." });

    const isOwner = invitation.projects.user_id === user.id;
    // The invitee accepts or declines; the owner withdraws.
    if (status === "cancelled" ? !isOwner : invitation.invitee_user_id !== user.id) {
        return res.status(403).json({ success: false, message: "You cannot update this invitation." });
    }

    if (status === "accepted") {
        if (invitation.projects.status === "Closed") return res.status(400).json({ success: false, message: "This project is closed." });
        const capacity = await teamCapacity(invitation.projects);
        if (capacity.isFull) return res.status(400).json({ success: false, message: `This team filled up before you accepted (${capacity.size}/${capacity.max}).` });
        try {
            await addProjectMember(invitation.project_id, invitation.invitee_user_id, invitation.role || "Member");
        } catch (memberError) {
            return res.status(400).json({ success: false, message: safeMessage(memberError) });
        }
        // Any join request they had for the same project is now redundant.
        await supabase.from("project_requests").update({ status: "accepted", updated_at: new Date().toISOString() })
            .eq("project_id", invitation.project_id).eq("requester_user_id", invitation.invitee_user_id).eq("status", "pending");
    }

    const { data: updated, error: updateError } = await supabase.from("project_invitations")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", invitation.id).eq("status", "pending").select("id").maybeSingle();
    if (updateError) return res.status(400).json({ success: false, message: safeMessage(updateError) });
    if (!updated) return res.status(409).json({ success: false, message: "This invitation was already handled." });

    if (status !== "cancelled") {
        await notify(invitation.inviter_user_id, "notify_team_invitations", {
            actor_user_id: user.id, project_invitation_id: invitation.id,
            type: status === "accepted" ? "team_invitation_accepted" : "team_invitation_declined",
            message: `${await actorName(user.id)} ${status === "accepted" ? "accepted" : "declined"} your invitation to ${invitation.projects.title}.`,
            link: `team-dashboard.html?id=${invitation.projects.id}`
        });
    }
    res.json({ success: true, message: status === "accepted" ? "You joined the team." : status === "declined" ? "Invitation declined." : "Invitation withdrawn." });
}));

// Owner removes a member; a member removes themselves (leaves).
app.delete("/api/projects/:id/members/:publicId", requireAuth(async (req, res, user) => {
    const { data: project, error: projectError } = await supabase.from("projects").select("id, user_id, title").eq("id", req.params.id).maybeSingle();
    if (projectError || !project) return res.status(404).json({ success: false, message: "Project not found." });
    const target = await profileByPublicId(req.params.publicId);
    if (!target) return res.status(404).json({ success: false, message: "Member not found." });
    if (target.user_id === project.user_id) return res.status(400).json({ success: false, message: "The project owner cannot be removed. Delete the project instead." });

    const isOwner = project.user_id === user.id;
    const isSelf = target.user_id === user.id;
    if (!isOwner && !isSelf) return res.status(403).json({ success: false, message: "Only the project owner can remove a member." });

    const { data: removed, error } = await supabase.from("project_members")
        .update({ left_at: new Date().toISOString() })
        .eq("project_id", project.id).eq("user_id", target.user_id).is("left_at", null)
        .select("user_id").maybeSingle();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    if (!removed) return res.status(404).json({ success: false, message: "That person is not an active member of this team." });

    // Clearing the old accepted request lets them ask to join again later.
    await supabase.from("project_requests").update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("project_id", project.id).eq("requester_user_id", target.user_id).eq("status", "accepted");

    if (isSelf && !isOwner) {
        await notify(project.user_id, "notify_project_requests", {
            actor_user_id: user.id, type: "team_member_left",
            message: `${await actorName(user.id)} left ${project.title}.`, link: `team-dashboard.html?id=${project.id}`
        });
        await logActivity(project.id, user.id, "member_left", `${await actorName(user.id)} left the team.`);
    } else if (isOwner && !isSelf) {
        await notify(target.user_id, "notify_project_requests", {
            actor_user_id: user.id, type: "team_member_removed",
            message: `You were removed from ${project.title}.`, link: "team-dashboard.html"
        });
        await logActivity(project.id, user.id, "member_left", `${target.name} was removed from the team.`);
    }
    res.json({ success: true, message: isSelf ? "You left the team." : `${target.name} was removed from the team.` });
}));
app.get("/api/my-project-requests", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("project_requests").select("id, project_id, requester_user_id, message, created_at, projects!inner(title, user_id)").eq("status", "pending").eq("projects.user_id", user.id).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    const ids = data.map(row => row.requester_user_id); const { data: people, error: peopleError } = ids.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", ids) : { data: [], error: null };
    if (peopleError) return res.status(500).json({ success: false, message: safeMessage(peopleError) }); const byId = new Map(people.map(person => [person.user_id, safeProfile(person)]));
    res.json({ success: true, requests: data.map(row => ({ id: row.id, project_id: row.project_id, project_title: row.projects.title, message: row.message || "", created_at: row.created_at, profile: byId.get(row.requester_user_id) })).filter(row => row.profile) });
}));

app.get("/api/my-teams", requireAuth(async (req, res, user) => {
    // A "team" here is any project the user owns, or is an active (not-left) member of.
    const [{ data: owned, error: ownedError }, { data: memberships, error: membershipError }] = await Promise.all([
        supabase.from("projects").select("id, title, status, max_members, created_at, user_id").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("project_members").select("project_id, projects(id, title, status, max_members, created_at, user_id)").eq("user_id", user.id).is("left_at", null)
    ]);
    if (ownedError || membershipError) return res.status(500).json({ success: false, message: safeMessage(ownedError || membershipError) });

    const projectsById = new Map();
    (owned || []).forEach(project => projectsById.set(project.id, project));
    (memberships || []).forEach(row => { if (row.projects && !projectsById.has(row.project_id)) projectsById.set(row.project_id, row.projects); });
    const projectIds = [...projectsById.keys()];
    if (!projectIds.length) return res.json({ success: true, teams: [] });

    const { data: allMembers, error: membersError } = await supabase.from("project_members").select("project_id, user_id, role, joined_at").in("project_id", projectIds).is("left_at", null);
    if (membersError) return res.status(500).json({ success: false, message: safeMessage(membersError) });

    const rosterUserIds = new Set(projectIds.map(id => projectsById.get(id).user_id));
    allMembers.forEach(row => rosterUserIds.add(row.user_id));
    const { data: rawProfiles, error: profilesError } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", [...rosterUserIds]);
    if (profilesError) return res.status(500).json({ success: false, message: safeMessage(profilesError) });

    // hideRestricted:false — a teammate is someone you already work with, so a
    // "connections only" setting must not delete them from your own roster.
    const enriched = await enrichMembers(rawProfiles, user.id, { hideRestricted: false });
    const publicIdByUserId = new Map(rawProfiles.map(profile => [profile.user_id, profile.public_id]));
    const enrichedByPublicId = new Map(enriched.map(profile => [profile.public_id, profile]));
    const profileFor = userId => { const publicId = publicIdByUserId.get(userId); return publicId ? enrichedByPublicId.get(publicId) : null; };

    const membersByProject = new Map();
    allMembers.forEach(row => {
        const profile = profileFor(row.user_id);
        if (!profile) return;
        if (!membersByProject.has(row.project_id)) membersByProject.set(row.project_id, []);
        membersByProject.get(row.project_id).push({ ...profile, team_role: row.role || "Member", joined_at: row.joined_at });
    });

    // Invitations the owner has sent that are still waiting for an answer, so
    // they can be seen and withdrawn from the same screen.
    const ownedIds = (owned || []).map(project => project.id);
    let invitationsByProject = new Map();
    if (ownedIds.length) {
        const { data: pendingInvites, error: inviteError } = await supabase.from("project_invitations")
            .select("id, project_id, role, created_at, invitee_user_id").in("project_id", ownedIds).eq("status", "pending");
        if (inviteError) return res.status(500).json({ success: false, message: safeMessage(inviteError) });
        const inviteeIds = [...new Set(pendingInvites.map(row => row.invitee_user_id))];
        const { data: invitees, error: inviteeError } = inviteeIds.length
            ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", inviteeIds)
            : { data: [], error: null };
        if (inviteeError) return res.status(500).json({ success: false, message: safeMessage(inviteeError) });
        const inviteeById = new Map(invitees.map(person => [person.user_id, safeProfile(person)]));
        pendingInvites.forEach(row => {
            const profile = inviteeById.get(row.invitee_user_id);
            if (!profile) return;
            if (!invitationsByProject.has(row.project_id)) invitationsByProject.set(row.project_id, []);
            invitationsByProject.get(row.project_id).push({ id: row.id, role: row.role, created_at: row.created_at, profile });
        });
    }

    const teams = projectIds.map(id => {
        const project = projectsById.get(id);
        const ownerProfile = profileFor(project.user_id);
        const roster = ownerProfile ? [{ ...ownerProfile, team_role: "Owner", joined_at: project.created_at, is_owner: true }] : [];
        const members = roster.concat(membersByProject.get(id) || []);
        return {
            project: { id: project.id, title: project.title, status: project.status, max_members: project.max_members || 0 },
            is_owner: project.user_id === user.id,
            team_size: members.length,
            seats_left: project.max_members ? Math.max(0, project.max_members - members.length) : null,
            members,
            pending_invitations: invitationsByProject.get(id) || []
        };
    }).sort((a, b) => a.project.title.localeCompare(b.project.title));

    res.json({ success: true, teams });
}));

// =================================================================
// Team dashboard — one page per team, showing roster, tasks, files
// and activity for a project the viewer owns or actively belongs to.
// =================================================================

// A short, stable, non-secret label shown next to the team name. Derived
// straight from the project id (no new column, no lookup table needed).
function teamCode(projectId) {
    return projectId.replace(/-/g, "").slice(0, 6).toUpperCase();
}

async function teamMembership(projectId, userId) {
    const { data: project, error } = await supabase.from("projects")
        .select("id, user_id, title, description, status, max_members, due_date, progress, created_at")
        .eq("id", projectId).maybeSingle();
    if (error || !project) return { error: { status: 404, message: "Project not found." } };
    if (project.user_id === userId) return { project, isOwner: true, isMember: true, role: "Owner" };
    const { data: member } = await supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).is("left_at", null).maybeSingle();
    if (!member) return { project, isOwner: false, isMember: false, role: null };
    return { project, isOwner: false, isMember: true, role: member.role || "Member" };
}

app.get("/api/projects/:id/team-dashboard", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });
    const { project, isOwner, role } = membership;

    const { data: memberRows, error: memberError } = await supabase.from("project_members").select("user_id, role, joined_at").eq("project_id", project.id).is("left_at", null);
    if (memberError) return res.status(500).json({ success: false, message: safeMessage(memberError) });

    const rosterUserIds = [project.user_id, ...memberRows.map(row => row.user_id)];
    const { data: rawProfiles, error: profilesError } = await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", rosterUserIds);
    if (profilesError) return res.status(500).json({ success: false, message: safeMessage(profilesError) });

    // hideRestricted:false — a teammate is someone you already work with, so a
    // "connections only" setting must not delete them from their own roster.
    const enriched = await enrichMembers(rawProfiles, user.id, { hideRestricted: false });
    const publicIdByUserId = new Map(rawProfiles.map(p => [p.user_id, p.public_id]));
    const enrichedByPublicId = new Map(enriched.map(p => [p.public_id, p]));
    const profileFor = uid => { const pid = publicIdByUserId.get(uid); return pid ? enrichedByPublicId.get(pid) : null; };

    const ownerProfile = profileFor(project.user_id);
    const roster = [
        ...(ownerProfile ? [{ ...ownerProfile, team_role: "Owner", joined_at: project.created_at, is_owner: true }] : []),
        ...memberRows.map(row => { const profile = profileFor(row.user_id); return profile ? { ...profile, team_role: row.role || "Member", joined_at: row.joined_at, is_owner: false } : null; }).filter(Boolean)
    ];

    const [tasksTotal, tasksDone, tasksInProgress, filesTotal] = await Promise.all([
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("project_id", project.id),
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("project_id", project.id).eq("status", "done"),
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("project_id", project.id).eq("status", "in_progress"),
        supabase.from("project_files").select("id", { count: "exact", head: true }).eq("project_id", project.id)
    ]);

    res.json({
        success: true,
        project: {
            id: project.id, title: project.title, description: project.description || "", status: project.status,
            due_date: project.due_date, progress: project.progress || 0, max_members: project.max_members || 0, created_at: project.created_at
        },
        team_code: teamCode(project.id),
        viewer: { is_owner: isOwner, role },
        roster,
        stats: {
            total_members: roster.length,
            tasks_total: tasksTotal.count || 0,
            tasks_in_progress: tasksInProgress.count || 0,
            tasks_completed: tasksDone.count || 0,
            files_total: filesTotal.count || 0
        }
    });
}));

// ---- Tasks ----
const TASK_PHASES = ["Research & Planning", "Design", "Development", "Testing", "Launch"];
const TASK_STATUSES = ["todo", "in_progress", "done"];

app.get("/api/projects/:id/tasks", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const { data: tasks, error } = await supabase.from("tasks")
        .select("id, title, description, phase, status, assignee_user_id, created_by, created_at, updated_at, completed_at")
        .eq("project_id", req.params.id).order("created_at", { ascending: true });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });

    const assigneeIds = [...new Set(tasks.map(t => t.assignee_user_id).filter(Boolean))];
    const { data: assignees } = assigneeIds.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", assigneeIds) : { data: [] };
    const assigneeMap = new Map((assignees || []).map(p => [p.user_id, safeProfile(p)]));

    res.json({
        success: true,
        tasks: tasks.map(t => ({ ...t, assignee: t.assignee_user_id ? assigneeMap.get(t.assignee_user_id) || null : null, can_manage: membership.isOwner || t.created_by === user.id }))
    });
}));

app.post("/api/projects/:id/tasks", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const body = req.body || {};
    const title = String(body.title || "").trim();
    if (!title) return res.status(400).json({ success: false, message: "A task title is required." });
    const description = String(body.description || "").trim().slice(0, 2000);
    const phase = TASK_PHASES.includes(body.phase) ? body.phase : TASK_PHASES[0];

    let assigneeUserId = null;
    const assigneePublicId = String(body.assigneePublicId || "").trim();
    if (assigneePublicId) {
        const assignee = await profileByPublicId(assigneePublicId);
        if (!assignee) return res.status(404).json({ success: false, message: "Assignee not found." });
        const assigneeMembership = await teamMembership(req.params.id, assignee.user_id);
        if (!assigneeMembership.isMember) return res.status(400).json({ success: false, message: "You can only assign tasks to team members." });
        assigneeUserId = assignee.user_id;
    }

    const { data: task, error } = await supabase.from("tasks")
        .insert({ project_id: req.params.id, title, description, phase, assignee_user_id: assigneeUserId, created_by: user.id })
        .select().single();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    await logActivity(req.params.id, user.id, "task_created", `${await actorName(user.id)} created a task: ${title}.`);
    res.status(201).json({ success: true, message: "Task added.", task });
}));

app.put("/api/tasks/:id", requireAuth(async (req, res, user) => {
    const { data: existing, error: existingError } = await supabase.from("tasks").select("*").eq("id", req.params.id).maybeSingle();
    if (existingError || !existing) return res.status(404).json({ success: false, message: "Task not found." });
    const membership = await teamMembership(existing.project_id, user.id);
    if (membership.error || !membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const body = req.body || {};
    const patch = {};
    if ("title" in body) { const title = String(body.title || "").trim(); if (!title) return res.status(400).json({ success: false, message: "A task title is required." }); patch.title = title; }
    if ("description" in body) patch.description = String(body.description || "").trim().slice(0, 2000);
    if ("phase" in body && TASK_PHASES.includes(body.phase)) patch.phase = body.phase;
    if ("assigneePublicId" in body) {
        const assigneePublicId = String(body.assigneePublicId || "").trim();
        if (!assigneePublicId) patch.assignee_user_id = null;
        else {
            const assignee = await profileByPublicId(assigneePublicId);
            if (!assignee) return res.status(404).json({ success: false, message: "Assignee not found." });
            const assigneeMembership = await teamMembership(existing.project_id, assignee.user_id);
            if (!assigneeMembership.isMember) return res.status(400).json({ success: false, message: "You can only assign tasks to team members." });
            patch.assignee_user_id = assignee.user_id;
        }
    }
    let statusChanged = false, justCompleted = false;
    if ("status" in body && TASK_STATUSES.includes(body.status) && body.status !== existing.status) {
        patch.status = body.status;
        statusChanged = true;
        patch.completed_at = body.status === "done" ? new Date().toISOString() : null;
        justCompleted = body.status === "done";
    }

    const { data: task, error } = await supabase.from("tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", existing.id).select().single();
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });

    if (statusChanged) {
        await logActivity(existing.project_id, user.id, justCompleted ? "task_completed" : "task_status_changed",
            justCompleted ? `${await actorName(user.id)} completed "${task.title}".` : `${await actorName(user.id)} moved "${task.title}" to ${task.status.replace("_", " ")}.`);
    }
    res.json({ success: true, message: "Task updated.", task });
}));

app.delete("/api/tasks/:id", requireAuth(async (req, res, user) => {
    const { data: existing, error: existingError } = await supabase.from("tasks").select("id, project_id, created_by, title").eq("id", req.params.id).maybeSingle();
    if (existingError || !existing) return res.status(404).json({ success: false, message: "Task not found." });
    const membership = await teamMembership(existing.project_id, user.id);
    if (membership.error || !membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });
    if (existing.created_by !== user.id && !membership.isOwner) return res.status(403).json({ success: false, message: "Only the task creator or team owner can delete this task." });

    const { error } = await supabase.from("tasks").delete().eq("id", existing.id);
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "Task deleted." });
}));

// ---- Files ----
const TEAM_FILE_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "application/pdf", "text/plain", "text/csv",
    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip", "application/json"
]);

app.get("/api/projects/:id/files", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const { data: files, error } = await supabase.from("project_files")
        .select("id, uploaded_by, name, path, size, content_type, created_at")
        .eq("project_id", req.params.id).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });

    const uploaderIds = [...new Set(files.map(f => f.uploaded_by))];
    const { data: uploaders } = uploaderIds.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", uploaderIds) : { data: [] };
    const uploaderMap = new Map((uploaders || []).map(p => [p.user_id, safeProfile(p)]));

    const withUrls = await Promise.all(files.map(async f => {
        const { data: signed } = await supabase.storage.from(TEAM_FILES_BUCKET).createSignedUrl(f.path, 3600);
        return {
            id: f.id, name: f.name, size: f.size, content_type: f.content_type, created_at: f.created_at,
            uploaded_by: uploaderMap.get(f.uploaded_by) || null,
            can_delete: membership.isOwner || f.uploaded_by === user.id,
            url: signed ? signed.signedUrl : null
        };
    }));
    res.json({ success: true, files: withUrls });
}));

app.post("/api/projects/:id/files", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const { fileDataUrl, name } = req.body || {};
    if (!fileDataUrl || typeof fileDataUrl !== "string") return res.status(400).json({ success: false, message: "No file was provided." });
    const fileName = String(name || "").trim().slice(0, 200);
    if (!fileName) return res.status(400).json({ success: false, message: "A file name is required." });

    const match = fileDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ success: false, message: "That file could not be read." });
    const [, contentType, base64Data] = match;
    if (!TEAM_FILE_TYPES.has(contentType)) return res.status(400).json({ success: false, message: "That file type isn't supported." });
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ success: false, message: "File must be smaller than 3MB." });

    const path = `${req.params.id}/${crypto.randomUUID()}-${fileName}`;
    const { error: uploadError } = await supabase.storage.from(TEAM_FILES_BUCKET).upload(path, buffer, { contentType, upsert: false });
    if (uploadError) return res.status(500).json({ success: false, message: `Could not upload file: ${uploadError.message}` });

    const { data: file, error } = await supabase.from("project_files")
        .insert({ project_id: req.params.id, uploaded_by: user.id, name: fileName, path, size: buffer.length, content_type: contentType })
        .select().single();
    if (error) { await supabase.storage.from(TEAM_FILES_BUCKET).remove([path]); return res.status(400).json({ success: false, message: safeMessage(error) }); }

    await logActivity(req.params.id, user.id, "file_uploaded", `${await actorName(user.id)} uploaded ${fileName}.`);
    res.status(201).json({ success: true, message: "File uploaded.", file: { id: file.id, name: file.name, size: file.size, content_type: file.content_type, created_at: file.created_at } });
}));

app.delete("/api/projects/:id/files/:fileId", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const { data: file, error: fileError } = await supabase.from("project_files").select("id, uploaded_by, path").eq("id", req.params.fileId).eq("project_id", req.params.id).maybeSingle();
    if (fileError || !file) return res.status(404).json({ success: false, message: "File not found." });
    if (!membership.isOwner && file.uploaded_by !== user.id) return res.status(403).json({ success: false, message: "Only the uploader or team owner can delete this file." });

    await supabase.storage.from(TEAM_FILES_BUCKET).remove([file.path]);
    const { error } = await supabase.from("project_files").delete().eq("id", file.id);
    if (error) return res.status(400).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, message: "File deleted." });
}));

// ---- Activity ----
app.get("/api/projects/:id/activity", requireAuth(async (req, res, user) => {
    const membership = await teamMembership(req.params.id, user.id);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });
    if (!membership.isMember) return res.status(403).json({ success: false, message: "You're not a member of this team." });

    const { data: activity, error } = await supabase.from("project_activity")
        .select("id, actor_user_id, type, message, created_at")
        .eq("project_id", req.params.id).order("created_at", { ascending: false }).limit(50);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });

    const actorIds = [...new Set(activity.map(a => a.actor_user_id).filter(Boolean))];
    const { data: actors } = actorIds.length ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", actorIds) : { data: [] };
    const actorMap = new Map((actors || []).map(p => [p.user_id, safeProfile(p)]));

    res.json({ success: true, activity: activity.map(a => ({ id: a.id, type: a.type, message: a.message, created_at: a.created_at, actor: a.actor_user_id ? actorMap.get(a.actor_user_id) || null : null })) });
}));

app.post("/api/projects", requireAuth(async (req, res, user) => {
    const payload = projectPayload(req.body);
    if (!payload.title) return res.status(400).json({ success: false, message: "A project title is required." });
    payload.status = payload.status || "Open";
    const { data, error } = await supabase.from("projects").insert({ ...payload, user_id: user.id }).select().single();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    return res.json({ success: true, message: "Project posted!", project: data });
}));

app.put("/api/projects/:id", requireAuth(async (req, res, user) => {
    const payload = projectPayload(req.body);
    if ("title" in payload && !payload.title) return res.status(400).json({ success: false, message: "A project title is required." });
    const { data, error } = await supabase.from("projects").update(payload).eq("id", req.params.id).eq("user_id", user.id).select().maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Project not found, or you don't have permission to edit it." });
    return res.json({ success: true, message: "Project updated.", project: data });
}));

app.delete("/api/projects/:id", requireAuth(async (req, res, user) => {
    const { data, error } = await supabase.from("projects").delete().eq("id", req.params.id).eq("user_id", user.id).select().maybeSingle();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!data) return res.status(404).json({ success: false, message: "Project not found, or you don't have permission to delete it." });
    return res.json({ success: true, message: "Project deleted." });
}));

// =================================================================
// Messaging — direct messages between connections. One conversation
// per pair (dm_key = both user ids, sorted, so "find or start" is a
// single unique-constrained insert). No group chat, no message
// requests from strangers: only people who are already connected can
// start a conversation, reusing the same connections graph as the
// rest of the app.
// =================================================================
async function assertParticipant(conversationId, userId) {
    const { data } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
    return Boolean(data);
}

app.get("/api/conversations", requireAuth(async (req, res, user) => {
    const { data: myRows, error } = await supabase.from("conversation_participants").select("conversation_id, last_read_at").eq("user_id", user.id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    if (!myRows.length) return res.json({ success: true, conversations: [] });
    const convIds = myRows.map(row => row.conversation_id);
    const readMap = new Map(myRows.map(row => [row.conversation_id, row.last_read_at]));

    const [{ data: conversations, error: convError }, { data: participants, error: partError }] = await Promise.all([
        supabase.from("conversations").select("id, last_message_at").in("id", convIds).order("last_message_at", { ascending: false }),
        supabase.from("conversation_participants").select("conversation_id, user_id").in("conversation_id", convIds)
    ]);
    if (convError || partError) return res.status(500).json({ success: false, message: safeMessage(convError || partError) });

    const otherIdByConv = new Map();
    participants.forEach(row => { if (row.user_id !== user.id) otherIdByConv.set(row.conversation_id, row.user_id); });
    const otherIds = [...new Set(otherIdByConv.values())];
    const { data: profiles, error: profileError } = otherIds.length
        ? await supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).in("user_id", otherIds)
        : { data: [], error: null };
    if (profileError) return res.status(500).json({ success: false, message: safeMessage(profileError) });
    const profileMap = new Map(profiles.map(profile => [profile.user_id, profile]));

    // Last message + unread count per conversation. A personal inbox is small
    // (tens, not thousands, of threads), so one pair of queries per
    // conversation stays simple and correct rather than fighting PostgREST
    // for a "latest row per group" aggregate.
    const previews = await Promise.all(convIds.map(async id => {
        const { data: last } = await supabase.from("messages").select("body, sender_user_id, created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const readAt = readMap.get(id);
        const { count: unread } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", id).neq("sender_user_id", user.id).gt("created_at", readAt || "1970-01-01T00:00:00Z");
        return [id, { last, unread: unread || 0 }];
    }));
    const previewMap = new Map(previews);

    const result = conversations.map(conv => {
        const otherId = otherIdByConv.get(conv.id);
        const profile = otherId ? profileMap.get(otherId) : null;
        const preview = previewMap.get(conv.id) || { last: null, unread: 0 };
        return {
            id: conv.id,
            profile: profile ? safeProfile(profile) : null,
            last_message: preview.last ? preview.last.body : null,
            last_message_mine: preview.last ? preview.last.sender_user_id === user.id : false,
            last_message_at: conv.last_message_at,
            unread: preview.unread
        };
    }).filter(conv => conv.profile); // hides a thread if the other person deleted their account
    res.json({ success: true, conversations: result });
}));

app.post("/api/conversations", requireAuth(async (req, res, user) => {
    const publicId = String((req.body && req.body.publicId) || "").trim();
    if (!publicId) return res.status(400).json({ success: false, message: "Provide the public ID of the person to message." });
    const target = await profileByPublicId(publicId);
    if (!target) return res.status(404).json({ success: false, message: "No member found with that ID." });
    if (target.user_id === user.id) return res.status(400).json({ success: false, message: "You can't message yourself." });
    const myConnections = await connectionIds(user.id);
    if (!myConnections.has(target.user_id)) return res.status(403).json({ success: false, message: "You can only message people you're connected with." });

    const dmKey = [user.id, target.user_id].sort().join(":");
    let conversation = (await supabase.from("conversations").select("id").eq("dm_key", dmKey).maybeSingle()).data;
    if (!conversation) {
        const inserted = await supabase.from("conversations").insert({ dm_key: dmKey }).select("id").single();
        if (inserted.error) {
            if (inserted.error.code === "23505") conversation = (await supabase.from("conversations").select("id").eq("dm_key", dmKey).single()).data;
            else return res.status(500).json({ success: false, message: safeMessage(inserted.error) });
        } else {
            conversation = inserted.data;
            const { error: partError } = await supabase.from("conversation_participants").insert([
                { conversation_id: conversation.id, user_id: user.id },
                { conversation_id: conversation.id, user_id: target.user_id }
            ]);
            if (partError) return res.status(500).json({ success: false, message: safeMessage(partError) });
        }
    }
    res.json({ success: true, conversationId: conversation.id, profile: safeProfile(target) });
}));

app.get("/api/conversations/:id/messages", requireAuth(async (req, res, user) => {
    if (!(await assertParticipant(req.params.id, user.id))) return res.status(404).json({ success: false, message: "Conversation not found." });
    const { data, error } = await supabase.from("messages").select("id, sender_user_id, body, created_at").eq("conversation_id", req.params.id).order("created_at", { ascending: true }).limit(200);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true, messages: data.map(row => ({ id: row.id, body: row.body, created_at: row.created_at, mine: row.sender_user_id === user.id })) });
}));

app.post("/api/conversations/:id/messages", requireAuth(async (req, res, user) => {
    if (!(await assertParticipant(req.params.id, user.id))) return res.status(404).json({ success: false, message: "Conversation not found." });
    const body = String((req.body && req.body.text) || "").trim();
    if (!body) return res.status(400).json({ success: false, message: "Message can't be empty." });
    if (body.length > 4000) return res.status(400).json({ success: false, message: "Message is too long." });
    const { data: message, error } = await supabase.from("messages").insert({ conversation_id: req.params.id, sender_user_id: user.id, body }).select("id, body, created_at").single();
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    await supabase.from("conversations").update({ last_message_at: message.created_at }).eq("id", req.params.id);

    const { data: others } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", req.params.id).neq("user_id", user.id);
    const otherId = others && others[0] && others[0].user_id;
    if (otherId) {
        const settings = await getSettings(otherId);
        if (settings.notify_messages) {
            const { data: sender } = await supabase.from("profiles").select("name").eq("user_id", user.id).single();
            await supabase.from("notifications").insert({ recipient_user_id: otherId, actor_user_id: user.id, type: "message", message: `${sender ? sender.name : "Someone"} sent you a message.`, link: `messages.html?conversation=${req.params.id}` });
        }
    }
    res.json({ success: true, message: { id: message.id, body: message.body, created_at: message.created_at, mine: true } });
}));

app.put("/api/conversations/:id/read", requireAuth(async (req, res, user) => {
    if (!(await assertParticipant(req.params.id, user.id))) return res.status(404).json({ success: false, message: "Conversation not found." });
    const { error } = await supabase.from("conversation_participants").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", req.params.id).eq("user_id", user.id);
    if (error) return res.status(500).json({ success: false, message: safeMessage(error) });
    res.json({ success: true });
}));

// Anything under /api that doesn't match a route above -> JSON 404, not HTML.
app.use("/api", (req, res) => res.status(404).json({ success: false, message: "That endpoint does not exist." }));

// Catches malformed JSON bodies and any thrown/rejected error from the
// routes above so the frontend always gets JSON back, never an HTML
// crash page.
// On localhost only, the real cause is echoed back to the browser as `detail`
// so the failing page can show it. Never enabled for a deployed host, so
// schema details cannot leak in production.
function devDetail(req, err) {
    const host = String(req.hostname || "");
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal || process.env.NODE_ENV === "production") return undefined;
    return [err.code, err.message, err.details, err.hint].filter(Boolean).join(" | ");
}

app.use((err, req, res, next) => {
    // Full detail to the server log for debugging...
    console.error(`Request error [${req.method} ${req.originalUrl}]:`, err.code || "", err.message, err.details || "", err.hint || "");
    const detail = devDetail(req, err);
    if (res.headersSent) return next(err);
    if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
        return res.status(400).json({ success: false, message: "Malformed request.", code: "bad_request", detail });
    }
    if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code || "request_failed" });
    }
    // ...and a plain sentence to the browser. Raw Postgres text such as
    // "new row violates row-level security policy" is never user-facing.
    const text = String(err.message || "").toLowerCase();
    if (text.includes("row-level security") || text.includes("permission denied") || err.code === "42501") {
        console.error("  ^ This is a database permission error. Run `npm run doctor` to check the service-role key and RLS policies.");
        return res.status(500).json({ success: false, message: "The server is not allowed to complete that action. Please contact the site owner.", code: "db_permission", detail });
    }
    if (err.code === "42703" || err.code === "42P01") {
        return res.status(500).json({ success: false, message: "The database is missing something this feature needs. Please contact the site owner.", code: "db_schema", detail });
    }
    res.status(500).json({ success: false, message: "Something went wrong on the server. Please try again.", code: "server_error", detail });
});

// Confirms the configured key really has service-role privileges by calling an
// endpoint only that role can use. The old check only decoded JWT-shaped keys,
// so a new-format publishable key (sb_publishable_...) slipped through and the
// server silently ran as `anon` — every write then failed with
// "new row violates row-level security policy".
async function verifyServiceRole() {
    const { error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (!error) return { ok: true };
    return { ok: false, message: error.message };
}

// =================================================================
// Startup database check
// =================================================================
// Every table and column the routes above rely on. If the SQL script has
// not been run, this says exactly what is missing at boot instead of
// leaving each page to fail with a generic 500 later.
const REQUIRED_SCHEMA = {
    profiles: "user_id, public_id, username, name, email, bio, role_title, photo, linkedin, github, portfolio, other_website, rating, last_seen_at, created_at",
    projects: "id, user_id, title, description, skills, category, status, roles_needed, availability, link, max_members, due_date, progress, created_at",
    education: "id, user_id, institution, degree_course, field_of_study, start_year, end_year, currently_studying",
    skills: "id, name",
    user_skills: "user_id, skill_id",
    project_members: "project_id, user_id, role, joined_at, left_at",
    user_settings: "user_id, profile_visibility, discoverability, connection_requests, show_email, show_profile_details, notify_team_invitations, notify_project_requests, appearance",
    follows: "id, follower_user_id, following_user_id",
    notifications: "id, recipient_user_id, actor_user_id, type, message, link, read_at, created_at, connection_request_id, project_request_id, project_invitation_id",
    connection_requests: "id, sender_user_id, receiver_user_id, status, created_at, updated_at",
    project_requests: "id, project_id, requester_user_id, message, status, created_at, updated_at",
    project_invitations: "id, project_id, inviter_user_id, invitee_user_id, role, message, status, created_at, updated_at",
    conversations: "id, dm_key, created_at, last_message_at",
    conversation_participants: "conversation_id, user_id, last_read_at",
    messages: "id, conversation_id, sender_user_id, body, created_at",
    saved_members: "user_id, saved_user_id, created_at",
    tasks: "id, project_id, title, description, phase, status, assignee_user_id, created_by, created_at, updated_at, completed_at",
    project_activity: "id, project_id, actor_user_id, type, message, created_at",
    project_files: "id, project_id, uploaded_by, name, path, size, content_type, created_at"
};

async function verifyDatabase() {
    const problems = [];
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
        const { error } = await supabase.from(table).select(columns).limit(1);
        if (error) problems.push({ table, code: error.code, message: error.message });
    }
    return problems;
}

async function reportDatabase() {
    const role = await verifyServiceRole().catch(error => ({ ok: false, message: error.message }));
    if (!role.ok) {
        console.error("\n--------------------------------------------------------------");
        console.error("SUPABASE_SERVICE_ROLE_KEY IS NOT A SERVICE-ROLE KEY.");
        console.error("The server is running with reduced privileges, so writes will");
        console.error('fail with "new row violates row-level security policy".');
        console.error("");
        console.error("Fix: Supabase -> Project Settings -> API -> copy the");
        console.error("service_role / secret key into backend/.env, then restart.");
        console.error(`Supabase said: ${role.message}`);
        console.error("--------------------------------------------------------------\n");
    }
    let problems;
    try {
        problems = await verifyDatabase();
    } catch (error) {
        console.error("\nCould not reach Supabase:", error.message);
        console.error("Check SUPABASE_URL and the keys in backend/.env, then restart.\n");
        return;
    }
    if (!problems.length) {
        if (role.ok) console.log("Database check: OK — schema complete and service-role key confirmed.");
        return;
    }
    console.error("\n--------------------------------------------------------------");
    console.error("DATABASE IS NOT READY. Open Supabase -> SQL Editor -> New query,");
    console.error("paste backend/database-setup.sql, run it, then restart this server.");
    console.error("--------------------------------------------------------------");
    problems.forEach(problem => console.error(`  - ${problem.table}: ${problem.message}`));
    console.error("--------------------------------------------------------------\n");
}

// process.env.VERCEL is set automatically by Vercel's build and function
// runtime (not something to configure by hand). Everywhere else — running
// directly with `node server.js` / `npm start`, or the test suite's plain
// require() of this file to get a live server on a test port — still binds
// a port exactly as before. Only on Vercel must this skip app.listen(): a
// serverless function must never try to bind one itself.
if (!process.env.VERCEL) {
    Promise.allSettled([ensureAvatarBucket(), ensureTeamFilesBucket(), reportDatabase()]).then(() => {
        app.listen(PORT, () => console.log(`ProjectFinder running at ${APP_URL} using Supabase.`));
    });
} else {
    // Serverless cold start: still run the startup checks (bucket creation,
    // schema verification) so problems show up in the platform's function
    // logs, just without ever binding a port.
    Promise.allSettled([ensureAvatarBucket(), ensureTeamFilesBucket(), reportDatabase()]);
}

module.exports = app;
