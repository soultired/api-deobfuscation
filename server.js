'use strict';
// Chạy API ngay trên máy bạn:  npm start   ->  http://127.0.0.1:3000/api/deobfuscate
const http = require('node:http');
const handler = require('./api/deobfuscate');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

http.createServer((req, res) => {
    if ((req.url || '').split('?')[0] === '/api/deobfuscate') return handler(req, res);
    res.statusCode = 404;
    res.end('Not found');
}).listen(port, host, () => {
    console.log(`jsjiami-deobf-api đang chạy: http://${host}:${port}/api/deobfuscate`);
});
