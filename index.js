require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const { Bot } = require('grammy');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });

function getDataFilePath(filename) {
    const dataPath = path.join(DATA_DIR, filename);
    const initialPath = path.join(__dirname, filename);
    if (dataPath !== initialPath && !fs.existsSync(dataPath) && fs.existsSync(initialPath)) {
        fs.copyFileSync(initialPath, dataPath);
    }
    return dataPath;
}

const USERS_FILE = getDataFilePath('users.json');
const INSTANCES_FILE = getDataFilePath('instances.json');
const ORDERS_FILE = getDataFilePath('orders.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'kurumihost';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || process.env.SESSION_SECRET || 'local-development-reset-secret';
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const BASH_EXECUTABLE = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'NISAN';
const TERMINAL_BACKEND = process.env.TERMINAL_BACKEND || (process.env.NODE_ENV === 'production' ? 'docker' : 'host');
const DOCKER_TERMINAL_IMAGE = process.env.DOCKER_TERMINAL_IMAGE || 'ubuntu:24.04';
const BILLING_MONTHS = [1, 2, 3, 6, 8, 12];
const PAYMENT_METHODS = [
    { id: 'bkash', name: 'bKash', receiver: process.env.BKASH_RECEIVER || null },
    { id: 'nagad', name: 'Nagad', receiver: process.env.NAGAD_RECEIVER || process.env.PAYMENT_RECEIVER || '01775602198' },
    { id: 'rocket', name: 'Rocket', receiver: process.env.ROCKET_RECEIVER || null },
    { id: 'upay', name: 'Upay', receiver: process.env.UPAY_RECEIVER || null }
];
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
let users = [];
let instances = {};
let orders = [];
let mongoClient = null;
let mongoUsers = null;
let telegramBot = null;
const passwordResetChallenges = new Map();
const passwordResetRateLimits = new Map();
const activeTerminals = new Map();
const activeTerminalOwners = new Map();

function readLegacyUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('User Load Error:', error.message);
        return [];
    }
}

function normalizeUserRecord(user) {
    const record = { ...user };
    record.usernameNormalized = String(record.username || '').trim().toLowerCase();
    if (record.email) record.emailNormalized = String(record.email).trim().toLowerCase();
    if (record.telegram_id) record.telegram_id_normalized = String(record.telegram_id).trim();
    if (record.instance_count === undefined) record.instance_count = 0;
    if (record.expiry_date === undefined) record.expiry_date = null;
    if (record.is_locked === undefined) record.is_locked = false;
    if (record.password && !record.password_hash) {
        Object.assign(record, hashPassword(record.password));
        delete record.password;
    }
    return record;
}

async function loadUsers() {
    if (mongoUsers) {
        users = (await mongoUsers.find({}).toArray()).map(normalizeUserRecord);
        return;
    }
    users = readLegacyUsers().map(normalizeUserRecord);
}

async function saveUsers() {
    users = users.map(normalizeUserRecord);
    if (mongoUsers) {
        const operations = users.map(user => ({
            replaceOne: {
                filter: { usernameNormalized: user.usernameNormalized },
                replacement: user,
                upsert: true
            }
        }));
        if (operations.length) await mongoUsers.bulkWrite(operations, { ordered: true });
        return;
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function connectUserStore() {
    if (!MONGODB_URI) {
        await loadUsers();
        return;
    }

    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
    mongoUsers = mongoClient.db(MONGODB_DB_NAME).collection('users');
    await mongoUsers.createIndex({ usernameNormalized: 1 }, { unique: true });
    await mongoUsers.createIndex({ emailNormalized: 1 }, { unique: true, sparse: true });
    await mongoUsers.createIndex({ telegram_id_normalized: 1 }, { unique: true, sparse: true });

    if (await mongoUsers.countDocuments() === 0) {
        const legacyUsers = readLegacyUsers().map(normalizeUserRecord);
        if (legacyUsers.length) {
            await mongoUsers.insertMany(legacyUsers);
            fs.writeFileSync(USERS_FILE, JSON.stringify(legacyUsers, null, 2));
        }
    }
    await loadUsers();
}

function loadInstances() {
    if (fs.existsSync(INSTANCES_FILE)) {
        try { instances = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')); } 
        catch (e) { instances = {}; }
    }
}

function saveInstances() {
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(instances, null, 2));
}

function loadOrders() {
    if (fs.existsSync(ORDERS_FILE)) {
        try {
            const storedOrders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
            orders = Array.isArray(storedOrders) ? storedOrders : [];
        } catch (e) {
            console.error('Order Load Error:', e.message);
            orders = [];
        }
    }
}

function saveOrders() {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
        password_hash: crypto.scryptSync(password, salt, 64).toString('hex'),
        password_salt: salt
    };
}

function addCalendarMonths(date, months) {
    const result = new Date(date);
    const originalDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(originalDay, lastDay));
    return result;
}

