const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AdminSessionStore {
    constructor(file) {
        this.file = file;
        this.sessions = new Map();
        try {
            this.sessions = new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    key(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
    get(token) { return this.sessions.get(this.key(token)); }

    save(sessions) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify([...sessions]), { mode: 0o600 });
        fs.renameSync(temp, this.file);
        this.sessions = sessions;
    }

    set(token, session) {
        const sessions = new Map(this.sessions);
        sessions.set(this.key(token), session);
        this.save(sessions);
    }

    delete(token) {
        const sessions = new Map(this.sessions);
        sessions.delete(this.key(token));
        this.save(sessions);
    }

    revokeUser(username) {
        this.save(new Map([...this.sessions].filter(([, session]) => session.username !== username)));
    }
}

module.exports = { AdminSessionStore };
