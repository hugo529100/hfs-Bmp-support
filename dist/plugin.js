'use strict';

exports.description = "BMP cached server-side support for HFS - converts BMP to JPG on the fly for preview with Show and generates thumbnails"
exports.version = 1.3
exports.apiRequired = 12.6
exports.repo = "Hug3O/BMP-Support"
exports.preview = []

exports.config = {
    jpegQuality: {
        title: 'JPEG Quality',
        type: 'number',
        defaultValue: 95,
        min: 10,
        max: 100,
        step: 5,
        helperText: 'Quality of the converted JPEG images (10-100). Requires plugin restart to apply changes.',
        frontend: true
    },
    cacheAround: {
        title: 'Preconvert Files (Around)',
        type: 'number',
        defaultValue: 16,
        min: 0,
        max: 100,
        helperText: 'Number of BMP files to preconvert before and after the current one (0 to disable)',
        frontend: true
    },
    cacheTTL: {
        title: 'Cache Time To Live (hours)',
        type: 'number',
        defaultValue: 24,
        min: 1,
        max: 720,
        helperText: 'Time in hours after which cache files will be automatically deleted (cleaning interval: one hour)',
        frontend: true
    },
    backgroundWorkersCount: {
        title: 'Background Workers Count',
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 8,
        helperText: 'Number of background workers for parallel preconversion (1-8). Workers only read files; BMP decoding is done on the main thread.',
        frontend: true
    },
    generateThumbnails: {
        title: 'Generate Thumbnails',
        type: 'boolean',
        defaultValue: true,
        helperText: 'Generate 800px thumbnails via Sharp.',
        frontend: true
    }
};

let path, fs, util, crypto, Worker;
let cache = new Map();
let workerPool = [];
let inProgress = new Set();
let pendingBackgroundTasks = new Set();
let cleanupInterval;
let isUnloading = false;
let cacheDir;
let thumbCacheDir;

let jpegQuality = 0.95;
let cacheAround = 16;
let cacheTTL = 24 * 60 * 60 * 1000;
let backgroundWorkersCount = 1;
let generateThumbnails = true;

let isInitializing = true;

/* =========================================================
 *  内置纯 JS BMP 解码器（零依赖）
 *  输出：{ data: Uint8Array (RGBA), width, height }
 *  支持：1/4/8/16/24/32 位，BI_RGB / BI_RLE8 / BI_RLE4 / BI_BITFIELDS
 * ========================================================= */