function getPlan(months) {
    const discountPercent = months >= 6 ? 5 : 2;
    const basePrice = months * 100;
    return {
        months,
        basePrice,
        discountPercent,
        price: Math.round(basePrice * (100 - discountPercent) / 100),
        terminalLimit: 3
    };
}

function verifyPassword(user, password) {
    if (typeof password !== 'string') return false;
    if (user.password_hash && user.password_salt) {
        const submittedHash = crypto.scryptSync(password, user.password_salt, 64);
        const storedHash = Buffer.from(user.password_hash, 'hex');
        return storedHash.length === submittedHash.length && crypto.timingSafeEqual(storedHash, submittedHash);
    }
    return user.password === password;
}

function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) return;
    telegramBot = new Bot(TELEGRAM_BOT_TOKEN);
    const sendTelegramId = async context => {
        if (context.chat.type !== 'private') {
            await context.reply('Please open this bot in a private chat, then press Start.');
            return;
        }
        await context.reply(`Your Telegram ID is: ${context.chat.id}\nUse this ID in KuRuMi-Host password recovery.`);
    };
    telegramBot.command('start', sendTelegramId);
    telegramBot.command('id', sendTelegramId);
    telegramBot.catch(() => console.error('Telegram bot update failed.'));
    telegramBot.start().catch(() => console.error('Telegram bot polling failed. Check TELEGRAM_BOT_TOKEN.'));
}

function makeResetDigest(usernameNormalized, telegramId, code) {
    return crypto.createHmac('sha256', PASSWORD_RESET_SECRET)
        .update(`${usernameNormalized}:${telegramId}:${code}`)
        .digest('hex');
}

function invalidateUserSessions(username) {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    for (const filename of fs.readdirSync(SESSIONS_DIR)) {
        if (!filename.endsWith('.json')) continue;
        const sessionFile = path.join(SESSIONS_DIR, filename);
        try {
            const storedSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            if (storedSession.username === username) fs.unlinkSync(sessionFile);
        } catch {
            continue;
        }

        app.post('/api/auth/forgot/request', async (req, res) => {
            if (!TELEGRAM_BOT_TOKEN) {
                return res.status(503).json({ success: false, message: 'Telegram password recovery is not configured yet.' });
            }

            const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
            const telegramId = typeof req.body.telegramId === 'string' ? req.body.telegramId.trim() : '';
            if (!identifier || !/^\d{5,20}$/.test(telegramId)) {
                return res.status(400).json({ success: false, message: 'Enter your username or email and numeric Telegram ID.' });
            }

            const rateKey = `${req.ip || req.socket.remoteAddress || 'unknown'}:${identifier}`;
            const lastRequest = passwordResetRateLimits.get(rateKey) || 0;
            if (Date.now() - lastRequest < 60_000) {
                return res.status(429).json({ success: false, message: 'Wait one minute before requesting another code.' });
            }
            passwordResetRateLimits.set(rateKey, Date.now());

            await loadUsers();
            const user = users.find(item => item.usernameNormalized === identifier || item.emailNormalized === identifier);
            if (!user || user.telegram_id_normalized !== telegramId) {
                return res.json({ success: true, message: 'If those details match an account, a code will be sent.' });
            }

            const code = String(crypto.randomInt(100000, 1000000));
            passwordResetChallenges.set(user.usernameNormalized, {
                digest: makeResetDigest(user.usernameNormalized, telegramId, code),
                telegramId,
                expiresAt: Date.now() + 5 * 60 * 1000,
                attempts: 0
            });

            try {
                const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramId,
                        text: `KuRuMi-Host password reset code: ${code}\nThis code expires in 5 minutes. Do not share it with anyone.`
                    })
                });
                const result = await telegramResponse.json();
                if (!telegramResponse.ok || !result.ok) throw new Error('Telegram delivery failed');
            } catch {
                passwordResetChallenges.delete(user.usernameNormalized);
                return res.status(400).json({ success: false, message: 'Could not deliver the code. Open @KuRuMi_Host_bot, press Start, then retry.' });
            }

            res.json({ success: true, message: 'A reset code was sent to your Telegram bot chat.' });
        });

        app.post('/api/auth/forgot/reset', async (req, res) => {
            const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
            const telegramId = typeof req.body.telegramId === 'string' ? req.body.telegramId.trim() : '';
            const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
            const password = typeof req.body.password === 'string' ? req.body.password : '';
            const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

            if (!identifier || !/^\d{5,20}$/.test(telegramId) || !/^\d{6}$/.test(code)) {
                return res.status(400).json({ success: false, message: 'Enter your account, Telegram ID, and six-digit code.' });
            }
            if (password.length < 10 || password.length > 128) return res.status(400).json({ success: false, message: 'Password must be 10-128 characters.' });
            if (password !== confirmPassword) return res.status(400).json({ success: false, message: 'Passwords do not match.' });

            await loadUsers();
            const user = users.find(item => item.usernameNormalized === identifier || item.emailNormalized === identifier);
            if (!user || user.telegram_id_normalized !== telegramId) {
                return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
            }

            const challenge = passwordResetChallenges.get(user.usernameNormalized);
            if (!challenge || challenge.telegramId !== telegramId || challenge.expiresAt <= Date.now()) {
                passwordResetChallenges.delete(user.usernameNormalized);
                return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
            }

            const submittedDigest = Buffer.from(makeResetDigest(user.usernameNormalized, telegramId, code), 'hex');
            const expectedDigest = Buffer.from(challenge.digest, 'hex');
            if (submittedDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(submittedDigest, expectedDigest)) {
                challenge.attempts += 1;
                if (challenge.attempts >= 5) passwordResetChallenges.delete(user.usernameNormalized);
                return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
            }

            Object.assign(user, hashPassword(password));
            delete user.password;
            await saveUsers();
            passwordResetChallenges.delete(user.usernameNormalized);
            invalidateUserSessions(user.username);
            res.json({ success: true, message: 'Password updated. You can now sign in.' });
        });
    }
}

