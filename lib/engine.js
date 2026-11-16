'use strict';
// Điều phối: chọn engine (v1 / v2 / v3), chạy, gom log.
const rt = require('./runtime');

const VERSIONS = ['auto', 'v1', 'v2', 'v3'];
const ENGINES = {
    v1: () => require('./jsjiami-v1'),
    v2: () => require('./jsjiami-v2'),
    v3: () => require('./jsjiami-v3')
};

class UserError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// Tự nhận diện (đoán theo dấu hiệu, không phải đảm bảo):
//  - có chuỗi phiên bản "jsjiami.com.v6"  -> v1 (mảng chuỗi + vòng xoay + RC4 kiểu v6)
//  - còn lại                               -> v3 (bản mới nhất, gỡ cả control flow flattening và bẫy chống format)
// v2 (tách module webpack, nối import giữa các chunk) phải chọn tay, vì nó đổi cả cấu trúc file.
function detectVersion(code) {
    return /jsjiami\.com\.v6/.test(code) ? 'v1' : 'v3';
}

// Chuyển các tình huống "chạy xong nhưng chẳng gỡ được gì" thành ghi chú tiếng Việt để trang hiển thị.
// Các engine gốc chỉ in log (một số bằng tiếng Trung / tiếng Anh) rồi trả code gần như nguyên vẹn.
function buildNotes(version, log, inCode, outCode) {
    const notes = [];
    const has = text => log.some(line => line.includes(text));
    const add = text => { if (!notes.includes(text)) notes.push(text); };

    if (has('共享大字典代码求值失败') || has('Error evaluating dictionary code')) {
        add('Không chạy được hàm giải mã chuỗi lấy từ file, nên các chuỗi chưa được giải.');
    }
    if (has('未检测到共享大字典解码器') && !has('共享大字典已解包')) {
        add('v3 không tìm thấy bộ giải mã chuỗi dùng chung trong file. File này có thể không phải kiểu mà v3 xử lý, hãy thử v1 hoặc v2.');
    }
    if (has('Could not find a shared string-array decoder')) {
        add('v2 không tìm thấy bộ giải mã chuỗi dùng chung trong file. Hãy thử v1 hoặc v3.');
    }
    if (version === 'v2' && has('No obfuscation markers detected')) {
        add('Không thấy dấu hiệu obfuscate (tên dạng _0x...) trong file, v2 chỉ xử lý phần cấu trúc webpack.');
    }
    for (const line of log) {
        const match = /^\[(?:cảnh báo|lỗi)\] (.+)/.exec(line);
        // v1 đã ghi sẵn bằng tiếng Việt; log của v2/v3 (Trung/Anh) đã được xử lý ở trên
        if (match && /^[^\u4e00-\u9fff]*$/.test(match[1]) && match[1].startsWith('Không')) add(match[1]);
        const failed = /^\[lỗi\] Failed to (prepare|process) (.+?):/.exec(line);
        if (failed) add(`v2 xử lý file "${failed[2]}" thất bại.`);
    }
    if (outCode !== undefined && inCode !== undefined && outCode.replace(/\s+/g, '') === inCode.replace(/\s+/g, '')) {
        add('Kết quả giống hệt code vào, tức là không gỡ được gì. Có thể file không obfuscate bằng jsjiami, hoặc cần chọn phiên bản khác.');
    }
    return notes;
}

function run(job) {
    const method = job.method || 'jsjiami';
    if (method !== 'jsjiami') {
        throw new UserError(`Chưa hỗ trợ phương pháp "${method}". Hiện chỉ có "jsjiami".`);
    }

    let version = job.version || 'auto';
    if (!VERSIONS.includes(version)) {
        throw new UserError(`version phải là một trong: ${VERSIONS.join(', ')}.`);
    }

    const startedAt = Date.now();
    rt.startRun();
    let log = null;
    try {
        if (Array.isArray(job.files)) {
            if (version === 'auto') version = 'v2';
            if (version !== 'v2') {
                throw new UserError('Gửi nhiều file cùng lúc chỉ dùng được với v2 (nối import giữa các chunk webpack).');
            }
            const files = ENGINES.v2().deobfuscateFiles(job.files);
            log = rt.endRun();
            return {
                version,
                files,
                log,
                notes: buildNotes(version, log),
                stats: {
                    inChars: job.files.reduce((sum, f) => sum + String(f.code).length, 0),
                    outChars: files.reduce((sum, f) => sum + (f.code ? f.code.length : 0), 0),
                    ms: Date.now() - startedAt
                }
            };
        }

        const code = String(job.code);
        if (version === 'auto') version = detectVersion(code);
        const out = ENGINES[version]().deobfuscate(code);
        log = rt.endRun();
        return {
            version,
            code: out,
            log,
            notes: buildNotes(version, log, code, out),
            stats: { inChars: code.length, outChars: out.length, ms: Date.now() - startedAt }
        };
    } catch (error) {
        if (log === null) rt.endRun();
        if (error instanceof UserError) throw error;
        if (error && error.code === 'BABEL_PARSER_SYNTAX_ERROR') {
            const where = error.loc ? ` (dòng ${error.loc.line}, cột ${error.loc.column})` : '';
            throw new UserError(`Code JavaScript không hợp lệ${where}: ${String(error.message).replace(/\s*\(\d+:\d+\)\s*$/, '')}`, 422);
        }
        throw error;
    }
}

module.exports = { run, detectVersion, UserError, VERSIONS };
