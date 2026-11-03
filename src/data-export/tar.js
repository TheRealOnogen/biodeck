// Minimal streaming tar.gz writer/reader.
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// minimal streaming tar.gz writer / reader (no dependencies)

function dxWaitDrain(stream) {
    return new Promise((resolve, reject) => {
        const onDrain = () => { stream.off('error', onErr); resolve(); };
        const onErr = (e) => { stream.off('drain', onDrain); reject(e); };
        stream.once('drain', onDrain);
        stream.once('error', onErr);
    });
}

function dxTarHeader(name, size, mtime, typeflag) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    h.fill(0x20, 148, 156);
    h.write(typeflag, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
}

// One PAX extended-header record: "<len> <key>=<value>\n", where <len> counts its own digits too.
function dxPaxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    const bodyLen = Buffer.byteLength(body);
    let digits = String(bodyLen).length;
    for (;;) {
        const total = bodyLen + digits;
        if (String(total).length === digits) return Buffer.from(String(total) + body);
        digits = String(total).length;
    }
}

class DxTarGzWriter {
    constructor(destPath) {
        this.destPath = destPath;
        this.gz = zlib.createGzip({ level: 6 });
        this.out = fs.createWriteStream(destPath, { mode: 0o600 });
        this.cur = null;
        this.gz.pipe(this.out);
        this.done = new Promise((resolve, reject) => {
            this.out.on('finish', resolve);
            this.out.on('error', reject);
            this.gz.on('error', reject);
        });
        this.done.catch(() => {}); // surfaced through _write()/finish()
    }

    async _write(buf) {
        if (!buf.length) return;
        if (!this.gz.write(buf)) await dxWaitDrain(this.gz);
    }

    // Starts an entry; call data() until `size` bytes were written, then end().
    async begin(name, size, mtime) {
        if (this.cur) throw new Error('previous tar entry still open');
        const m = mtime || Math.floor(Date.now() / 1000);
        if (Buffer.byteLength(name) > 100) {
            const rec = dxPaxRecord('path', name);
            await this._write(dxTarHeader('PaxHeader/' + path.posix.basename(name).slice(0, 80), rec.length, m, 'x'));
            await this._write(rec);
            await this._write(Buffer.alloc((512 - (rec.length % 512)) % 512));
        }
        await this._write(dxTarHeader(name.slice(0, 100), size, m, '0'));
        this.cur = { remaining: size, size };
    }

    async data(buf) {
        const c = this.cur;
        if (!c) throw new Error('no open tar entry');
        if (buf.length > c.remaining) buf = buf.subarray(0, c.remaining);
        c.remaining -= buf.length;
        await this._write(buf);
    }

    async end() {
        const c = this.cur;
        if (!c) return;
        this.cur = null;
        if (c.remaining > 0) await this._write(Buffer.alloc(c.remaining)); // source shrank - keep the archive valid
        await this._write(Buffer.alloc((512 - (c.size % 512)) % 512));
    }

    async addBuffer(name, buf, mtime) {
        await this.begin(name, buf.length, mtime);
        await this.data(buf);
        await this.end();
    }

    // Streams a file from disk.
    async addFile(name, absPath) {
        const fh = await fs.promises.open(absPath, 'r');
        try {
            const st = await fh.stat();
            if (!st.isFile()) throw new Error('not a regular file');
            await this.begin(name, st.size, Math.floor(st.mtimeMs / 1000));
            try {
                const stream = fh.createReadStream({ autoClose: false, start: 0, end: Math.max(0, st.size - 1) });
                if (st.size > 0) for await (const chunk of stream) await this.data(chunk);
            } catch (e) {
                await this.end(); // zero-pads what is missing so the archive stays readable
                throw e;
            }
            await this.end();
        } finally {
            await fh.close().catch(() => {});
        }
    }

    async finish() {
        if (this.cur) await this.end();
        await this._write(Buffer.alloc(1024));
        this.gz.end();
        await this.done;
    }

    async abort() {
        try { this.gz.destroy(); } catch (e) {}
        try { this.out.destroy(); } catch (e) {}
        await fs.promises.unlink(this.destPath).catch(() => {});
    }
}

function dxParseTarHeader(b) {
    const str = (s, e) => { let end = s; while (end < e && b[end] !== 0) end++; return b.toString('utf8', s, end); };
    let name = str(0, 100);
    if (str(257, 262) === 'ustar') {
        const prefix = str(345, 500);
        if (prefix) name = prefix + '/' + name;
    }
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const mtime = parseInt(str(136, 148).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    return { name, size, mtime: Number.isFinite(mtime) ? mtime : 0, type: String.fromCharCode(b[156] || 48) };
}

function dxParsePaxPath(buf) {
    let pos = 0;
    while (pos < buf.length) {
        const sp = buf.indexOf(0x20, pos);
        if (sp < 0) break;
        const len = parseInt(buf.toString('ascii', pos, sp), 10);
        if (!len || pos + len > buf.length) break;
        const rec = buf.toString('utf8', sp + 1, pos + len - 1);
        const eq = rec.indexOf('=');
        if (eq > 0 && rec.slice(0, eq) === 'path') return rec.slice(eq + 1);
        pos += len;
    }
    return null;
}

// Streams through a .tar.gz. onEntry({name,size,mtime,type}) may return null/undefined to skip the
// entry's data.
async function dxUntarGz(file, onEntry) {
    const rs = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    rs.on('error', e => gunzip.destroy(e));
    rs.pipe(gunzip);
    let pending = Buffer.alloc(0);
    let cur = null;
    let longName = null;
    let finished = false;
    try {
        for await (const chunk of gunzip) {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            while (!finished) {
                if (!cur) {
                    if (pending.length < 512) break;
                    const block = pending.subarray(0, 512);
                    pending = pending.subarray(512);
                    if (block.every(x => x === 0)) { finished = true; break; }
                    const h = dxParseTarHeader(block);
                    cur = { h, remaining: h.size, pad: (512 - (h.size % 512)) % 512, sink: null, collect: null };
                    if (h.type === 'x' || h.type === 'g' || h.type === 'L') {
                        cur.collect = [];
                    } else {
                        const name = longName || h.name;
                        longName = null;
                        cur.sink = (await onEntry({ name, size: h.size, mtime: h.mtime, type: h.type })) || null;
                    }
                }
                if (cur.remaining > 0) {
                    if (!pending.length) break;
                    const take = Math.min(cur.remaining, pending.length);
                    const part = pending.subarray(0, take);
                    pending = pending.subarray(take);
                    cur.remaining -= take;
                    if (cur.collect) cur.collect.push(part);
                    else if (cur.sink) await cur.sink.write(part);
                    if (cur.remaining > 0) break;
                }
                if (cur.pad > 0) {
                    const take = Math.min(cur.pad, pending.length);
                    pending = pending.subarray(take);
                    cur.pad -= take;
                    if (cur.pad > 0) break;
                }
                if (cur.collect) {
                    const buf = Buffer.concat(cur.collect);
                    if (cur.h.type === 'x') longName = dxParsePaxPath(buf) || longName;
                    else if (cur.h.type === 'L') longName = buf.toString('utf8').replace(/\0.*$/s, '');
                } else if (cur.sink) {
                    await cur.sink.end();
                }
                cur = null;
            }
            if (finished) break;
        }
        if (!finished && cur) throw new Error('unexpected end of archive');
    } finally {
        rs.destroy();
        gunzip.destroy();
    }
}

module.exports = { DxTarGzWriter, dxUntarGz };