function isTerminalSandboxReady() {
    if (TERMINAL_BACKEND !== 'docker' || typeof process.getuid !== 'function' || process.getuid() === 0) return false;
    try {
        execFileSync('docker', ['image', 'inspect', DOCKER_TERMINAL_IMAGE], { stdio: 'ignore', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function checkUserExpiry(user) {
    if (user.expiry_date) {
        const expiry = new Date(user.expiry_date);
        if (!Number.isNaN(expiry.getTime()) && Date.now() >= expiry.getTime()) {
            if (!user.is_locked) {
                user.is_locked = true;
                await saveUsers();
            }
            return true;
        }
    }
    return Boolean(user.is_locked);
}

async function checkAllUsersExpiry() {
    await loadUsers();
    let changed = false;
    for (const user of users) {
        if (user.expiry_date) {
            const expiry = new Date(user.expiry_date);
            const now = new Date();
            if (now > expiry && !user.is_locked) {
                user.is_locked = true;
                for (const [socketId, terminal] of activeTerminals) {
                    if (activeTerminalOwners.get(socketId) === user.username) {
                        terminal.kill();
                        activeTerminals.delete(socketId);
                        activeTerminalOwners.delete(socketId);
                    }
                }
                changed = true;
            }
        }
    }
    if (changed) {
        await saveUsers();
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
const sessionMiddleware = session({
    store: new FileStore({ path: SESSIONS_DIR, ttl: 86400, retries: 0 }),
    secret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? undefined : 'local-development-secret'),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

function requireAdmin(req, res, next) {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.username !== ADMIN_USERNAME) return res.status(403).json({ error: 'Admin access required' });
    next();
}

app.get('/plans.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'plans.html')));

app.get('/admin/orders', (req, res) => {
    if (!req.session.loggedin) return res.redirect('/login.html');
    if (req.session.username !== ADMIN_USERNAME) return res.status(403).send('Admin access required');
    res.sendFile(path.join(__dirname, 'views', 'admin-orders.html'));
});

app.get('/admin/users', (req, res) => {
    if (!req.session.loggedin) return res.redirect('/login.html');
    if (req.session.username !== ADMIN_USERNAME) return res.status(403).send('Admin access required');
    res.sendFile(path.join(__dirname, 'views', 'admin-users.html'));
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    await loadUsers();
    loadInstances();
    res.json(users.map(user => {
        const expiryTime = user.expiry_date ? new Date(user.expiry_date).getTime() : null;
        return {
            username: user.username,
            email: user.email || null,
            created_at: user.created_at || null,
            expiry_date: user.expiry_date || null,
            days_remaining: expiryTime && !Number.isNaN(expiryTime) ? Math.max(0, Math.ceil((expiryTime - Date.now()) / (24 * 60 * 60 * 1000))) : null,
            is_locked: Boolean(user.is_locked),
            instance_count: user.instance_count ?? null,
            instances_used: (instances[user.username] || []).length
        };
    }));
});

app.get('/api/store/config', (req, res) => {
    const sandboxReady = isTerminalSandboxReady();
    const paymentMethods = PAYMENT_METHODS.map(method => ({
        id: method.id,
        name: method.name,
        receiver: method.receiver,
        configured: Boolean(method.receiver)
    }));
    res.json({
        currency: 'BDT',
        plans: BILLING_MONTHS.map(getPlan),
        paymentMethods,
        checkoutEnabled: sandboxReady && paymentMethods.some(method => method.configured)
    });
});

app.post('/api/orders', async (req, res) => {
    if (!isTerminalSandboxReady()) return res.status(503).json({ error: 'Checkout is not configured yet. Do not send payment until support enables checkout.' });

    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const telegramId = typeof req.body.telegramId === 'string' ? req.body.telegramId.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const transactionId = typeof req.body.transactionId === 'string' ? req.body.transactionId.trim() : '';
    const selectedMethod = PAYMENT_METHODS.find(method => method.id === req.body.paymentMethod && method.receiver);
    const paymentMethod = selectedMethod?.name || '';

    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-30 letters, numbers, _ or -.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter the account password (8-128 characters).' });
    if (!/^[0-9+() -]{8,24}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (!paymentMethod || transactionId.length < 5 || transactionId.length > 80) return res.status(400).json({ error: 'Enter the payment method and valid transaction ID.' });
    const durationMonths = Number(req.body.durationMonths);
    if (!BILLING_MONTHS.includes(durationMonths)) return res.status(400).json({ error: 'Choose a supported plan duration.' });
    const plan = getPlan(durationMonths);

    await loadUsers();
    loadOrders();
    const normalizedUsername = username.toLowerCase();
    const normalizedTransactionId = transactionId.toLowerCase();
    const existingUser = users.find(user => user.username.toLowerCase() === normalizedUsername);
    if (existingUser?.username === ADMIN_USERNAME) return res.status(403).json({ error: 'Admin accounts cannot purchase a customer plan.' });
    if (existingUser && !verifyPassword(existingUser, password)) return res.status(401).json({ error: 'Account details could not be verified.' });
    if (!existingUser && password.length < 10) return res.status(400).json({ error: 'New account passwords must be at least 10 characters.' });
    if (orders.some(order => order.username.toLowerCase() === normalizedUsername && order.status === 'pending')) {
        return res.status(409).json({ error: 'A pending request already exists for that username.' });
    }
    if (orders.some(order => order.transactionId.toLowerCase() === normalizedTransactionId)) {
        return res.status(409).json({ error: 'That transaction ID has already been submitted.' });
    }

    const credentials = existingUser ? {} : hashPassword(password);
    const order = {
        id: crypto.randomBytes(16).toString('hex'),
        type: existingUser ? 'renewal' : 'new',
        username,
        email,
        phone,
        paymentMethod,
        transactionId,
        basePrice: plan.basePrice,
        discountPercent: plan.discountPercent,
        price: plan.price,
        currency: 'BDT',
        terminalLimit: plan.terminalLimit,
        durationMonths,
        ...credentials,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    orders.push(order);
    saveOrders();
    res.status(201).json({ id: order.id, status: order.status, message: 'Payment request submitted for manual review.' });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
    loadOrders();
    const safeOrders = orders.map(({ password_hash, password_salt, ...order }) => order);
    res.json(safeOrders);
});

app.post('/api/admin/orders/:id/approve', requireAdmin, async (req, res) => {
    if (!isTerminalSandboxReady()) {
        return res.status(503).json({ error: 'Customer terminals stay disabled until the isolated Docker backend is configured.' });
    }

    await loadUsers();
    loadOrders();
    const order = orders.find(item => item.id === req.params.id);
    if (!order || order.status !== 'pending') return res.status(404).json({ error: 'Pending order not found.' });
    const existingUser = users.find(user => user.username.toLowerCase() === order.username.toLowerCase());
    const now = new Date();
    const currentExpiry = existingUser?.expiry_date ? new Date(existingUser.expiry_date) : null;
    const renewalBase = currentExpiry && !Number.isNaN(currentExpiry.getTime()) && currentExpiry > now ? currentExpiry : now;
    const expiryDate = addCalendarMonths(renewalBase, order.durationMonths || 1).toISOString();

    if (order.type === 'renewal') {
        if (!existingUser) return res.status(409).json({ error: 'Account no longer exists.' });
        existingUser.email = order.email;
        existingUser.expiry_date = expiryDate;
        existingUser.instance_count = order.terminalLimit;
        existingUser.is_locked = false;
        existingUser.renewed_at = now.toISOString();
    } else {
        if (existingUser) return res.status(409).json({ error: 'Username is already in use.' });
        users.push({
            username: order.username,
            email: order.email,
            password_hash: order.password_hash,
            password_salt: order.password_salt,
            created_at: now.toISOString(),
            expiry_date: expiryDate,
            instance_count: order.terminalLimit,
            is_locked: false,
            terminal_backend: 'docker'
        });
    }
    order.status = 'approved';
    order.approvedAt = now.toISOString();
    order.approvedBy = req.session.username;
    delete order.password_hash;
    delete order.password_salt;
    await saveUsers();
    saveOrders();
    res.json({ success: true });
});

app.post('/api/admin/orders/:id/reject', requireAdmin, (req, res) => {
    loadOrders();
    const order = orders.find(item => item.id === req.params.id);
    if (!order || order.status !== 'pending') return res.status(404).json({ error: 'Pending order not found.' });
    order.status = 'rejected';
    order.reviewedAt = new Date().toISOString();
    order.reviewedBy = req.session.username;
    delete order.password_hash;
    delete order.password_salt;
    saveOrders();
    res.json({ success: true });
});

app.post('/api/auth/forgot/request', async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ success: false, message: 'Telegram password recovery is not configured yet.' });

    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
    const telegramId = typeof req.body.telegramId === 'string' ? req.body.telegramId.trim() : '';
    if (!identifier || !/^\d{5,20}$/.test(telegramId)) {
        return res.status(400).json({ success: false, message: 'Enter your username or email and numeric Telegram ID.' });
    }

    const rateKey = `${req.ip || req.socket.remoteAddress || 'unknown'}:${identifier}`;
    const lastRequest = passwordResetRateLimits.get(rateKey) || 0;
    if (Date.now() - lastRequest < 60_000) {
        return res.status(429).json({ success: false, message: 'Wait one minute before requesting another code.' });
    }
    passwordResetRateLimits.set(rateKey, Date.now());

    await loadUsers();
    const user = users.find(item => item.usernameNormalized === identifier || item.emailNormalized === identifier);
    if (!user || user.telegram_id_normalized !== telegramId) {
        return res.json({ success: true, message: 'If those details match an account, a code will be sent.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    passwordResetChallenges.set(user.usernameNormalized, {
        digest: makeResetDigest(user.usernameNormalized, telegramId, code),
        telegramId,
        expiresAt: Date.now() + 5 * 60 * 1000,
        attempts: 0
    });

    try {
        const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: telegramId,
                text: `KuRuMi-Host password reset code: ${code}\nThis code expires in 5 minutes. Do not share it with anyone.`
            })
        });
        const result = await telegramResponse.json();
        if (!telegramResponse.ok || !result.ok) throw new Error('Telegram delivery failed');
    } catch {
        passwordResetChallenges.delete(user.usernameNormalized);
        return res.status(400).json({ success: false, message: 'Could not message this Telegram ID. Open @KuRuMi_Host_bot, press Start, then try again.' });
    }

    res.json({ success: true, message: 'A reset code was sent to your Telegram bot chat.' });
});

app.post('/api/auth/forgot/reset', async (req, res) => {
    const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
    const telegramId = typeof req.body.telegramId === 'string' ? req.body.telegramId.trim() : '';
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    if (!identifier || !/^\d{5,20}$/.test(telegramId) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'Enter your account, Telegram ID, and six-digit code.' });
    }
    if (password.length < 10 || password.length > 128) return res.status(400).json({ success: false, message: 'Password must be 10-128 characters.' });
    if (password !== confirmPassword) return res.status(400).json({ success: false, message: 'Passwords do not match.' });

    await loadUsers();
    const user = users.find(item => item.usernameNormalized === identifier || item.emailNormalized === identifier);
    if (!user || user.telegram_id_normalized !== telegramId) {
        return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
    }

    const challenge = passwordResetChallenges.get(user.usernameNormalized);
    if (!challenge || challenge.telegramId !== telegramId || challenge.expiresAt <= Date.now()) {
        passwordResetChallenges.delete(user.usernameNormalized);
        return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
    }

    const submittedDigest = Buffer.from(makeResetDigest(user.usernameNormalized, telegramId, code), 'hex');
    const expectedDigest = Buffer.from(challenge.digest, 'hex');
    if (submittedDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(submittedDigest, expectedDigest)) {
        challenge.attempts += 1;
        if (challenge.attempts >= 5) passwordResetChallenges.delete(user.usernameNormalized);
        return res.status(400).json({ success: false, message: 'Reset details or code are invalid or expired.' });
    }

    Object.assign(user, hashPassword(password));
    delete user.password;
    await saveUsers();
    passwordResetChallenges.delete(user.usernameNormalized);
    invalidateUserSessions(user.username);
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
});

app.post('/register', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: 'Name must be 2-80 characters.' });
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ success: false, message: 'Username must be 3-30 letters, numbers, _ or -.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    if (!/^\d{5,20}$/.test(telegramId)) return res.status(400).json({ success: false, message: 'Enter the numeric Telegram ID you received from the bot.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ success: false, message: 'Password must be 10-128 characters.' });
    if (password !== confirmPassword) return res.status(400).json({ success: false, message: 'Passwords do not match.' });

    await loadUsers();
    const usernameNormalized = username.toLowerCase();
    const emailNormalized = email.toLowerCase();
    if (users.some(user => user.usernameNormalized === usernameNormalized)) {
        return res.status(409).json({ success: false, message: 'That username is already in use.' });
    }
    if (users.some(user => user.emailNormalized === emailNormalized)) {
        return res.status(409).json({ success: false, message: 'That email is already in use.' });
    }
    if (users.some(user => user.telegram_id_normalized === telegramId)) {
        return res.status(409).json({ success: false, message: 'That Telegram ID is already linked to an account.' });
    }

    const user = {
        username,
        usernameNormalized,
        display_name: name,
        email,
        emailNormalized,
        telegram_id: telegramId,
        telegram_id_normalized: telegramId,
        notifications: [{
            id: crypto.randomBytes(12).toString('hex'),
            title: 'Account created',
            message: 'Choose a plan and submit payment for admin review to activate terminal access.',
            created_at: new Date().toISOString(),
            is_read: false
        }],
        ...hashPassword(password),
        created_at: new Date().toISOString(),
        expiry_date: null,
        instance_count: 0,
        is_locked: true,
        terminal_backend: 'docker'
    };

    users.push(user);
    try {
        await saveUsers();
    } catch (error) {
        users = users.filter(item => item.usernameNormalized !== usernameNormalized);
        if (error.code === 11000) return res.status(409).json({ success: false, message: 'Username or email is already in use.' });
        console.error('Registration save failed:', error.message);
        return res.status(503).json({ success: false, message: 'Account store is unavailable. Try again later.' });
    }

    res.status(201).json({ success: true, redirect: '/plans.html', message: 'Account created. Choose a plan to activate terminal access.' });
});

