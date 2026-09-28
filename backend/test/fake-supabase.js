// ============================================================
// A small in-memory stand-in for @supabase/supabase-js.
//
// It implements the slice of PostgREST that server.js actually uses
// (filters, embedded selects, upsert, counts, unique violations) so the
// whole request/invitation/connection flow can be run and asserted
// without touching a real database. Used only by test/flows.test.js.
// ============================================================
const crypto = require("crypto");

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// Embedded-select relationships: fromTable.column -> targetTable.column
const RELATIONS = {
    "project_requests.projects": ["project_id", "projects", "id"],
    "project_invitations.projects": ["project_id", "projects", "id"],
    "project_members.projects": ["project_id", "projects", "id"],
    "projects.profiles": ["user_id", "profiles", "user_id"],
    "user_skills.skills": ["skill_id", "skills", "id"]
};

// Column sets that must stay unique, so the fake can raise 23505 the way
// Postgres does. Mirrors database-setup.sql.
const UNIQUE_KEYS = {
    profiles: [["public_id"], ["username"], ["email"]],
    follows: [["follower_user_id", "following_user_id"]],
    user_skills: [["user_id", "skill_id"]],
    skills: [["name"]],
    project_members: [["project_id", "user_id"]],
    project_requests: [["project_id", "requester_user_id"]],
    project_invitations: [["project_id", "invitee_user_id"]],
    user_settings: [["user_id"]]
};

const DEFAULTS = {
    projects: () => ({ id: uuid(), description: "", skills: "", category: "", status: "Open", roles_needed: "", availability: "", link: "", max_members: 5, created_at: now() }),
    profiles: () => ({ bio: "", education: "", role_title: "", skills: "", linkedin: "", github: "", portfolio: "", other_website: "", photo: "", rating: null, created_at: now() }),
    project_requests: () => ({ id: uuid(), status: "pending", message: "", created_at: now(), updated_at: now() }),
    project_invitations: () => ({ id: uuid(), status: "pending", role: "Member", message: "", created_at: now(), updated_at: now() }),
    project_members: () => ({ role: "Member", joined_at: now(), left_at: null }),
    connection_requests: () => ({ id: uuid(), status: "pending", created_at: now(), updated_at: now() }),
    follows: () => ({ id: uuid(), created_at: now() }),
    notifications: () => ({ id: uuid(), link: "", read_at: null, created_at: now(), actor_user_id: null }),
    skills: () => ({ id: uuid(), created_at: now() }),
    user_skills: () => ({ created_at: now() }),
    education: () => ({ id: uuid(), degree_course: "", field_of_study: "", currently_studying: false, created_at: now(), updated_at: now() }),
    user_settings: () => ({ updated_at: now() })
};

const error = (message, code) => ({ message, code });

// Splits "a.eq.1,and(b.eq.2,c.eq.3)" on top-level commas only.
function splitTopLevel(text) {
    const parts = [];
    let depth = 0, current = "";
    for (const character of text) {
        if (character === "(") depth++;
        if (character === ")") depth--;
        if (character === "," && depth === 0) { parts.push(current); current = ""; continue; }
        current += character;
    }
    if (current) parts.push(current);
    return parts;
}

function valueAt(row, column) {
    if (!column.includes(".")) return row[column];
    const [embedded, field] = column.split(".");
    const target = row[embedded];
    if (Array.isArray(target)) return target.length ? target[0][field] : undefined;
    return target ? target[field] : undefined;
}

