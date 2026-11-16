'use strict';
// POST /api/deobfuscate
//   { "code": "...", "method": "jsjiami", "version": "auto" | "v1" | "v2" | "v3" }
//   { "files": [{ "name": "app.js", "code": "..." }, ...], "version": "v2" }   // nhiều file, nối import giữa các chunk
// -> { ok, version, code | files, log: [...], stats: { inChars, outChars, ms } }
const { runInWorker } = require('../lib/run');

const MAX_BYTES = 4 * 1024 * 1024;          // Vercel chặn body ở 4,5 MB
const MAX_FILES = 40;
const TIMEOUT_MS = Number(process.env.DEOBF_TIMEOUT_MS) || 55000;
const MAX_MEMORY_MB = Number(process.env.DEOBF_MAX_MB) || 1200;

function send(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function cors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    if (req.headers['access-control-request-private-network']) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');   // trang https gọi tới API chạy ở 127.0.0.1
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

async function readJson(req) {
    if (req.body !== undefined && req.body !== null) {            // Vercel đã parse sẵn
        if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
        if (typeof req.body === 'string') return JSON.parse(req.body);
        return req.body;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw Object.assign(new Error('Dữ liệu gửi lên quá lớn (tối đa 4 MB).'), { status: 413 });
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body phải là một object JSON.';
    if (body.files !== undefined) {
        if (!Array.isArray(body.files) || body.files.length === 0) return '"files" phải là mảng có ít nhất 1 file.';
        if (body.files.length > MAX_FILES) return `Tối đa ${MAX_FILES} file mỗi lần.`;
        let total = 0;
        for (const file of body.files) {
            if (!file || typeof file.code !== 'string' || (file.name !== undefined && typeof file.name !== 'string')) {
                return 'Mỗi file cần có "code" (chuỗi) và "name" (chuỗi, không bắt buộc).';
            }
            total += Buffer.byteLength(file.code);
        }
        if (total > MAX_BYTES) return 'Tổng dung lượng file quá lớn (tối đa 4 MB).';
        return null;
    }
    if (typeof body.code !== 'string' || !body.code.trim()) return 'Thiếu "code" (chuỗi JavaScript cần gỡ).';
    if (Buffer.byteLength(body.code) > MAX_BYTES) return 'Code quá lớn (tối đa 4 MB).';
    return null;
}

module.exports = async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method === 'GET') {
        return send(res, 200, { ok: true, service: 'jsjiami-deobf', methods: ['jsjiami'], versions: ['auto', 'v1', 'v2', 'v3'], maxBytes: MAX_BYTES });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Chỉ nhận POST.' });

    let body;
    try {
        body = await readJson(req);
    } catch (error) {
        const status = error && error.status ? error.status : 400;
        return send(res, status, { ok: false, error: status === 413 ? error.message : 'Body không phải JSON hợp lệ.' });
    }

    const problem = validate(body);
    if (problem) return send(res, 400, { ok: false, error: problem });

    try {
        const result = await runInWorker(
            { code: body.code, files: body.files, method: body.method, version: body.version },
            { timeoutMs: TIMEOUT_MS, maxMemoryMb: MAX_MEMORY_MB }
        );
        return send(res, 200, { ok: true, ...result });
    } catch (error) {
        const status = error && error.status ? error.status : 500;
        return send(res, status, { ok: false, error: error && error.message ? error.message : 'Lỗi không xác định.' });
    }
};
