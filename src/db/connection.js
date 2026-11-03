// SQLite connection with a callback-style wrapper.
const Database = require('better-sqlite3');

// better-sqlite3 setup
// better-sqlite3 is synchronous (no callbacks, no query queue), which is faster and simpler than
// node-sqlite3.
let sqliteDb;
try {
    sqliteDb = new Database('./data.db');
} catch (err) {
    console.error('Database connection error :', err.message);
    process.exit(1);
}

// Caches prepared statements by SQL text so repeated queries.
const stmtCache = new Map();
function getStmt(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
        stmt = sqliteDb.prepare(sql);
        stmtCache.set(sql, stmt);
    }
    return stmt;
}

function normalizeArgs(params, callback) {
    if (typeof params === 'function') return { params: [], callback: params };
    if (params === undefined) return { params: [], callback };
    return { params: Array.isArray(params) ? params : [params], callback };
}

const db = {
    run(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let result = null, error = null;
        try {
            if (/^\s*PRAGMA/i.test(sql)) {
                sqliteDb.pragma(sql.replace(/^\s*PRAGMA\s+/i, ''));
                result = { changes: 0, lastInsertRowid: undefined };
            } else {
                result = getStmt(sql).run(...norm.params);
            }
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            const ctx = { lastID: result ? result.lastInsertRowid : undefined, changes: result ? result.changes : 0 };
            process.nextTick(() => norm.callback.call(ctx, error));
        } else if (error) {
            console.error('DB run error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    get(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let row, error = null;
        try {
            row = getStmt(sql).get(...norm.params);
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            process.nextTick(() => norm.callback(error, row));
        } else if (error) {
            console.error('DB get error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    all(sql, params, callback) {
        const norm = normalizeArgs(params, callback);
        let rows, error = null;
        try {
            rows = getStmt(sql).all(...norm.params);
        } catch (err) {
            error = err;
        }
        if (typeof norm.callback === 'function') {
            process.nextTick(() => norm.callback(error, rows || []));
        } else if (error) {
            console.error('DB all error (no callback):', error.message, '\nSQL:', sql);
        }
        return db;
    },

    // better-sqlite3 runs everything synchronously on a single connection.
    serialize(fn) {
        if (typeof fn === 'function') fn();
        return db;
    }
};

module.exports = { db, getStmt, sqliteDb, stmtCache };