function matchesCondition(row, condition) {
    condition = condition.trim();
    if (condition.startsWith("and(")) {
        return splitTopLevel(condition.slice(4, -1)).every(part => matchesCondition(row, part));
    }
    if (condition.startsWith("or(")) {
        return splitTopLevel(condition.slice(3, -1)).some(part => matchesCondition(row, part));
    }
    const first = condition.indexOf(".");
    const second = condition.indexOf(".", first + 1);
    const column = condition.slice(0, first);
    const operator = condition.slice(first + 1, second);
    const raw = condition.slice(second + 1);
    const value = valueAt(row, column);
    if (operator === "eq") return String(value) === raw;
    if (operator === "neq") return String(value) !== raw;
    if (operator === "ilike") {
        const pattern = new RegExp("^" + raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
        return value != null && pattern.test(String(value));
    }
    if (operator === "gte") return Number(value) >= Number(raw);
    if (operator === "is") return raw === "null" ? value == null : value === (raw === "true");
    throw new Error(`fake-supabase: unsupported operator "${operator}"`);
}

class Query {
    constructor(store, table) {
        this.store = store;
        this.table = table;
        this.filters = [];
        this.orders = [];
        this.action = "select";
        this.columns = "*";
        this.countMode = null;
        this.head = false;
        this.limitValue = null;
        this.rangeValue = null;
        this.singleMode = null;
        this.returning = false;
    }
    select(columns = "*", options = {}) {
        if (this.action === "select") this.columns = columns;
        else this.returning = true, this.columns = columns;
        if (options.count) this.countMode = options.count;
        if (options.head) this.head = true;
        return this;
    }
    insert(payload) { this.action = "insert"; this.payload = payload; return this; }
    upsert(payload, options = {}) { this.action = "upsert"; this.payload = payload; this.onConflict = (options.onConflict || "").split(",").map(s => s.trim()).filter(Boolean); return this; }
    update(payload) { this.action = "update"; this.payload = payload; return this; }
    delete() { this.action = "delete"; return this; }
    eq(column, value) { this.filters.push(row => String(valueAt(row, column)) === String(value)); return this; }
    neq(column, value) { this.filters.push(row => String(valueAt(row, column)) !== String(value)); return this; }
    in(column, values) { const set = new Set(values.map(String)); this.filters.push(row => set.has(String(valueAt(row, column)))); return this; }
    is(column, value) { this.filters.push(row => value === null ? valueAt(row, column) == null : valueAt(row, column) === value); return this; }
    ilike(column, pattern) { this.filters.push(row => matchesCondition(row, `${column}.ilike.${pattern}`)); return this; }
    gte(column, value) { this.filters.push(row => Number(valueAt(row, column)) >= Number(value)); return this; }
    or(expression) { const parts = splitTopLevel(expression); this.filters.push(row => parts.some(part => matchesCondition(row, part))); return this; }
    order(column, options = {}) { this.orders.push([column, options.ascending !== false]); return this; }
    limit(value) { this.limitValue = value; return this; }
    range(from, to) { this.rangeValue = [from, to]; return this; }
    single() { this.singleMode = "one"; return this; }
    maybeSingle() { this.singleMode = "maybe"; return this; }

    rows() { return this.store[this.table] || (this.store[this.table] = []); }

    // Attaches embedded rows described by a select string like
    // "id, projects!inner(title, user_id)".
    embed(row) {
        const result = { ...row };
        const matches = [...String(this.columns).matchAll(/(\w+)(!inner)?\(([^)]*)\)/g)];
        for (const [, name, inner, fields] of matches) {
            const relation = RELATIONS[`${this.table}.${name}`];
            if (!relation) continue;
            const [localColumn, targetTable, targetColumn] = relation;
            const target = (this.store[targetTable] || []).find(candidate => String(candidate[targetColumn]) === String(row[localColumn]));
            if (!target) { result[name] = null; if (inner) result.__innerMissing = true; continue; }
            const wanted = fields.split(",").map(field => field.trim()).filter(Boolean);
            result[name] = wanted.length && wanted[0] !== "*"
                ? Object.fromEntries(wanted.map(field => [field, target[field]]))
                : { ...target };
        }
        return result;
    }

    uniqueViolation(candidate, ignore) {
        for (const key of UNIQUE_KEYS[this.table] || []) {
            if (key.some(column => candidate[column] === undefined)) continue;
            const clash = this.rows().some(row => row !== ignore && key.every(column => String(row[column]) === String(candidate[column])));
            if (clash) return true;
        }
        return false;
    }

    run() {
        const table = this.rows();
        const defaults = DEFAULTS[this.table] ? DEFAULTS[this.table]() : {};

        if (this.action === "insert" || this.action === "upsert") {
            const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
            const written = [];
            for (const item of incoming) {
                let existing = null;
                if (this.action === "upsert") {
                    const keys = this.onConflict.length ? this.onConflict : (UNIQUE_KEYS[this.table] || [[]])[0];
                    existing = table.find(row => keys.length && keys.every(column => String(row[column]) === String(item[column])));
                }
                if (existing) { Object.assign(existing, item); written.push(existing); continue; }
                const candidate = { ...defaults, ...item };
                if (this.uniqueViolation(candidate)) return { data: null, error: error("duplicate key value violates unique constraint", "23505") };
                table.push(candidate);
                written.push(candidate);
            }
            return this.finish(written);
        }

        let selected = table.filter(row => this.filters.every(test => test(this.embed(row))));

        if (this.action === "update") {
            for (const row of selected) {
                const candidate = { ...row, ...this.payload };
                if (this.uniqueViolation(candidate, row)) return { data: null, error: error("duplicate key value violates unique constraint", "23505") };
                Object.assign(row, this.payload);
            }
            return this.finish(selected);
        }
        if (this.action === "delete") {
            selected.forEach(row => table.splice(table.indexOf(row), 1));
            return this.finish(selected);
        }

        let result = selected.map(row => this.embed(row)).filter(row => !row.__innerMissing);
        for (const [column, ascending] of [...this.orders].reverse()) {
            result.sort((a, b) => {
                const left = a[column], right = b[column];
                if (left === right) return 0;
                if (left == null) return 1;
                if (right == null) return -1;
                return (left < right ? -1 : 1) * (ascending ? 1 : -1);
            });
        }
        if (this.countMode) {
            const count = result.length;
            if (this.head) return { data: null, count, error: null };
            return { data: result, count, error: null };
        }
        if (this.rangeValue) result = result.slice(this.rangeValue[0], this.rangeValue[1] + 1);
        if (this.limitValue != null) result = result.slice(0, this.limitValue);
        return this.finish(result, true);
    }

    finish(rows, alreadyProjected = false) {
        let data = rows.map(row => (alreadyProjected ? row : this.embed(row)));
        data = data.map(row => this.project(row));
        if (this.singleMode === "maybe") {
            if (data.length > 1) return { data: null, error: error("multiple rows returned", "PGRST116") };
            return { data: data[0] || null, error: null };
        }
        if (this.singleMode === "one") {
            if (data.length !== 1) return { data: null, error: error("no rows returned", "PGRST116") };
            return { data: data[0], error: null };
        }
        return { data, error: null };
    }

    project(row) {
        const columns = String(this.columns);
        if (columns === "*" || (this.action !== "select" && !this.returning)) return { ...row };
        const plain = columns.replace(/(\w+)(!inner)?\([^)]*\)/g, "").split(",").map(part => part.trim()).filter(Boolean);
        if (!plain.length) return { ...row };
        // "*, projects(...)" means every base column PLUS the embedded rows.
        const output = plain.includes("*") ? { ...row } : {};
        for (const column of plain) if (column !== "*") output[column] = row[column];
        for (const [, name] of [...columns.matchAll(/(\w+)(?:!inner)?\([^)]*\)/g)]) output[name] = row[name];
        return output;
    }

    then(resolve, reject) {
        try { resolve(this.run()); } catch (failure) { reject(failure); }
    }
}