function decodeBmpToRgba(buf) {
    if (!buf || buf.length < 26) throw new Error('BMP: file too small');
    if (buf[0] !== 0x42 || buf[1] !== 0x4D) throw new Error('BMP: bad signature');

    const dataOffset = buf.readUInt32LE(10);
    const headerSize = buf.readUInt32LE(14);

    let width, height, bitCount, compression, paletteEntrySize;
    let topDown = false;

    if (headerSize === 12) {
        // BITMAPCOREHEADER (OS/2)
        width = buf.readUInt16LE(18);
        height = buf.readInt16LE(20);
        if (height < 0) { topDown = true; height = -height; }
        bitCount = buf.readUInt16LE(24);
        compression = 0;
        paletteEntrySize = 3;
    } else {
        // BITMAPINFOHEADER 及以上
        width = buf.readInt32LE(18);
        height = buf.readInt32LE(22);
        if (height < 0) { topDown = true; height = -height; }
        bitCount = buf.readUInt16LE(28);
        compression = buf.readUInt32LE(30);
        const colorsUsed = buf.readUInt32LE(46);
        paletteEntrySize = 4;

        // BITFIELDS 掩码在 header 之后
        if (compression === 3 || compression === 6) {
            // 16/32 位 bitfields
            // 这里我们简化处理，下面 readColor 会用默认掩码
        }

        // 若 colorsUsed 为 0，按位深推导调色板大小
        let paletteCount = colorsUsed;
        if (paletteCount === 0 && bitCount <= 8) {
            paletteCount = 1 << bitCount;
        }

        // 调色板位置
        var paletteOffset = 14 + headerSize;
        var palette = null;
        if (bitCount <= 8) {
            palette = buf.subarray(paletteOffset, paletteOffset + paletteCount * paletteEntrySize);
        }
    }

    const bytesPerPixel = bitCount / 8;
    const rowSize = Math.floor((bitCount * width + 31) / 32) * 4;
    const out = new Uint8Array(width * height * 4);
    out.fill(255);

    // 快速路径：24 位 BI_RGB
    if (bitCount === 24 && compression === 0) {
        for (let y = 0; y < height; y++) {
            const srcRow = dataOffset + (topDown ? y : (height - 1 - y)) * rowSize;
            const dstRow = y * width * 4;
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 3;
                const d = dstRow + x * 4;
                out[d]     = buf[s + 2]; // R
                out[d + 1] = buf[s + 1]; // G
                out[d + 2] = buf[s];     // B
                out[d + 3] = 255;
            }
        }
        return { data: out, width, height };
    }

    // 快速路径：32 位 BI_RGB
    if (bitCount === 32 && compression === 0) {
        for (let y = 0; y < height; y++) {
            const srcRow = dataOffset + (topDown ? y : (height - 1 - y)) * rowSize;
            const dstRow = y * width * 4;
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                const d = dstRow + x * 4;
                out[d]     = buf[s + 2];
                out[d + 1] = buf[s + 1];
                out[d + 2] = buf[s];
                out[d + 3] = 255;
            }
        }
        return { data: out, width, height };
    }

    // 通用路径：调色板 / 低位深 / RLE
    // 先构建调色板 RGBA
    let paletteRgba = null;
    if (bitCount <= 8 && palette) {
        const count = palette.length / paletteEntrySize;
        paletteRgba = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
            const p = i * paletteEntrySize;
            paletteRgba[i * 4]     = palette[p + 2]; // R
            paletteRgba[i * 4 + 1] = palette[p + 1]; // G
            paletteRgba[i * 4 + 2] = palette[p];     // B
            paletteRgba[i * 4 + 3] = 255;
        }
    }

    function setPixel(x, y, idx) {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const d = (y * width + x) * 4;
        if (paletteRgba) {
            const p = idx * 4;
            if (p + 3 < paletteRgba.length) {
                out[d] = paletteRgba[p];
                out[d + 1] = paletteRgba[p + 1];
                out[d + 2] = paletteRgba[p + 2];
                out[d + 3] = 255;
            }
        } else {
            out[d] = out[d + 1] = out[d + 2] = idx & 0xFF;
            out[d + 3] = 255;
        }
    }

    if (compression === 1 || compression === 2) {
        // RLE8 / RLE4
        let x = 0, y = 0;
        let p = dataOffset;
        while (p < buf.length && y < height) {
            const n = buf[p++];
            if (n > 0) {
                const v = buf[p++];
                if (compression === 1) {
                    // RLE8
                    for (let i = 0; i < n; i++) setPixel(x++, y, v);
                } else {
                    // RLE4
                    for (let i = 0; i < n; i++) {
                        const idx = (i % 2 === 0) ? (v >> 4) : (v & 0x0F);
                        setPixel(x++, y, idx);
                    }
                }
            } else {
                const ctrl = buf[p++];
                if (ctrl === 0) { x = 0; y++; }
                else if (ctrl === 1) break;
                else if (ctrl === 2) {
                    x += buf[p++];
                    y += buf[p++];
                } else {
                    if (compression === 1) {
                        for (let i = 0; i < ctrl; i++) setPixel(x++, y, buf[p++]);
                        if (ctrl & 1) p++;
                    } else {
                        for (let i = 0; i < ctrl; i++) {
                            const b = buf[p + (i >> 1)];
                            const idx = (i % 2 === 0) ? (b >> 4) : (b & 0x0F);
                            setPixel(x++, y, idx);
                        }
                        p += Math.ceil(ctrl / 2);
                        if (((ctrl + 1) >> 1) & 1) p++;
                    }
                }
            }
        }
        return { data: out, width, height };
    }

    // 非 RLE：逐行扫描
    for (let y = 0; y < height; y++) {
        const srcRow = dataOffset + (topDown ? y : (height - 1 - y)) * rowSize;
        let bitPos = srcRow * 8;

        for (let x = 0; x < width; x++) {
            let idx;
            if (bitCount === 1) {
                const byte = buf[Math.floor(bitPos / 8)];
                idx = (byte >> (7 - (bitPos % 8))) & 1;
                bitPos += 1;
            } else if (bitCount === 4) {
                const byte = buf[Math.floor(bitPos / 8)];
                idx = (bitPos % 8 === 0) ? (byte >> 4) : (byte & 0x0F);
                bitPos += 4;
            } else if (bitCount === 8) {
                idx = buf[Math.floor(bitPos / 8)];
                bitPos += 8;
            } else if (bitCount === 16) {
                // 默认 555
                const s = srcRow + x * 2;
                const v = buf.readUInt16LE(s);
                const r = ((v >> 10) & 0x1F) << 3;
                const g = ((v >> 5) & 0x1F) << 3;
                const b = (v & 0x1F) << 3;
                const d = (y * width + x) * 4;
                out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
                continue;
            } else if (bitCount === 24) {
                const s = srcRow + x * 3;
                const d = (y * width + x) * 4;
                out[d] = buf[s + 2];
                out[d + 1] = buf[s + 1];
                out[d + 2] = buf[s];
                out[d + 3] = 255;
                continue;
            } else if (bitCount === 32) {
                const s = srcRow + x * 4;
                const d = (y * width + x) * 4;
                out[d] = buf[s + 2];
                out[d + 1] = buf[s + 1];
                out[d + 2] = buf[s];
                out[d + 3] = 255;
                continue;
            } else {
                throw new Error('BMP: unsupported bit depth ' + bitCount);
            }
            setPixel(x, y, idx);
        }
    }

    return { data: out, width, height };
}