app.post('/auth', async (req, res) => {
    const identifier = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    await loadUsers();
    const user = users.find(u => u.usernameNormalized === identifier || u.emailNormalized === identifier || u.username.toLowerCase() === identifier);
    const validPassword = user && verifyPassword(user, password);
    if (user && validPassword) {
        if (await checkUserExpiry(user) || user.is_locked) {
            return res.status(403).json({ success: false, message: 'Account expired or locked. Renew from Plans to reactivate it.' });
        }
        req.session.loggedin = true;
        req.session.username = user.username;
        req.session.save(() => res.json({ success: true, redirect: '/dashboard' }));
    } else {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
});

app.get('/user-session', async (req, res) => {
    if (req.session.loggedin) {
        await loadUsers();
        loadInstances();
        const user = users.find(u => u.username === req.session.username);
        if (user) {
            await checkUserExpiry(user);
            const userInstances = instances[req.session.username] || [];
            const expiryTime = user.expiry_date ? new Date(user.expiry_date).getTime() : null;
            res.json({ 
                username: user.username,
                is_admin: user.username === ADMIN_USERNAME,
                expiry_date: user.expiry_date,
                created_at: user.created_at || null,
                days_remaining: expiryTime && !Number.isNaN(expiryTime) ? Math.max(0, Math.ceil((expiryTime - Date.now()) / (24 * 60 * 60 * 1000))) : null,
                instance_count: user.instance_count ?? null,
                instances_used: userInstances.length,
                is_locked: user.is_locked ?? false
            });
        } else {
            res.json({ username: null });
        }
    } else {
        res.json({ username: null });
    }
});

app.get('/dashboard', (req, res) => {
    req.session.loggedin ? res.sendFile(path.join(__dirname, 'views', 'dashboard.html')) : res.redirect('/login.html');
});

app.get('/terminal/:instanceId', (req, res) => {
    req.session.loggedin ? res.sendFile(path.join(__dirname, 'views', 'terminal.html')) : res.redirect('/login.html');
});

app.get('/terminal', (req, res) => {
    req.session.loggedin ? res.sendFile(path.join(__dirname, 'views', 'terminal.html')) : res.redirect('/login.html');
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/api/instances', (req, res) => {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not logged in' });
    loadInstances();
    const userInstances = instances[req.session.username] || [];
    res.json(userInstances);
});

