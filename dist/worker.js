'use strict';

const { parentPort, isMainThread } = require('worker_threads');
const fs = require('fs');
const { promisify } = require('util');

if (isMainThread) {
    console.error('worker.js must be run as a worker thread, not the main thread');
    process.exit(1);
}

const readFile = promisify(fs.readFile);
let isTerminating = false;

async function readBmp(filePath) {
    if (isTerminating) {
        throw new Error('Worker is terminating');
    }
    return await readFile(filePath);
}

parentPort.on('message', async (message) => {
    if (isTerminating) return;

    if (message.type === 'read') {
        try {
            const buffer = await readBmp(message.filePath);
            if (!isTerminating) {
                parentPort.postMessage({
                    success: true,
                    buffer: buffer,
                    filePath: message.filePath
                });
            }
        } catch (err) {
            if (!isTerminating) {
                parentPort.postMessage({
                    success: false,
                    error: err.message,
                    filePath: message.filePath
                });
            }
            console.error(`Worker failed task: ${message.filePath}`, err.message);
        }
    } else if (message.type === 'shutdown') {
        isTerminating = true;
        setTimeout(() => {
            process.exit(0);
        }, 100);
    }
});

process.on('uncaughtException', (err) => {
    console.error('Worker uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Worker unhandledRejection:', err);
});

process.on('SIGTERM', () => { isTerminating = true; process.exit(0); });
process.on('SIGINT', () => { isTerminating = true; process.exit(0); });