/* ========================================================= */

exports.init = function (api) {
    path = api.require('path');
    fs = api.require('fs');
    util = api.require('util');
    crypto = api.require('crypto');
    Worker = api.require('worker_threads').Worker;

    const pluginDir = __dirname;
    cacheDir = path.join(pluginDir, 'cache');
    thumbCacheDir = path.join(pluginDir, 'thumb-cache');
    const workerPath = path.join(pluginDir, 'worker.js');

    if (!fs.existsSync(thumbCacheDir)) {
        fs.mkdirSync(thumbCacheDir, { recursive: true });
    }

    const initialConfig = api.getConfig();
    updateConfig(initialConfig);
    jpegQuality = (initialConfig.jpegQuality || 95) / 100;

    api.subscribeConfig(
        ['cacheAround', 'cacheTTL', 'backgroundWorkersCount', 'generateThumbnails'],
        (newValues) => {
            if (isInitializing) {
                isInitializing = false;
                return;
            }
            const updatedConfig = { ...initialConfig, ...newValues };
            updateConfig(updatedConfig);

            if (newValues.backgroundWorkersCount !== undefined) {
                restartWorkers().catch(error => {
                    api.log('Error restarting workers:', error);
                });
            }
        }
    );

    function updateConfig(config) {
        cacheAround = typeof config.cacheAround !== 'undefined' ? config.cacheAround : 16;
        cacheTTL = (typeof config.cacheTTL !== 'undefined' ? config.cacheTTL : 24) * 60 * 60 * 1000;
        backgroundWorkersCount = typeof config.backgroundWorkersCount !== 'undefined'
            ? Math.max(1, Math.min(8, config.backgroundWorkersCount)) : 1;
        generateThumbnails = typeof config.generateThumbnails !== 'undefined' ? config.generateThumbnails : true;
    }

    function getPathHash(realPath) {
        return crypto.createHash('md5').update(realPath).digest('hex');
    }

    function getCacheBaseName(realPath) {
        const base = path.basename(realPath, path.extname(realPath))
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 80);
        const hash8 = getPathHash(realPath).slice(0, 8);
        return `${base}_${hash8}`;
    }

    function getThumbCachePath(realPath) {
        return path.join(thumbCacheDir, `${getCacheBaseName(realPath)}_thumb.jpg`);
    }

    function getConvertCachePath(realPath) {
        return path.join(cacheDir, `${getCacheBaseName(realPath)}.jpg`);
    }

    async function convertBmpBuffer(bmpBuffer, quality) {
        // 1) 内置解码器 → RGBA
        const decoded = decodeBmpToRgba(bmpBuffer);
        if (!decoded || !decoded.data || !decoded.width || !decoded.height) {
            throw new Error('BMP decode failed');
        }

        // 2) Sharp 以 raw 输入编码 JPEG
        const rawOptions = {
            raw: {
                width: decoded.width,
                height: decoded.height,
                channels: 4
            }
        };

        const sharpResults = api.customApiCall('sharp', decoded.data, rawOptions);
        if (!sharpResults || sharpResults.length === 0) {
            throw new Error('sharp plugin not available');
        }
        const sharp = sharpResults[0];
        return await sharp
            .jpeg({ quality: Math.round(quality * 100) })
            .toBuffer();
    }

    async function generateThumbnail(jpgBuffer, filePath) {
        if (!generateThumbnails) return null;
        try {
            const sharpResults = api.customApiCall('sharp', jpgBuffer);
            if (!sharpResults || sharpResults.length === 0) return null;

            const sharp = sharpResults[0];
            const thumbBuffer = await sharp
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            const thumbPath = getThumbCachePath(filePath);
            await fs.promises.writeFile(thumbPath, thumbBuffer);
            return thumbBuffer;
        } catch (error) {
            api.log('Error generating thumbnail:', error);
            return null;
        }
    }

    async function checkThumbCache(realPath) {
        try {
            const thumbPath = getThumbCachePath(realPath);
            if (!fs.existsSync(thumbPath)) return null;

            const thumbStats = await fs.promises.stat(thumbPath);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > thumbStats.mtimeMs) {
                fs.unlinkSync(thumbPath);
                return null;
            }
            return await fs.promises.readFile(thumbPath);
        } catch (error) {
            api.log(`Error checking thumbnail cache for ${realPath}:`, error);
            return null;
        }
    }

    async function restartWorkers() {
        if (isUnloading) return;
        await stopWorkers();

        immediateQueue.length = 0;
        backgroundQueue.length = 0;
        inProgress.clear();
        pendingBackgroundTasks.clear();

        workerPool = [];
        workerPool.push(createWorker(1, 'immediate'));
        for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
            workerPool.push(createWorker(i, 'background'));
        }
    }

    async function stopWorkers() {
        if (workerPool.length === 0) return;

        const terminationPromises = workerPool.map(worker => {
            return new Promise(resolve => {
                if (worker && !worker.isTerminating) {
                    worker.isTerminating = true;
                    try {
                        worker.postMessage({ type: 'shutdown' });
                    } catch (error) {
                        api.log(`Error sending shutdown to worker ${worker.id}:`, error);
                    }
                    worker.removeAllListeners('message');
                    worker.removeAllListeners('error');
                    worker.once('exit', () => resolve());
                    setTimeout(() => {
                        if (worker.exitCode === null) worker.terminate();
                    }, 1000);
                } else {
                    resolve();
                }
            });
        });

        await Promise.race([
            Promise.all(terminationPromises),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);

        workerPool = [];
    }

    for (const dir of [cacheDir, thumbCacheDir]) {
        if (fs.existsSync(dir)) {
            try {
                for (const file of fs.readdirSync(dir)) {
                    fs.unlinkSync(path.join(dir, file));
                }
            } catch (error) {
                api.log(`Error clearing cache ${dir} on startup:`, error);
            }
        } else {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const cleanupOldCache = async () => {
        if (isUnloading) return;
        try {
            const now = Date.now();
            for (const dir of [cacheDir, thumbCacheDir]) {
                if (!fs.existsSync(dir)) continue;
                for (const file of fs.readdirSync(dir)) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (now - stats.mtimeMs > cacheTTL) {
                            fs.unlinkSync(filePath);
                            for (const [key, value] of cache.entries()) {
                                if (value.path === filePath) {
                                    cache.delete(key);
                                    break;
                                }
                            }
                        }
                    } catch (error) {
                        api.log(`Error processing cache file ${file}:`, error);
                    }
                }
            }
            await restartWorkers();
        } catch (error) {
            api.log('Error in cache cleanup:', error);
        }
    };

    cleanupInterval = setInterval(() => {
        cleanupOldCache().catch(error => {
            api.log('Error during scheduled cleanup:', error);
        });
    }, 60 * 60 * 1000);

    let lastRequestedFile = null;

    const createWorker = (id, role) => {
        const worker = new Worker(workerPath);
        worker.setMaxListeners(20);
        worker.isBusy = false;
        worker.id = id;
        worker.role = role;
        worker.isTerminating = false;

        worker.on('message', async (message) => {
            if (worker.isTerminating) return;

            worker.isBusy = false;
            if (message.filePath) inProgress.delete(message.filePath);

            if (message.success) {
                try {
                    // 结构化克隆后 Buffer → Uint8Array，重新包成 Buffer
                    const rawBuffer = Buffer.from(
                        message.buffer.buffer,
                        message.buffer.byteOffset,
                        message.buffer.byteLength
                    );
                    const jpgBuffer = await convertBmpBuffer(rawBuffer, jpegQuality);
                    await cacheConversion(message.filePath, jpgBuffer);

                    if (generateThumbnails) {
                        try {
                            await generateThumbnail(jpgBuffer, message.filePath);
                        } catch (thumbError) {
                            api.log('Thumbnail generation failed:', thumbError);
                        }
                    }

                    if (worker.role === 'immediate' && lastRequestedFile === message.filePath) {
                        const parentPath = path.dirname(message.filePath);
                        preconvertNeighbors(message.filePath, parentPath);
                    }
                } catch (convError) {
                    api.log(`Conversion error for ${message.filePath}:`, convError);
                }
            } else if (message.error) {
                api.log(`Worker ${worker.id} (${worker.role}) read error for ${message.filePath}:`, message.error);
            }

            processNextTask(worker);
        });

        worker.on('error', (error) => {
            if (worker.isTerminating) return;
            api.log(`Worker ${worker.id} (${worker.role}) error:`, error);
            worker.isBusy = false;
            if (worker.currentTask) {
                inProgress.delete(worker.currentTask.filePath);
                worker.currentTask = null;
            }
            processNextTask(worker);
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !isUnloading && !worker.isTerminating) {
                const index = workerPool.findIndex(w => w.id === worker.id);
                if (index !== -1) {
                    workerPool[index] = createWorker(worker.id, worker.role);
                }
            }
        });

        return worker;
    };

    workerPool.push(createWorker(1, 'immediate'));
    for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
        workerPool.push(createWorker(i, 'background'));
    }

    const immediateQueue = [];
    const backgroundQueue = [];

    const processNextTask = (worker) => {
        if (worker.isBusy || worker.isTerminating) return;

        let queue = worker.role === 'immediate' ? immediateQueue : backgroundQueue;
        if (queue.length === 0) return;

        const task = queue.shift();
        if (worker.role === 'background') {
            pendingBackgroundTasks.delete(task.filePath);
        }

        if (inProgress.has(task.filePath)) {
            processNextTask(worker);
            return;
        }

        worker.isBusy = true;
        worker.currentTask = task;
        inProgress.add(task.filePath);

        if (!worker.isTerminating) {
            worker.postMessage({ type: 'read', filePath: task.filePath });
        }
    };

    const addConversionTask = async (filePath, priority = false) => {
        if (isUnloading) return;
        if (inProgress.has(filePath)) return;

        if (priority) {
            lastRequestedFile = filePath;
            immediateQueue.length = 0;
            immediateQueue.push({ filePath, quality: jpegQuality });
            const immediateWorker = workerPool.find(w => w.role === 'immediate' && !w.isBusy && !w.isTerminating);
            if (immediateWorker) processNextTask(immediateWorker);
        } else {
            if (pendingBackgroundTasks.has(filePath)) return;
            backgroundQueue.push({ filePath, quality: jpegQuality });
            pendingBackgroundTasks.add(filePath);

            const backgroundWorkers = workerPool.filter(w =>
                w.role === 'background' && !w.isBusy && !w.isTerminating
            );
            backgroundWorkers.forEach(worker => processNextTask(worker));
        }
    };

    async function cacheConversion(realPath, outputBuffer) {
        try {
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            const cachePath = getConvertCachePath(realPath);
            await fs.promises.writeFile(cachePath, outputBuffer);
            cache.set(realPath, { path: cachePath, timestamp: Date.now() });
        } catch (error) {
            api.log('Error caching conversion:', error);
        }
    }

    async function checkCache(realPath) {
        try {
            if (!cache.has(realPath)) return null;

            const cacheInfo = cache.get(realPath);
            const cacheStats = await fs.promises.stat(cacheInfo.path);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > cacheStats.mtimeMs) {
                fs.unlinkSync(cacheInfo.path);
                cache.delete(realPath);
                return null;
            }
            return await fs.promises.readFile(cacheInfo.path);
        } catch (error) {
            api.log(`Error checking cache for ${realPath}:`, error);
            return null;
        }
    }

    async function preconvertNeighbors(realPath, parentPath) {
        if (cacheAround === 0) return;

        backgroundQueue.length = 0;
        pendingBackgroundTasks.clear();

        try {
            const files = await fs.promises.readdir(parentPath);
            const bmpFiles = files.filter(f =>
                f.toLowerCase().endsWith('.bmp')
            ).sort();

            const currentIndex = bmpFiles.findIndex(f =>
                path.join(parentPath, f) === realPath
            );
            if (currentIndex === -1) return;

            const start = Math.max(0, currentIndex - cacheAround);
            const end = Math.min(bmpFiles.length - 1, currentIndex + cacheAround);

            const filesToConvert = [];
            for (let i = currentIndex + 1; i <= end; i++) {
                filesToConvert.push(path.join(parentPath, bmpFiles[i]));
            }
            for (let i = currentIndex - 1; i >= start; i--) {
                filesToConvert.push(path.join(parentPath, bmpFiles[i]));
            }

            if (filesToConvert.length > 0) {
                setTimeout(() => {
                    if (isUnloading) return;
                    filesToConvert.forEach(filePath => {
                        checkCache(filePath).then(cached => {
                            if (!cached && !isUnloading) {
                                addConversionTask(filePath, false);
                            }
                        });
                    });
                }, 500);
            }
        } catch (error) {
            api.log('Error in preconvertNeighbors:', error);
        }
    }

    setTimeout(() => { isInitializing = false; }, 100);

    const isBmp = (url) => url.endsWith('.bmp');

    return {
        middleware: ctx => async () => {
            const url = ctx.path.toLowerCase();

            if (isBmp(url) && ctx.query.convert === 'bmp') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }
                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const cachedData = await checkCache(realPath);
                    if (cachedData) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = cachedData;
                        preconvertNeighbors(realPath, path.dirname(realPath));
                        return ctx.stop();
                    }

                    addConversionTask(realPath, true);

                    const waitForConversion = async (filePath, maxWait = 30000) => {
                        const startTime = Date.now();
                        while (Date.now() - startTime < maxWait) {
                            const cached = await checkCache(filePath);
                            if (cached) return cached;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        return null;
                    };

                    const result = await waitForConversion(realPath);
                    if (result) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = result;
                        preconvertNeighbors(realPath, path.dirname(realPath));
                    } else {
                        ctx.status = 202;
                        ctx.body = 'Conversion in progress, please wait and refresh';
                    }
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing conversion request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }

            if (isBmp(url) && ctx.query.get === 'thumbbmp') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }
                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    if (generateThumbnails) {
                        const thumbData = await checkThumbCache(realPath);
                        if (thumbData) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = thumbData;
                            return ctx.stop();
                        }

                        const cachedData = await checkCache(realPath);
                        if (cachedData) {
                            const t = await generateThumbnail(cachedData, realPath);
                            if (t) {
                                ctx.type = 'image/jpeg';
                                ctx.set('Cache-Control', 'public, max-age=3600');
                                ctx.body = t;
                                return ctx.stop();
                            }
                        }

                        addConversionTask(realPath, true);

                        const waitForThumb = async (filePath, maxWait = 30000) => {
                            const startTime = Date.now();
                            while (Date.now() - startTime < maxWait) {
                                const t = await checkThumbCache(filePath);
                                if (t) return t;
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                            return null;
                        };

                        const t = await waitForThumb(realPath);
                        if (t) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = t;
                            return ctx.stop();
                        }
                    }

                    ctx.status = 404;
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing thumbnail request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }
        },

        frontend_js: 'frontend.js',

        unload: () => {
            isUnloading = true;
            isInitializing = false;

            if (cleanupInterval) clearInterval(cleanupInterval);

            try {
                [cacheDir, thumbCacheDir].forEach(dir => {
                    if (fs.existsSync(dir)) {
                        for (const file of fs.readdirSync(dir)) {
                            try {
                                fs.unlinkSync(path.join(dir, file));
                            } catch (error) {
                                api.log(`Error deleting cache file ${file}:`, error);
                            }
                        }
                    }
                });
            } catch (error) {
                api.log('Error clearing cache directories on unload:', error);
            }

            immediateQueue.length = 0;
            backgroundQueue.length = 0;
            inProgress.clear();
            pendingBackgroundTasks.clear();
            cache.clear();

            return stopWorkers().then(() => {});
        }
    };
};