app.get('/api/instances/:id', (req, res) => {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not logged in' });
    loadInstances();
    const userInstances = instances[req.session.username] || [];
    const instance = userInstances.find(i => i.id === req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    res.json(instance);
});

app.post('/api/instances', async (req, res) => {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not logged in' });
    
    await loadUsers();
    loadInstances();
    
    const user = users.find(u => u.username === req.session.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (await checkUserExpiry(user)) {
        return res.status(403).json({ error: 'Account expired and locked' });
    }
    
    if (user.is_locked) {
        return res.status(403).json({ error: 'Account is locked' });
    }
    
    const maxInstances = user.instance_count;
    const isUnlimited = maxInstances === null || maxInstances === undefined;
    const userInstances = instances[req.session.username] || [];
    
    if (!isUnlimited && maxInstances <= 0) {
        return res.status(403).json({ error: 'No instances allowed' });
    }
    
    if (!isUnlimited && userInstances.length >= maxInstances) {
        return res.status(403).json({ error: 'Maximum instances reached' });
    }
    
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Instance name required' });
    if (name.length > 30) return res.status(400).json({ error: 'Instance name must be 30 characters or fewer' });
    
    const newInstance = {
        id: Date.now().toString(),
        name: name,
        created: new Date().toISOString(),
        status: 'stopped'
    };
    
    if (!instances[req.session.username]) {
        instances[req.session.username] = [];
    }
    instances[req.session.username].push(newInstance);
    
    saveInstances();
    
    res.json(newInstance);
});

app.delete('/api/instances/:id', (req, res) => {
    if (!req.session.loggedin) return res.status(401).json({ error: 'Not logged in' });
    
    loadInstances();
    
    const userInstances = instances[req.session.username] || [];
    const index = userInstances.findIndex(i => i.id === req.params.id);
    
    if (index === -1) return res.status(404).json({ error: 'Instance not found' });
    
    userInstances.splice(index, 1);
    instances[req.session.username] = userInstances;
    
    saveInstances();
    
    res.json({ success: true });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login.html');
    });
});

