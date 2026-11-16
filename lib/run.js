'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function runInWorker(job, { timeoutMs = 55000, maxMemoryMb = 1200 } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: job,
            resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb }
        });
        let finished = false;
        const finish = (fn, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            worker.terminate();
            fn(value);
        };
        const timer = setTimeout(() => {
            finish(reject, Object.assign(new Error(`Quá thời gian xử lý (${Math.round(timeoutMs / 1000)} giây).`), { status: 504 }));
        }, timeoutMs);

        worker.once('message', message => {
            if (message.ok) finish(resolve, message.result);
            else finish(reject, Object.assign(new Error(message.error), { status: message.status }));
        });
        worker.once('error', error => {
            const oom = error && error.code === 'ERR_WORKER_OUT_OF_MEMORY';
            finish(reject, Object.assign(new Error(oom ? 'File quá lớn so với bộ nhớ của server.' : (error && error.message) || 'Lỗi không xác định'), { status: oom ? 413 : 500 }));
        });
        worker.once('exit', code => {
            finish(reject, Object.assign(new Error(`Worker dừng đột ngột (mã ${code}).`), { status: 500 }));
        });
    });
}

module.exports = { runInWorker };
