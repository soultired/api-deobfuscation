'use strict';
// Phần dùng chung cho 3 engine: ghi log thay cho console, và chạy decoder của file đầu vào trong vm.
const vm = require('node:vm');
const util = require('node:util');

const MAX_LOG_LINES = 400;
let sink = null;

function startRun() {
    sink = { lines: [], dropped: 0 };
}

function endRun() {
    const out = sink || { lines: [], dropped: 0 };
    sink = null;
    if (out.dropped) out.lines.push(`(còn ${out.dropped} dòng log nữa đã bị lược bớt)`);
    return out.lines;
}

function push(level, args) {
    if (!sink) return;
    const line = (level === 'error' ? '[lỗi] ' : level === 'warn' ? '[cảnh báo] ' : '') + util.format(...args);
    if (sink.lines.length >= MAX_LOG_LINES) { sink.dropped++; return; }
    sink.lines.push(line.length > 600 ? line.slice(0, 600) + '…' : line);
}

// Các engine khai báo `const console = require('./runtime').console` để log vào đây.
const console = {
    log: (...a) => push('info', a),
    info: (...a) => push('info', a),
    debug: () => {},
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a)
};

const atobImpl = s => Buffer.from(String(s), 'base64').toString('binary');

// Một số decoder jsjiami tự kiểm tra xem code có bị format (beautify) hay không, nếu bị thì chạy vô hạn.
// Ta chuẩn hoá toString() trong sandbox để bản đã format vẫn qua được kiểm tra.
const NORMALIZE_TOSTRING = `(function(){
  var o = Function.prototype.toString;
  Function.prototype.toString = function () {
    return o.call(this).replace(/\\s+/g, ' ').replace(/\\{ /g, '{').replace(/ \\}/g, '}').replace(/ ?\\( ?/g, '(');
  };
})();`;

function createSandbox() {
    const ctx = vm.createContext({ atob: atobImpl, console: { log() {}, warn() {}, error() {} } }, {
        codeGeneration: { strings: true, wasm: false }
    });
    vm.runInContext(NORMALIZE_TOSTRING, ctx, { timeout: 1000 });
    return ctx;
}

// Thay cho `new Function(setupCode + 'return name;')()`: chạy trong vm, có giới hạn thời gian.
function evalDecoder(setupCode, decoderName, timeoutMs = 8000) {
    const ctx = createSandbox();
    const fn = vm.runInContext(`(function(){\n${setupCode}\nreturn ${decoderName};\n})()`, ctx, { timeout: timeoutMs });
    if (typeof fn !== 'function') throw new Error(`Không lấy được hàm giải mã ${decoderName}`);
    return (...args) => fn(...args);
}

module.exports = { console, startRun, endRun, createSandbox, evalDecoder, vm };