io.use((socket, next) => {
    const origin = socket.request.headers.origin;
    if (origin) {
        try {
            if (new URL(origin).host !== socket.request.headers.host) {
                return next(new Error('Unauthorized'));
            }
        } catch {
            return next(new Error('Unauthorized'));
        }
    }

    const userSession = socket.request.session;
    if (!userSession?.loggedin || !userSession.username) {
        return next(new Error('Unauthorized'));
    }
    next();
});

io.on('connection', (socket) => {
    let ptyProcess = null;
    let currentUsername = null;
    let currentInstanceId = null;

    socket.on('start_terminal', async (userInfo = {}) => {
        currentUsername = socket.request.session.username;
        currentInstanceId = typeof userInfo.instanceId === 'string' ? userInfo.instanceId : '';
        
        await loadUsers();
        loadInstances();
        const userDetails = users.find(u => u.username === currentUsername);
        if (!userDetails) return;

        const userInstances = instances[currentUsername] || [];
        if (!currentInstanceId || !userInstances.some(instance => instance.id === currentInstanceId)) {
            socket.emit('output', '\r\n\x1b[31mInstance not found or access denied.\x1b[0m\r\n');
            return;
        }

        if (await checkUserExpiry(userDetails)) {
            socket.emit('output', '\r\n\x1b[31mAccount expired and locked!\x1b[0m\r\n');
            return;
        }

        if (userDetails.is_locked) {
            socket.emit('output', '\r\n\x1b[31mAccount is locked!\x1b[0m\r\n');
            return;
        }

        const userRootFolder = path.join(DATA_DIR, 'users', currentUsername);
        if (!fs.existsSync(userRootFolder)) fs.mkdirSync(userRootFolder, { recursive: true });

        const userEnv = Object.assign({}, process.env);
        userEnv['HOME'] = userRootFolder;
        userEnv['TERM'] = 'xterm-256color';
        userEnv['PS1'] = '$ ';

        if (userDetails.github_token) {
            userEnv['GITHUB_TOKEN'] = userDetails.github_token;
            userEnv['GIT_ASKPASS'] = 'echo';
            userEnv['GIT_TERMINAL_PROMPT'] = '0';
            
            const gitCredentialHelper = `#!/bin/bash
echo "protocol=https"
echo "host=github.com"
echo "username=${userDetails.github_username || 'git'}"
echo "password=${userDetails.github_token}"
`;
            const helperPath = path.join(userRootFolder, '.git-credential-helper');
            fs.writeFileSync(helperPath, gitCredentialHelper, { mode: 0o700 });
            
            try {
                const execOptions = { cwd: userRootFolder, env: userEnv };
                const gitConfigPath = path.join(userRootFolder, '.gitconfig');
                
                execSync(`git config --file "${gitConfigPath}" credential.helper "store"`, execOptions);
                execSync(`git config --file "${gitConfigPath}" user.name "${userDetails.github_username || currentUsername}"`, execOptions);
                execSync(`git config --file "${gitConfigPath}" user.email "${userDetails.email || 'user@nixhost.com'}"`, execOptions);
                execSync(`git config --file "${gitConfigPath}" --add safe.directory "*"`, execOptions);
                
                const credentialsFile = path.join(userRootFolder, '.git-credentials');
                fs.writeFileSync(credentialsFile, `https://${userDetails.github_username || 'git'}:${userDetails.github_token}@github.com\n`, { mode: 0o600 });
                execSync(`git config --file "${gitConfigPath}" credential.helper "store --file=${credentialsFile}"`, execOptions);
                
                userEnv['HOME'] = userRootFolder;
                userEnv['GIT_CONFIG_GLOBAL'] = gitConfigPath;
            } catch (e) { 
                console.error("Git Config Error:", e.message); 
            }
        }

        if (!ptyProcess) {
            const workingDir = userRootFolder;
            
            if (userDetails.github_token && userDetails.repo_name && userDetails.github_username) {
                const repoPath = path.join(userRootFolder, userDetails.repo_name);
                const repoUrl = `https://${userDetails.github_username}:${userDetails.github_token}@github.com/${userDetails.github_username}/${userDetails.repo_name}.git`;
                
                if (!fs.existsSync(repoPath)) {
                    try {
                        socket.emit('output', '\x1b[33mCloning repository...\x1b[0m\r\n');
                        execSync(`git clone "${repoUrl}" "${repoPath}"`, { 
                            cwd: userRootFolder, 
                            env: userEnv,
                            stdio: 'pipe'
                        });
                        socket.emit('output', '\x1b[32mRepository cloned successfully!\x1b[0m\r\n');
                    } catch (e) {
                        socket.emit('output', `\x1b[31mFailed to clone repo: ${e.message}\x1b[0m\r\n`);
                    }
                }
            }
            
            const dockerBackend = TERMINAL_BACKEND === 'docker';
            if (dockerBackend && (typeof process.getuid !== 'function' || process.getuid() === 0)) {
                socket.emit('output', '\r\n\x1b[31mDocker terminal service must run as a non-root Linux user.\x1b[0m\r\n');
                return;
            }

            const shellExecutable = dockerBackend ? 'docker' : BASH_EXECUTABLE;
            const shellArguments = dockerBackend ? [
                'run', '--rm', '--interactive', '--tty',
                '--network=none',
                '--memory=512m', '--cpus=0.5', '--pids-limit=128',
                '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                '--user', `${process.getuid()}:${process.getgid()}`,
                '--mount', `type=bind,src=${workingDir},dst=/workspace`,
                '--workdir=/workspace',
                '--env=HOME=/workspace', '--env=TERM=xterm-256color',
                DOCKER_TERMINAL_IMAGE, '/bin/bash', '--noprofile', '--norc'
            ] : ['--norc', '--noprofile'];

            try {
                ptyProcess = pty.spawn(shellExecutable, shellArguments, {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 30,
                    cwd: workingDir,
                    env: userEnv
                });
            } catch (error) {
                socket.emit('output', `\r\n\x1b[31mFailed to start shell: ${error.message}\x1b[0m\r\n`);
                return;
            }

            activeTerminals.set(socket.id, ptyProcess);
            activeTerminalOwners.set(socket.id, currentUsername);

            ptyProcess.onData((data) => {
                socket.emit('output', data);
            });

            ptyProcess.onExit(() => {
                socket.emit('output', '\r\n\x1b[33mTerminal session ended.\x1b[0m\r\n');
                activeTerminals.delete(socket.id);
                activeTerminalOwners.delete(socket.id);
                ptyProcess = null;
            });

            setTimeout(() => {
                if (ptyProcess) {
                    ptyProcess.write('export PS1="\\[\\033[32m\\]$ \\[\\033[0m\\]"\r');
                    ptyProcess.write('clear\r');
                }
            }, 100);
        }
    });

    socket.on('input', async (data) => {
        if (!ptyProcess || typeof data !== 'string') return;
        await loadUsers();
        const userDetails = users.find(user => user.username === currentUsername);
        if (!userDetails || await checkUserExpiry(userDetails) || userDetails.is_locked) {
            ptyProcess.kill();
            ptyProcess = null;
            socket.emit('output', '\r\n\x1b[31mAccount expired or locked. Renew your plan to continue.\x1b[0m\r\n');
            return;
        }
        ptyProcess.write(data);
    });

    socket.on('resize', (size) => {
        if (ptyProcess && size.cols && size.rows) {
            try {
                ptyProcess.resize(size.cols, size.rows);
            } catch (e) {
                console.error("Resize error:", e.message);
            }
        }
    });

    socket.on('kill_term', () => {
        if (ptyProcess) {
            ptyProcess.write('\x03');
        }
    });

    socket.on('disconnect', () => {
        if (ptyProcess) {
            ptyProcess.kill();
            activeTerminals.delete(socket.id);
            activeTerminalOwners.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
    await connectUserStore();
    startTelegramBot();
    loadInstances();
    loadOrders();
    await checkAllUsersExpiry();
    setInterval(() => {
        checkAllUsersExpiry().catch(() => console.error('Account expiry check failed.'));
    }, 60 * 1000);
    server.listen(PORT, '0.0.0.0', () => console.log(`KuRuMi-Host running on port ${PORT}`));
}

startServer().catch(() => {
    console.error('KuRuMi-Host startup failed. Check MONGODB_URI and database network access.');
    process.exitCode = 1;
});