function createFakeClient(store, authState) {
    return {
        from(table) { return new Query(store, table); },
        auth: {
            async getUser(token) {
                const user = authState.sessions.get(token);
                return user ? { data: { user }, error: null } : { data: { user: null }, error: error("invalid token") };
            },
            async signUp({ email, password, options }) {
                if (authState.users.some(user => user.email === email)) return { data: { user: null }, error: null };
                const user = { id: uuid(), email, password, user_metadata: (options && options.data) || {} };
                authState.users.push(user);
                return { data: { user, session: null }, error: null };
            },
            async signInWithPassword({ email, password }) {
                const user = authState.users.find(candidate => candidate.email === email && candidate.password === password);
                if (!user) return { data: {}, error: error("Invalid login credentials") };
                const session = { access_token: `access-${uuid()}`, refresh_token: `refresh-${uuid()}` };
                authState.sessions.set(session.access_token, user);
                authState.refresh.set(session.refresh_token, user);
                return { data: { user, session }, error: null };
            },
            async refreshSession({ refresh_token }) {
                const user = authState.refresh.get(refresh_token);
                if (!user) return { data: {}, error: error("invalid refresh token") };
                const session = { access_token: `access-${uuid()}`, refresh_token };
                authState.sessions.set(session.access_token, user);
                return { data: { user, session }, error: null };
            },
            async setSession() { return { error: null }; },
            async updateUser() { return { error: null }; },
            async resend() { return { error: null }; },
            async resetPasswordForEmail() { return { error: null }; },
            admin: {
                async deleteUser(id) {
                    const index = authState.users.findIndex(user => user.id === id);
                    if (index >= 0) authState.users.splice(index, 1);
                    return { error: null };
                }
            }
        },
        storage: {
            async listBuckets() { return { data: [{ name: "avatars" }], error: null }; },
            async createBucket() { return { error: null }; },
            from() {
                return {
                    async upload() { return { error: null }; },
                    async remove() { return { error: null }; },
                    getPublicUrl(path) { return { data: { publicUrl: `https://example.test/${path}` } }; }
                };
            }
        }
    };
}

module.exports = { createFakeClient, uuid };
