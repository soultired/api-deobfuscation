'use strict';
// Chạy trong worker thread để có thể bị dừng cứng nếu code đầu vào làm decoder chạy vô hạn hoặc ngốn bộ nhớ.
const { parentPort, workerData } = require('node:worker_threads');
const { run } = require('./engine');

try {
    parentPort.postMessage({ ok: true, result: run(workerData) });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        status: error && error.status ? error.status : 500,
        error: error && error.message ? error.message : String(error)
    });
}
