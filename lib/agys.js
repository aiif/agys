'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync, spawnSync } = require('child_process');

const RESERVED_WORDS = new Set([
  'help', '--help',
  'version', '--version',
  'save', 'login', 'list', 'ls',
  'current', 'use', 'switch', 'next', 'rm', 'doctor'
]);

const VERSION = '0.1.0';

// Exit codes
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_RUNNING = 3;
const EXIT_NO_ACCOUNTS = 4;
const EXIT_TOKEN_ERROR = 5;
const EXIT_NO_AGY = 6;
const EXIT_LOCK_ERROR = 7;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

function printError(msg) {
  process.stderr.write(`agys: ${msg}\n`);
}

function printWarn(msg) {
  process.stderr.write(`agys: ${msg}\n`);
}

function printInfo(msg) {
  process.stderr.write(`agys: ${msg}\n`);
}

function getAgysHome() {
  return process.env.AGYS_HOME || path.join(os.homedir(), '.config', 'agys');
}

function getAgyTokenPath() {
  return process.env.AGYS_AGY_TOKEN || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function getAgyBin() {
  return process.env.AGYS_AGY_BIN || 'agy';
}

function getKeychainService() {
  return process.env.AGYS_KEYCHAIN_SERVICE || 'gemini';
}

function getKeychainAccount() {
  return process.env.AGYS_KEYCHAIN_ACCOUNT || 'antigravity';
}

function ensureDir(dirPath, mode = 0o700) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
  try {
    fs.chmodSync(dirPath, mode);
  } catch (_) {}
}

function findAgyBin() {
  const custom = process.env.AGYS_AGY_BIN;
  if (custom) {
    if (path.isAbsolute(custom) || custom.includes(path.sep)) {
      try {
        fs.accessSync(custom, fs.constants.X_OK);
        return custom;
      } catch (_) {
        return null;
      }
    }
    // Search in PATH
    return findInPath(custom);
  }
  return findInPath('agy');
}

function findInPath(binName) {
  const envPath = process.env.PATH || '';
  const delimiter = path.delimiter;
  const dirs = envPath.split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, binName);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        try {
          fs.accessSync(fullPath, fs.constants.X_OK);
          return fullPath;
        } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

function validateAccountName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name.startsWith('.') || name.startsWith('-')) return false;
  if (name.includes('/') || name.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function slugifyEmail(email) {
  if (!email || typeof email !== 'string') {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `account-${ts}`;
  }
  const prefix = email.split('@')[0].toLowerCase();
  let slug = prefix.replace(/[^a-z0-9._-]/g, '-');
  slug = slug.replace(/^[-.]+|[-.]+$/g, '');
  if (!slug || !validateAccountName(slug)) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `account-${ts}`;
  }
  return slug;
}

function parseToken(raw) {
  if (!raw) return null;
  const str = typeof raw === 'string' ? raw : raw.toString('utf8');
  let data;
  try {
    data = JSON.parse(str);
  } catch (err) {
    throw new Error('Invalid JSON');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Token payload is not an object');
  }
  if (!data.token || typeof data.token !== 'object') {
    throw new Error('Token object missing');
  }
  if (!data.token.access_token || typeof data.token.access_token !== 'string') {
    throw new Error('access_token missing or not a string');
  }
  if (!data.token.refresh_token || typeof data.token.refresh_token !== 'string') {
    throw new Error('refresh_token missing or not a string');
  }

  // Extract email
  let email = data.id_token_email || null;
  if (!email && data.id_token && typeof data.id_token === 'string') {
    try {
      const parts = data.id_token.split('.');
      if (parts.length >= 2) {
        const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(payloadJson);
        if (payload && payload.email) {
          email = payload.email;
        }
      }
    } catch (_) {}
  }
  if (email) {
    data.id_token_email = email;
  }

  return data;
}

// macOS Keychain support
function readKeychain(service, account) {
  service = service || getKeychainService();
  account = account || getKeychainAccount();

  let stdout;
  try {
    stdout = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    return null;
  }

  const trimmed = stdout.trim();
  if (!trimmed) return null;

  // Try raw JSON
  try {
    const data = parseToken(trimmed);
    return { raw: trimmed, data, format: 'raw' };
  } catch (_) {}

  // Try quoted JSON: "{\"token\":...}"
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const unquoted = JSON.parse(trimmed);
      const data = parseToken(unquoted);
      return { raw: trimmed, data, format: 'quoted' };
    } catch (_) {}
  }

  // Try base64
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    const data = parseToken(decoded);
    return { raw: trimmed, data, format: 'base64' };
  } catch (_) {}

  return null;
}

function writeKeychain(rawBytesOrStr, targetFormat, service, account) {
  service = service || getKeychainService();
  account = account || getKeychainAccount();

  const str = typeof rawBytesOrStr === 'string' ? rawBytesOrStr : rawBytesOrStr.toString('utf8');
  let valueToWrite = str;
  if (targetFormat === 'base64') {
    valueToWrite = Buffer.from(str, 'utf8').toString('base64');
  }

  // security add-generic-password -U -s ... -a ... -w ...
  execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', valueToWrite], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

function isDarwinPlatform() {
  return process.platform === 'darwin' || process.env.AGYS_MOCK_DARWIN === '1';
}

function readToken(customPath) {
  const tokenPath = customPath || getAgyTokenPath();
  let fileContent = null;
  let fileExists = false;

  try {
    if (fs.existsSync(tokenPath)) {
      fileExists = true;
      // agy may be rewriting, retry up to 3 times (50ms interval) on invalid JSON
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fileContent = fs.readFileSync(tokenPath, 'utf8');
          parseToken(fileContent);
          break; // successfully parsed
        } catch (err) {
          if (attempt < 2) {
            sleepSync(50);
          } else {
            // Still fails after 3 tries
            throw new Error(`Token file at ${tokenPath} is corrupt or invalid JSON: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    throw err;
  }

  let keychainResult = null;
  if (isDarwinPlatform()) {
    keychainResult = readKeychain();
  }

  if (!fileExists && !keychainResult) {
    return null;
  }

  if (fileExists && !keychainResult) {
    const data = parseToken(fileContent);
    return {
      raw: fileContent,
      data,
      path: tokenPath,
      divergent: false,
      keychainResult: null,
      source: 'file',
    };
  }

  if (!fileExists && keychainResult) {
    return {
      raw: keychainResult.raw,
      data: keychainResult.data,
      path: tokenPath,
      divergent: false,
      keychainResult,
      source: 'keychain',
    };
  }

  // Both file and keychain exist
  const fileData = parseToken(fileContent);
  const kcData = keychainResult.data;

  const fileEmail = fileData.id_token_email;
  const kcEmail = kcData.id_token_email;

  if (fileEmail && kcEmail && fileEmail !== kcEmail) {
    // Identity divergent
    return {
      raw: fileContent,
      data: fileData,
      path: tokenPath,
      divergent: true,
      keychainResult,
      source: 'file',
    };
  }

  // Same email, compare expiry
  let chosenRaw = fileContent;
  let chosenData = fileData;
  let source = 'file';

  const fileExpiry = fileData.token && fileData.token.expiry ? new Date(fileData.token.expiry).getTime() : 0;
  const kcExpiry = kcData.token && kcData.token.expiry ? new Date(kcData.token.expiry).getTime() : 0;

  if (kcExpiry > fileExpiry) {
    // Keychain has fresher expiry
    chosenRaw = keychainResult.raw;
    chosenData = kcData;
    source = 'keychain';
  }

  return {
    raw: chosenRaw,
    data: chosenData,
    path: tokenPath,
    divergent: false,
    keychainResult,
    source,
  };
}

function writeToken(tokenPath, rawContent) {
  // Validate before writing
  parseToken(rawContent);

  const str = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf8');
  let targetPath = tokenPath;
  try {
    targetPath = fs.realpathSync(tokenPath);
  } catch (_) {
    targetPath = tokenPath;
  }

  const dir = path.dirname(targetPath);
  ensureDir(dir, 0o700);

  const tmpPath = path.join(dir, `token.tmp.${process.pid}.${Date.now()}`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, str, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch (_) {}

    fs.renameSync(tmpPath, targetPath);

    try {
      fs.chmodSync(targetPath, 0o600);
    } catch (_) {}

    // Best-effort fsync dir
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {}
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw err;
  }
}

// Config and Account Store
function loadConfig() {
  const agysHome = getAgysHome();
  const configPath = path.join(agysHome, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        if (!Array.isArray(data.order)) data.order = [];
        if (!data.version) data.version = 1;
        return data;
      }
    } catch (_) {}
  }
  return { version: 1, order: [], last: null };
}

function saveConfig(config) {
  const agysHome = getAgysHome();
  ensureDir(agysHome, 0o700);
  const configPath = path.join(agysHome, 'config.json');
  const tmpPath = path.join(agysHome, `config.tmp.${process.pid}.${Date.now()}`);

  const str = JSON.stringify(config, null, 2);
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  fs.writeFileSync(fd, str, 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
  fs.renameSync(tmpPath, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch (_) {}
}

function listAccounts() {
  const agysHome = getAgysHome();
  const accountsDir = path.join(agysHome, 'accounts');
  ensureDir(accountsDir, 0o700);

  const config = loadConfig();
  let modifiedConfig = false;

  const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
  const diskAccountNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Check for accounts on disk not in config.order
  for (const name of diskAccountNames) {
    if (!config.order.includes(name)) {
      config.order.push(name);
      modifiedConfig = true;
      printWarn(`discovered unindexed account '${name}', added to order`);
    }
  }

  if (modifiedConfig) {
    saveConfig(config);
  }

  const results = [];
  for (const name of config.order) {
    const accDir = path.join(accountsDir, name);
    const tokenFile = path.join(accDir, 'token.json');
    const metaFile = path.join(accDir, 'meta.json');

    if (!fs.existsSync(accDir)) {
      continue;
    }

    let meta = null;
    if (fs.existsSync(metaFile)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      } catch (_) {}
    }

    let validToken = false;
    let tokenData = null;
    if (fs.existsSync(tokenFile)) {
      try {
        const raw = fs.readFileSync(tokenFile, 'utf8');
        tokenData = parseToken(raw);
        validToken = true;
      } catch (_) {}
    }

    results.push({
      name,
      email: (meta && meta.email) || (tokenData && tokenData.id_token_email) || 'unknown',
      expiry: (meta && meta.expiry) || (tokenData && tokenData.token && tokenData.token.expiry) || null,
      auth_method: (meta && meta.auth_method) || (tokenData && tokenData.auth_method) || 'consumer',
      valid: validToken,
      meta,
    });
  }

  return { accounts: results, order: config.order, last: config.last };
}

function getCurrentAccount() {
  let currentToken;
  try {
    currentToken = readToken();
  } catch (e) {
    return { name: null, email: null, status: 'corrupt', error: e.message, divergent: false };
  }

  if (!currentToken) {
    return { name: null, email: null, status: 'empty', divergent: false };
  }

  const email = currentToken.data.id_token_email;
  const refreshToken = currentToken.data.token && currentToken.data.token.refresh_token;

  const agysHome = getAgysHome();
  const accountsDir = path.join(agysHome, 'accounts');
  const { accounts } = listAccounts();

  // 1. Match by email
  const emailMatches = accounts.filter((a) => a.email && email && a.email.toLowerCase() === email.toLowerCase());

  if (emailMatches.length === 1) {
    return {
      name: emailMatches[0].name,
      email: emailMatches[0].email,
      status: 'saved',
      divergent: currentToken.divergent,
      token: currentToken,
    };
  }

  if (emailMatches.length > 1) {
    // 2. Match by refresh_token
    const tokenMatches = [];
    for (const match of emailMatches) {
      const tokenFile = path.join(accountsDir, match.name, 'token.json');
      try {
        const raw = fs.readFileSync(tokenFile, 'utf8');
        const parsed = parseToken(raw);
        if (parsed.token && parsed.token.refresh_token === refreshToken) {
          tokenMatches.push(match);
        }
      } catch (_) {}
    }

    if (tokenMatches.length === 1) {
      return {
        name: tokenMatches[0].name,
        email: tokenMatches[0].email,
        status: 'saved',
        divergent: currentToken.divergent,
        token: currentToken,
      };
    }

    // 3. Newest updated_at
    const candidateList = tokenMatches.length > 0 ? tokenMatches : emailMatches;
    let newest = candidateList[0];
    let newestTime = newest.meta && newest.meta.updated_at ? new Date(newest.meta.updated_at).getTime() : 0;

    for (let i = 1; i < candidateList.length; i++) {
      const t = candidateList[i].meta && candidateList[i].meta.updated_at ? new Date(candidateList[i].meta.updated_at).getTime() : 0;
      if (t > newestTime) {
        newest = candidateList[i];
        newestTime = t;
      }
    }

    return {
      name: newest.name,
      email: newest.email,
      status: 'saved',
      divergent: currentToken.divergent,
      token: currentToken,
    };
  }

  // No match
  return {
    name: null,
    email: email || null,
    status: 'unsaved',
    divergent: currentToken.divergent,
    token: currentToken,
  };
}

// Lock protocols
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireSwitchLock() {
  const agysHome = getAgysHome();
  const stateDir = path.join(agysHome, 'state');
  ensureDir(stateDir, 0o700);

  const lockPath = path.join(stateDir, 'switch.lock');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const data = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
      fs.writeFileSync(fd, data, 'utf8');
      fs.closeSync(fd);
      try { fs.chmodSync(lockPath, 0o600); } catch (_) {}
      return lockPath;
    } catch (e) {
      if (e.code === 'EEXIST') {
        let lockInfo = null;
        try {
          lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch (_) {}

        if (lockInfo && lockInfo.pid) {
          if (isPidAlive(lockInfo.pid)) {
            printError(`another agy/agys session is currently running (PID ${lockInfo.pid} holds switch lock)`);
            process.exit(EXIT_RUNNING);
          }
        }
        // Dead PID: unlink stale lock and retry
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {}
      } else {
        printError(`failed to acquire switch lock: ${e.message}`);
        process.exit(EXIT_LOCK_ERROR);
      }
    }
  }

  printError('failed to acquire switch lock after cleaning stale lock');
  process.exit(EXIT_LOCK_ERROR);
}

function releaseSwitchLock() {
  const agysHome = getAgysHome();
  const lockPath = path.join(agysHome, 'state', 'switch.lock');
  try {
    if (fs.existsSync(lockPath)) {
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lockInfo && lockInfo.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (_) {}
}

function acquireStateLock() {
  const agysHome = getAgysHome();
  const stateDir = path.join(agysHome, 'state');
  ensureDir(stateDir, 0o700);
  const lockPath = path.join(stateDir, 'state.lock');

  const maxAttempts = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const data = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
      fs.writeFileSync(fd, data, 'utf8');
      fs.closeSync(fd);
      try { fs.chmodSync(lockPath, 0o600); } catch (_) {}
      return lockPath;
    } catch (e) {
      if (e.code === 'EEXIST') {
        let lockInfo = null;
        try {
          lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch (_) {}

        if (lockInfo && lockInfo.pid) {
          if (!isPidAlive(lockInfo.pid)) {
            try { fs.unlinkSync(lockPath); } catch (_) {}
            continue;
          }
        }
        sleepSync(50);
      } else {
        printError(`failed to acquire state lock: ${e.message}`);
        process.exit(EXIT_LOCK_ERROR);
      }
    }
  }

  printError('timeout acquiring state lock');
  process.exit(EXIT_LOCK_ERROR);
}

function releaseStateLock() {
  const agysHome = getAgysHome();
  const lockPath = path.join(agysHome, 'state', 'state.lock');
  try {
    if (fs.existsSync(lockPath)) {
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lockInfo && lockInfo.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (_) {}
}

function withStateLock(fn) {
  acquireStateLock();
  try {
    return fn();
  } finally {
    releaseStateLock();
  }
}

// Run markers
function registerRun(pid, account) {
  const agysHome = getAgysHome();
  const runsDir = path.join(agysHome, 'state', 'runs');
  ensureDir(runsDir, 0o700);

  const markerPath = path.join(runsDir, `${pid}.json`);
  const data = JSON.stringify({ pid, started_at: new Date().toISOString(), account: account || null });
  const fd = fs.openSync(markerPath, 'wx', 0o600);
  fs.writeFileSync(fd, data, 'utf8');
  fs.closeSync(fd);
  try { fs.chmodSync(markerPath, 0o600); } catch (_) {}
}

function unregisterRun(pid) {
  const agysHome = getAgysHome();
  const markerPath = path.join(agysHome, 'state', 'runs', `${pid}.json`);
  try {
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch (_) {}
}

function getProcessAncestors(pid) {
  const ancestors = new Set();
  ancestors.add(pid);
  let cur = pid;
  while (cur > 1) {
    try {
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${cur}/stat`, 'utf8');
        const parts = stat.split(')');
        if (parts.length >= 2) {
          const fields = parts[1].trim().split(/\s+/);
          const ppid = parseInt(fields[1], 10);
          if (ppid > 0 && !ancestors.has(ppid)) {
            ancestors.add(ppid);
            cur = ppid;
            continue;
          }
        }
      }
      break;
    } catch (_) {
      break;
    }
  }
  return ancestors;
}

function getRunningSessions() {
  const agysHome = getAgysHome();
  const runsDir = path.join(agysHome, 'state', 'runs');
  ensureDir(runsDir, 0o700);

  const runningPids = [];

  // Check state/runs/*.json
  const files = fs.readdirSync(runsDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const markerPath = path.join(runsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (data && data.pid) {
        if (isPidAlive(data.pid) && data.pid !== process.pid) {
          runningPids.push(data.pid);
        } else {
          // Stale marker
          try { fs.unlinkSync(markerPath); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // Check running agy via ps unless skipped
  if (process.env.AGYS_SKIP_RUNNING_CHECK !== '1') {
    try {
      const output = execFileSync('ps', ['-axo', 'user=,pid=,comm=,args='], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });

      const currentUsername = (os.userInfo && os.userInfo().username) || null;
      const currentUid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
      const ancestors = getProcessAncestors(process.pid);

      const lines = output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tokens = trimmed.split(/\s+/);
        if (tokens.length < 3) continue;

        const user = tokens[0];
        const pid = parseInt(tokens[1], 10);
        const comm = tokens[2];
        const argsStr = tokens.slice(3).join(' ');

        if (isNaN(pid)) continue;
        if (ancestors.has(pid)) continue;

        // Check if same user
        const isUserMatch = (currentUsername && user === currentUsername) || (currentUid && user === currentUid);
        if (!isUserMatch) continue;

        const commBase = path.basename(comm);
        const firstArgBase = tokens[3] ? path.basename(tokens[3]) : '';

        if (commBase === 'agy' || firstArgBase === 'agy') {
          if (!runningPids.includes(pid)) {
            runningPids.push(pid);
          }
        }
      }
    } catch (_) {}
  }

  return runningPids;
}

function assertNoRuns() {
  const runningPids = getRunningSessions();
  if (runningPids.length > 0) {
    printError(`detected running agy/agys session (PID: ${runningPids.join(', ')}). Please exit active agy sessions first.`);
    process.exit(EXIT_RUNNING);
  }
}

function cleanupOldLoginDirs() {
  const agysHome = getAgysHome();
  const stateDir = path.join(agysHome, 'state');
  if (!fs.existsSync(stateDir)) return;

  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('login-')) {
      const fullPath = path.join(stateDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < oneDayAgo) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  }
}

// Account capture and installation
function findExistingNameForEmail(email, refreshToken, accounts) {
  if (!email) return null;
  const matches = accounts.filter((a) => a.email && a.email.toLowerCase() === email.toLowerCase());
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].name;

  // Multiple accounts with same email, check refresh_token
  const agysHome = getAgysHome();
  for (const m of matches) {
    const tokenFile = path.join(agysHome, 'accounts', m.name, 'token.json');
    try {
      const parsed = parseToken(fs.readFileSync(tokenFile, 'utf8'));
      if (parsed.token && parsed.token.refresh_token === refreshToken) {
        return m.name;
      }
    } catch (_) {}
  }
  return matches[0].name;
}

function generateUniqueName(preferredName, accounts) {
  const existingNames = new Set(accounts.map((a) => a.name));
  let candidate = preferredName;
  if (!existingNames.has(candidate)) {
    return candidate;
  }
  let index = 2;
  while (existingNames.has(`${preferredName}-${index}`)) {
    index++;
  }
  return `${preferredName}-${index}`;
}

function captureCurrent(options = {}) {
  const { preferredName, exitOnCorrupt = false } = options;
  const tokenPath = getAgyTokenPath();
  let currentToken;

  try {
    currentToken = readToken(tokenPath);
  } catch (err) {
    if (exitOnCorrupt) {
      printError(`current token is corrupt: ${err.message}`);
      process.exit(EXIT_TOKEN_ERROR);
    }
    // Warn and backup raw bytes to state/previous-token.json
    printWarn(`current token is corrupt: ${err.message}. Backing up to state/previous-token.json`);
    try {
      if (fs.existsSync(tokenPath)) {
        const raw = fs.readFileSync(tokenPath);
        const agysHome = getAgysHome();
        const stateDir = path.join(agysHome, 'state');
        ensureDir(stateDir, 0o700);
        const prevPath = path.join(stateDir, 'previous-token.json');
        fs.writeFileSync(prevPath, raw, { mode: 0o600 });
        try { fs.chmodSync(prevPath, 0o600); } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  if (!currentToken || !currentToken.raw) {
    return null;
  }

  const { accounts } = listAccounts();
  const config = loadConfig();
  const email = currentToken.data.id_token_email;
  const refreshToken = currentToken.data.token && currentToken.data.token.refresh_token;

  let name = findExistingNameForEmail(email, refreshToken, accounts);
  let isNew = false;

  if (!name) {
    isNew = true;
    let baseName = preferredName;
    if (baseName && !validateAccountName(baseName)) {
      baseName = null;
    }
    if (!baseName) {
      baseName = slugifyEmail(email);
    }
    name = generateUniqueName(baseName, accounts);
    if (!config.order.includes(name)) {
      config.order.push(name);
    }
  }

  const agysHome = getAgysHome();
  const accountDir = path.join(agysHome, 'accounts', name);
  ensureDir(accountDir, 0o700);

  const tokenFile = path.join(accountDir, 'token.json');
  const metaFile = path.join(accountDir, 'meta.json');

  const nowIso = new Date().toISOString();
  let savedAt = nowIso;
  if (fs.existsSync(metaFile)) {
    try {
      const prevMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (prevMeta && prevMeta.saved_at) {
        savedAt = prevMeta.saved_at;
      }
    } catch (_) {}
  }

  const meta = {
    name,
    email: email || 'unknown',
    auth_method: currentToken.data.auth_method || 'consumer',
    saved_at: savedAt,
    updated_at: nowIso,
    expiry: (currentToken.data.token && currentToken.data.token.expiry) || null,
  };

  // Write token.json (0600)
  const tmpToken = path.join(accountDir, `token.tmp.${process.pid}.${Date.now()}`);
  const fd1 = fs.openSync(tmpToken, 'wx', 0o600);
  const rawStr = typeof currentToken.raw === 'string' ? currentToken.raw : currentToken.raw.toString('utf8');
  fs.writeFileSync(fd1, rawStr, 'utf8');
  fs.fsyncSync(fd1);
  fs.closeSync(fd1);
  try { fs.chmodSync(tmpToken, 0o600); } catch (_) {}
  fs.renameSync(tmpToken, tokenFile);
  try { fs.chmodSync(tokenFile, 0o600); } catch (_) {}

  // Write meta.json (0600)
  const tmpMeta = path.join(accountDir, `meta.tmp.${process.pid}.${Date.now()}`);
  const fd2 = fs.openSync(tmpMeta, 'wx', 0o600);
  fs.writeFileSync(fd2, JSON.stringify(meta, null, 2), 'utf8');
  fs.fsyncSync(fd2);
  fs.closeSync(fd2);
  try { fs.chmodSync(tmpMeta, 0o600); } catch (_) {}
  fs.renameSync(tmpMeta, metaFile);
  try { fs.chmodSync(metaFile, 0o600); } catch (_) {}

  saveConfig(config);

  return { name, raw: rawStr, data: currentToken.data, isNew };
}

function installAccount(name, previousRaw) {
  const agysHome = getAgysHome();
  const accountDir = path.join(agysHome, 'accounts', name);
  const tokenFile = path.join(accountDir, 'token.json');

  if (!fs.existsSync(tokenFile)) {
    printError(`account '${name}' does not exist or has no token`);
    process.exit(EXIT_TOKEN_ERROR);
  }

  let rawBytes;
  let targetData;
  try {
    rawBytes = fs.readFileSync(tokenFile, 'utf8');
    targetData = parseToken(rawBytes);
  } catch (err) {
    printError(`target account '${name}' token is corrupt: ${err.message}`);
    process.exit(EXIT_TOKEN_ERROR);
  }

  // Backup previous token
  if (previousRaw) {
    const stateDir = path.join(agysHome, 'state');
    ensureDir(stateDir, 0o700);
    const prevFile = path.join(stateDir, 'previous-token.json');
    const tmpPrev = path.join(stateDir, `previous.tmp.${process.pid}.${Date.now()}`);
    const fd = fs.openSync(tmpPrev, 'wx', 0o600);
    const prevStr = typeof previousRaw === 'string' ? previousRaw : previousRaw.toString('utf8');
    fs.writeFileSync(fd, prevStr, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    try { fs.chmodSync(tmpPrev, 0o600); } catch (_) {}
    fs.renameSync(tmpPrev, prevFile);
    try { fs.chmodSync(prevFile, 0o600); } catch (_) {}
  }

  // macOS Keychain transaction
  let keychainUpdated = false;
  let prevKeychainRaw = null;
  let prevKeychainFormat = 'raw';

  if (isDarwinPlatform()) {
    const existingKc = readKeychain();
    const shouldWriteKc = existingKc !== null || process.env.AGYS_KEYCHAIN_WRITE === '1';

    if (shouldWriteKc) {
      if (existingKc) {
        prevKeychainRaw = existingKc.raw;
        prevKeychainFormat = existingKc.format;
      }
      try {
        writeKeychain(rawBytes, prevKeychainFormat);
        keychainUpdated = true;
      } catch (kcErr) {
        printError(`failed to write macOS Keychain: ${kcErr.message}`);
        process.exit(EXIT_TOKEN_ERROR);
      }
    }
  }

  // Write file atomically
  const tokenPath = getAgyTokenPath();
  try {
    writeToken(tokenPath, rawBytes);
  } catch (fileErr) {
    // Rollback Keychain if updated
    if (keychainUpdated && prevKeychainRaw !== null) {
      try {
        writeKeychain(prevKeychainRaw, prevKeychainFormat);
      } catch (rbErr) {
        printError(`failed to rollback macOS Keychain after token file write error: ${rbErr.message}. Keychain and file may be divergent!`);
      }
    }
    printError(`failed to write token file: ${fileErr.message}`);
    process.exit(EXIT_TOKEN_ERROR);
  }

  // Update config.last
  const config = loadConfig();
  config.last = name;
  saveConfig(config);

  // macOS verification
  if (isDarwinPlatform()) {
    const updatedKc = readKeychain();
    if (updatedKc) {
      const targetEmail = targetData.id_token_email;
      const targetRefresh = targetData.token && targetData.token.refresh_token;
      const kcEmail = updatedKc.data.id_token_email;
      const kcRefresh = updatedKc.data.token && updatedKc.data.token.refresh_token;

      if (targetEmail && kcEmail && targetEmail !== kcEmail) {
        printError('verification failed: Keychain email does not match target account');
        process.exit(EXIT_TOKEN_ERROR);
      }
      if (targetRefresh && kcRefresh && targetRefresh !== kcRefresh) {
        printError('verification failed: Keychain refresh token does not match target account');
        process.exit(EXIT_TOKEN_ERROR);
      }
    }
  }

  return targetData;
}

function snapshotRealAuth() {
  const tokenPath = getAgyTokenPath();
  let fileContent = null;
  if (fs.existsSync(tokenPath)) {
    try {
      fileContent = fs.readFileSync(tokenPath, 'utf8');
    } catch (_) {}
  }

  let keychainContent = null;
  if (isDarwinPlatform()) {
    keychainContent = readKeychain();
  }

  return {
    fileContent,
    tokenPath,
    keychainContent,
  };
}

function writeBackRealAuth(snapshot) {
  if (!snapshot) return;

  if (snapshot.fileContent !== null) {
    try {
      writeToken(snapshot.tokenPath, snapshot.fileContent);
    } catch (e) {
      printError(`failed to restore token file: ${e.message}`);
    }
  }

  if (isDarwinPlatform() && snapshot.keychainContent) {
    try {
      writeKeychain(snapshot.keychainContent.raw, snapshot.keychainContent.format);
    } catch (e) {
      printError(`failed to restore Keychain: ${e.message}`);
    }
  }
}

// Subcommands implementations
function cmdSave(args) {
  if (args.length > 1) {
    printError("unexpected arguments for 'save'. Usage: agys save [NAME]");
    process.exit(EXIT_USAGE);
  }

  let preferredName = null;
  if (args.length === 1) {
    preferredName = args[0];
    if (!validateAccountName(preferredName)) {
      printError(`invalid account name '${preferredName}'. Allowed characters: [A-Za-z0-9._-], cannot start with . or -`);
      process.exit(EXIT_USAGE);
    }
  }

  let result;
  withStateLock(() => {
    result = captureCurrent({ preferredName, exitOnCorrupt: true });
    if (!result) {
      printError('no current token found. Please run agy and log in first.');
      process.exit(EXIT_TOKEN_ERROR);
    }
  });

  const email = (result.data && result.data.id_token_email) || 'unknown';
  printInfo(`saved account '${result.name}' <${email}>`);
}

function cmdList(args) {
  if (args.length > 0) {
    printError("unexpected arguments for 'list'. Usage: agys list");
    process.exit(EXIT_USAGE);
  }

  const current = getCurrentAccount();
  const { accounts } = listAccounts();

  if (accounts.length === 0) {
    process.stdout.write('No saved accounts.\n');
    return;
  }

  for (const acc of accounts) {
    const isCurrent = current.status === 'saved' && current.name === acc.name;
    const marker = isCurrent ? '*' : ' ';
    const emailStr = acc.email || 'unknown';
    const expiryStr = acc.expiry ? `(expires: ${acc.expiry})` : '';
    process.stdout.write(`${marker} ${acc.name.padEnd(20)} <${emailStr}> ${expiryStr}\n`);
  }
}

function cmdCurrent(args) {
  if (args.length > 0) {
    printError("unexpected arguments for 'current'. Usage: agys current");
    process.exit(EXIT_USAGE);
  }

  const current = getCurrentAccount();
  if (current.divergent) {
    printWarn('warning: identity divergence detected between token file and macOS Keychain!');
  }

  if (current.status === 'saved') {
    process.stdout.write(`${current.name} <${current.email}>\n`);
  } else if (current.status === 'unsaved') {
    const emailStr = current.email ? ` <${current.email}>` : '';
    process.stdout.write(`unsaved${emailStr}\n`);
  } else if (current.status === 'corrupt') {
    printError(`current token is corrupt: ${current.error}`);
    process.exit(EXIT_TOKEN_ERROR);
  } else {
    process.stdout.write('unsaved\n');
  }
}

function cmdUse(args) {
  if (args.length !== 1) {
    printError("usage: agys use NAME (or agys switch NAME)");
    process.exit(EXIT_USAGE);
  }

  const targetName = args[0];
  if (!validateAccountName(targetName)) {
    printError(`invalid account name '${targetName}'`);
    process.exit(EXIT_USAGE);
  }

  acquireSwitchLock();
  try {
    assertNoRuns();
    let current;
    withStateLock(() => {
      current = captureCurrent({ exitOnCorrupt: false });
      installAccount(targetName, current ? current.raw : null);
    });

    const agysHome = getAgysHome();
    const metaPath = path.join(agysHome, 'accounts', targetName, 'meta.json');
    let email = 'unknown';
    if (fs.existsSync(metaPath)) {
      try {
        email = JSON.parse(fs.readFileSync(metaPath, 'utf8')).email || 'unknown';
      } catch (_) {}
    }

    printInfo(`now using ${targetName} <${email}>`);
  } finally {
    releaseSwitchLock();
  }
}

function cmdRm(args) {
  let force = false;
  const names = [];

  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg.startsWith('-')) {
      printError(`unknown option '${arg}' for 'rm'`);
      process.exit(EXIT_USAGE);
    } else {
      names.push(arg);
    }
  }

  if (names.length !== 1) {
    printError("usage: agys rm NAME [--force]");
    process.exit(EXIT_USAGE);
  }

  const targetName = names[0];
  const current = getCurrentAccount();
  const isCurrent = current.status === 'saved' && current.name === targetName;

  if (isCurrent && !force) {
    printError(`cannot delete current active account '${targetName}' without --force`);
    process.exit(EXIT_USAGE);
  }

  const agysHome = getAgysHome();
  const accDir = path.join(agysHome, 'accounts', targetName);

  if (!fs.existsSync(accDir)) {
    printError(`account '${targetName}' not found`);
    process.exit(EXIT_USAGE);
  }

  withStateLock(() => {
    fs.rmSync(accDir, { recursive: true, force: true });
    const config = loadConfig();
    config.order = config.order.filter((n) => n !== targetName);
    if (config.last === targetName) {
      config.last = config.order.length > 0 ? config.order[0] : null;
    }
    saveConfig(config);
  });

  if (isCurrent) {
    printInfo(`account snapshot '${targetName}' deleted. The real token remains active. agys current will now show 'unsaved'.`);
  } else {
    printInfo(`account '${targetName}' removed`);
  }
}

function cmdNext(subArgs) {
  let noRun = false;
  let agyArgs = [];
  let foundDashDash = false;

  for (let i = 0; i < subArgs.length; i++) {
    if (foundDashDash) {
      agyArgs.push(subArgs[i]);
    } else if (subArgs[i] === '--') {
      foundDashDash = true;
    } else if (subArgs[i] === '--no-run') {
      noRun = true;
    } else {
      printError(`invalid argument for 'next': ${subArgs[i]}. Arguments for agy must be placed after '--'.`);
      process.exit(EXIT_USAGE);
    }
  }

  acquireSwitchLock();
  let nextAccount = null;
  let currentRaw = null;

  try {
    assertNoRuns();
    withStateLock(() => {
      const current = captureCurrent({ exitOnCorrupt: false });
      currentRaw = current ? current.raw : null;

      const { accounts, order, last } = listAccounts();
      if (order.length === 0) {
        printError('no saved accounts found');
        process.exit(EXIT_NO_ACCOUNTS);
      }

      const start = (current && current.name) || last;
      let candidates = [];

      if (start && order.includes(start)) {
        const startIdx = order.indexOf(start);
        for (let i = 1; i <= order.length; i++) {
          candidates.push(order[(startIdx + i) % order.length]);
        }
      } else {
        candidates = [...order];
      }

      const agysHome = getAgysHome();
      for (const candName of candidates) {
        const tokenFile = path.join(agysHome, 'accounts', candName, 'token.json');
        try {
          if (fs.existsSync(tokenFile)) {
            const raw = fs.readFileSync(tokenFile, 'utf8');
            parseToken(raw);
            nextAccount = candName;
            break;
          }
        } catch (_) {
          printWarn(`skipping ${candName}: token corrupt`);
        }
      }

      if (!nextAccount) {
        printError('no valid accounts available to switch to');
        process.exit(EXIT_TOKEN_ERROR);
      }

      installAccount(nextAccount, currentRaw);
    });

    const agysHome = getAgysHome();
    const metaPath = path.join(agysHome, 'accounts', nextAccount, 'meta.json');
    let email = 'unknown';
    if (fs.existsSync(metaPath)) {
      try {
        email = JSON.parse(fs.readFileSync(metaPath, 'utf8')).email || 'unknown';
      } catch (_) {}
    }

    if (process.env.AGYS_QUIET !== '1' && (noRun || process.stderr.isTTY)) {
      printInfo(`switched to ${nextAccount} <${email}>`);
    }

    if (noRun) {
      releaseSwitchLock();
      process.exit(EXIT_OK);
    }

    // Launch agy with agyArgs while holding switch lock until process spawned
    spawnAgy(agyArgs, { lockHeld: true, accountName: nextAccount });
  } catch (err) {
    releaseSwitchLock();
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdLogin(args) {
  cleanupOldLoginDirs();

  if (args.length > 1) {
    printError("unexpected arguments for 'login'. Usage: agys login [NAME]");
    process.exit(EXIT_USAGE);
  }

  let preferredName = null;
  if (args.length === 1) {
    preferredName = args[0];
    if (!validateAccountName(preferredName)) {
      printError(`invalid account name '${preferredName}'. Allowed characters: [A-Za-z0-9._-], cannot start with . or -`);
      process.exit(EXIT_USAGE);
    }
  }

  const agyBin = findAgyBin();
  if (!agyBin) {
    printError(`agy executable not found. Please install agy or set AGYS_AGY_BIN.`);
    process.exit(EXIT_NO_AGY);
  }

  acquireSwitchLock();
  let tempHomeDir = null;
  let loginBaseDir = null;
  let realBefore = null;

  try {
    assertNoRuns();

    let current = null;
    withStateLock(() => {
      current = captureCurrent({ exitOnCorrupt: true });
    });

    realBefore = snapshotRealAuth();

    const agysHome = getAgysHome();
    const stateDir = path.join(agysHome, 'state');
    loginBaseDir = path.join(stateDir, `login-${process.pid}-${Date.now()}`);
    tempHomeDir = path.join(loginBaseDir, 'home');
    const tempGeminiDir = path.join(tempHomeDir, '.gemini', 'antigravity-cli');

    ensureDir(loginBaseDir, 0o700);
    ensureDir(tempHomeDir, 0o700);
    ensureDir(tempGeminiDir, 0o700);

    // Copy installation_id if real exists
    const realGeminiDir = path.dirname(getAgyTokenPath());
    const realInstallationId = path.join(realGeminiDir, 'installation_id');
    if (fs.existsSync(realInstallationId)) {
      try {
        fs.copyFileSync(realInstallationId, path.join(tempGeminiDir, 'installation_id'));
      } catch (_) {}
    }

    const tempTokenPath = path.join(tempGeminiDir, 'antigravity-oauth-token');
    const loginPrompt = process.env.AGYS_LOGIN_PROMPT || '/login';
    const timeoutMs = parseInt(process.env.AGYS_LOGIN_TIMEOUT, 10) || 300000;

    let childInterrupted = false;
    let signalReceived = null;

    const child = spawn(agyBin, ['-p', loginPrompt], {
      env: { ...process.env, HOME: tempHomeDir },
      stdio: 'inherit',
    });

    const onSigInt = () => {
      childInterrupted = true;
      signalReceived = 'SIGINT';
      try { child.kill('SIGINT'); } catch (_) {}
    };
    const onSigTerm = () => {
      childInterrupted = true;
      signalReceived = 'SIGTERM';
      try { child.kill('SIGTERM'); } catch (_) {}
    };

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);

    const startTime = Date.now();
    let newTokenRaw = null;
    let childExited = false;
    let childExitCode = null;

    child.on('close', (code) => {
      childExited = true;
      childExitCode = code;
    });

    // Poll loop
    while (Date.now() - startTime < timeoutMs) {
      if (childInterrupted) {
        break;
      }

      // Check temp token
      if (fs.existsSync(tempTokenPath)) {
        try {
          const raw = fs.readFileSync(tempTokenPath, 'utf8');
          parseToken(raw);
          newTokenRaw = raw;
          break;
        } catch (_) {}
      }

      // On macOS, also check if Keychain changed relative to realBefore
      if (isDarwinPlatform()) {
        const currentKc = readKeychain();
        if (currentKc && (!realBefore.keychainContent || currentKc.raw !== realBefore.keychainContent.raw)) {
          try {
            newTokenRaw = currentKc.raw;
            break;
          } catch (_) {}
        }
      }

      if ((childExited || !isPidAlive(child.pid)) && !newTokenRaw) {
        // Child exited without producing token
        break;
      }

      const pollMs = parseInt(process.env.AGYS_LOGIN_POLL_INTERVAL, 10) || 50;
      await sleep(pollMs);
    }

    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);

    if (newTokenRaw && (!childExited && isPidAlive(child.pid))) {
      // Child produced token, wait for it to exit up to 3s, then terminate
      const exitWaitStart = Date.now();
      while ((!childExited && isPidAlive(child.pid)) && Date.now() - exitWaitStart < 3000) {
        await sleep(50);
      }
      if (!childExited && isPidAlive(child.pid)) {
        try { child.kill('SIGTERM'); } catch (_) {}
        const termWaitStart = Date.now();
        while ((!childExited && isPidAlive(child.pid)) && Date.now() - termWaitStart < 2000) {
          await sleep(50);
        }
        if (!childExited && isPidAlive(child.pid)) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }
      // Re-read token in case agy updated it on exit
      if (fs.existsSync(tempTokenPath)) {
        try {
          const freshRaw = fs.readFileSync(tempTokenPath, 'utf8');
          parseToken(freshRaw);
          newTokenRaw = freshRaw;
        } catch (_) {}
      }
    }

    if (!newTokenRaw || childInterrupted) {
      // Failed / timed out / interrupted
      // Rollback real auth if modified
      const currentReal = snapshotRealAuth();
      if (currentReal.fileContent !== realBefore.fileContent ||
          (isDarwinPlatform() && currentReal.keychainContent?.raw !== realBefore.keychainContent?.raw)) {
        writeBackRealAuth(realBefore);
        const verified = snapshotRealAuth();
        if (verified.fileContent !== realBefore.fileContent) {
          printError('failed to restore original auth after login abort. Try agys use <NAME> to recover.');
          process.exit(EXIT_TOKEN_ERROR);
        }
      }

      // Cleanup temp
      cleanupDir(loginBaseDir);
      releaseSwitchLock();

      if (signalReceived === 'SIGINT') process.exit(EXIT_SIGINT);
      if (signalReceived === 'SIGTERM') process.exit(EXIT_SIGTERM);

      printError('login failed or timed out; no new credentials received.');
      process.exit(EXIT_TOKEN_ERROR);
    }

    // Success! Save new account B and switch to it
    const parsedNew = parseToken(newTokenRaw);
    const newEmail = parsedNew.id_token_email;
    let targetName = null;

    withStateLock(() => {
      const { accounts } = listAccounts();
      const config = loadConfig();

      const existing = findExistingNameForEmail(newEmail, parsedNew.token && parsedNew.token.refresh_token, accounts);
      if (existing) {
        targetName = existing;
      } else {
        let baseName = preferredName;
        if (!baseName || !validateAccountName(baseName)) {
          baseName = slugifyEmail(newEmail);
        }
        targetName = generateUniqueName(baseName, accounts);

        // Insert B after current account in order
        const currentIdx = current && current.name ? config.order.indexOf(current.name) : -1;
        if (currentIdx >= 0) {
          config.order.splice(currentIdx + 1, 0, targetName);
        } else {
          config.order.push(targetName);
        }
      }

      const accDir = path.join(agysHome, 'accounts', targetName);
      ensureDir(accDir, 0o700);

      const tokenFile = path.join(accDir, 'token.json');
      const metaFile = path.join(accDir, 'meta.json');

      const nowIso = new Date().toISOString();
      const meta = {
        name: targetName,
        email: newEmail || 'unknown',
        auth_method: parsedNew.auth_method || 'consumer',
        saved_at: nowIso,
        updated_at: nowIso,
        expiry: (parsedNew.token && parsedNew.token.expiry) || null,
      };

      const tmpToken = path.join(accDir, `token.tmp.${process.pid}.${Date.now()}`);
      const fd1 = fs.openSync(tmpToken, 'wx', 0o600);
      fs.writeFileSync(fd1, newTokenRaw, 'utf8');
      fs.fsyncSync(fd1);
      fs.closeSync(fd1);
      try { fs.chmodSync(tmpToken, 0o600); } catch (_) {}
      fs.renameSync(tmpToken, tokenFile);
      try { fs.chmodSync(tokenFile, 0o600); } catch (_) {}

      const tmpMeta = path.join(accDir, `meta.tmp.${process.pid}.${Date.now()}`);
      const fd2 = fs.openSync(tmpMeta, 'wx', 0o600);
      fs.writeFileSync(fd2, JSON.stringify(meta, null, 2), 'utf8');
      fs.fsyncSync(fd2);
      fs.closeSync(fd2);
      try { fs.chmodSync(tmpMeta, 0o600); } catch (_) {}
      fs.renameSync(tmpMeta, metaFile);
      try { fs.chmodSync(metaFile, 0o600); } catch (_) {}

      saveConfig(config);

      installAccount(targetName, current ? current.raw : null);
    });

    cleanupDir(loginBaseDir);

    printInfo(`saved new account ${targetName} <${newEmail}>`);
    printInfo(`now using ${targetName} <${newEmail}>`);
  } finally {
    releaseSwitchLock();
    if (loginBaseDir && fs.existsSync(loginBaseDir)) {
      cleanupDir(loginBaseDir);
    }
  }
}

function cleanupDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Truncate files first then attempt rm
    try {
      const walkAndTruncate = (d) => {
        const list = fs.readdirSync(d, { withFileTypes: true });
        for (const item of list) {
          const itemPath = path.join(d, item.name);
          if (item.isDirectory()) {
            walkAndTruncate(itemPath);
          } else {
            try { fs.writeFileSync(itemPath, ''); } catch (_) {}
          }
        }
      };
      walkAndTruncate(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err2) {
      printWarn(`failed to remove temporary directory ${dir}: ${err2.message}`);
    }
  }
}

function cmdDoctor(args) {
  cleanupOldLoginDirs();

  let hasErrors = false;

  process.stdout.write('=== agys Doctor Report ===\n\n');

  // Node & npm
  process.stdout.write(`Node.js version: ${process.version}\n`);
  try {
    const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
    process.stdout.write(`npm version:     ${npmVersion}\n`);
  } catch (_) {
    process.stdout.write('npm version:     not found\n');
  }

  // agy binary
  const agyBin = findAgyBin();
  if (agyBin) {
    process.stdout.write(`agy binary:      ${agyBin}\n`);
    try {
      const agyVersion = execFileSync(agyBin, ['--version'], { encoding: 'utf8' }).trim();
      process.stdout.write(`agy version:     ${agyVersion}\n`);
    } catch (_) {
      process.stdout.write('agy version:     unknown (failed to run agy --version)\n');
    }
  } else {
    process.stdout.write(`agy binary:      NOT FOUND\n`);
    printError('agy binary not found in PATH or AGYS_AGY_BIN');
    process.exit(EXIT_NO_AGY);
  }

  // Token & Accounts
  const tokenPath = getAgyTokenPath();
  process.stdout.write(`Token path:      ${tokenPath}\n`);

  let currentToken = null;
  try {
    currentToken = readToken(tokenPath);
  } catch (e) {
    printError(`token check failed: ${e.message}`);
    hasErrors = true;
  }

  if (currentToken) {
    const email = currentToken.data.id_token_email || 'none';
    const expiry = (currentToken.data.token && currentToken.data.token.expiry) || 'none';
    process.stdout.write(`Active email:    <${email}>\n`);
    process.stdout.write(`Token expiry:    ${expiry}\n`);
  } else {
    process.stdout.write(`Active email:    (no token file)\n`);
  }

  const { accounts } = listAccounts();
  process.stdout.write(`Saved accounts:  ${accounts.length}\n`);

  // History directory
  const geminiDir = path.dirname(tokenPath);
  const convDir = path.join(geminiDir, 'conversations');
  if (fs.existsSync(convDir)) {
    process.stdout.write(`Conversations:   ${convDir} (exists)\n`);
  } else {
    process.stdout.write(`Conversations:   ${convDir} (not found)\n`);
  }

  // Running agy sessions
  const runningSessions = getRunningSessions();
  if (runningSessions.length > 0) {
    process.stdout.write(`Active agy runs: DETECTED (PID: ${runningSessions.join(', ')})\n`);
  } else {
    process.stdout.write('Active agy runs: none\n');
  }

  // macOS Keychain status
  if (isDarwinPlatform()) {
    const kc = readKeychain();
    if (kc) {
      process.stdout.write(`macOS Keychain:  present (<${kc.data.id_token_email || 'unknown'}>)\n`);
      if (currentToken && currentToken.divergent) {
        printError('macOS Keychain identity is divergent from token file!');
        hasErrors = true;
      }
    } else {
      process.stdout.write('macOS Keychain:  no entry found\n');
    }
  }

  if (hasErrors) {
    process.exit(EXIT_TOKEN_ERROR);
  }
  process.exit(EXIT_OK);
}

function printHelp() {
  const helpText = `agys - Seamless multi-account switcher for the Antigravity CLI (agy)

Usage:
  agys [agy args...]         Start agy with current credentials (transparent proxy)
  agys -- <agy args...>      Escape hatch: forward all args verbatim to agy
  agys save [NAME]           Save current agy token as an account snapshot
  agys login [NAME]          Log in to a new agy account via official OAuth and switch
  agys list, agys ls         List all saved accounts and active marker
  agys current               Show active account name and email
  agys use NAME, switch NAME Switch to specified account (does not run agy)
  agys next [--no-run] [-- AGY_ARGS...]
                             Switch to next account and run agy (or --no-run to switch only)
  agys rm NAME [--force]     Remove an account snapshot
  agys doctor                Check environment, accounts, and agy health
  agys help, --help          Show this help message
  agys version, --version    Show agys version

Transparent Proxy Contract:
  - agys passes all arguments to agy verbatim using inherit stdio.
  - Reserved subcommands (${Array.from(RESERVED_WORDS).join(', ')})
    are captured by agys when appearing as the first argument.
  - Use 'agys -- <args...>' to bypass reserved words and forward directly to agy.
  - Proxy mode stdout is reserved exclusively for agy; agys logs only to stderr.
  - agy exit codes and signals (SIGINT -> 130, SIGTERM -> 143) are preserved verbatim.
  - process.cwd() and process.env are preserved; no HOME rewriting in proxy mode.
`;
  process.stdout.write(helpText);
}

function spawnAgy(args, options = {}) {
  const { lockHeld = false, accountName = null } = options;
  const agyBin = findAgyBin();
  if (!agyBin) {
    if (lockHeld) releaseSwitchLock();
    printError(`agy executable not found. Please install agy or set AGYS_AGY_BIN.`);
    process.exit(EXIT_NO_AGY);
  }

  const agysHome = getAgysHome();
  const switchLockPath = path.join(agysHome, 'state', 'switch.lock');

  if (!lockHeld) {
    if (fs.existsSync(switchLockPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(switchLockPath, 'utf8'));
        if (info && info.pid && isPidAlive(info.pid)) {
          printError(`another agy/agys session is switching (PID ${info.pid})`);
          process.exit(EXIT_RUNNING);
        }
      } catch (_) {}
    }
  }

  const currentAcc = accountName || (getCurrentAccount().name || 'unknown');
  registerRun(process.pid, currentAcc);

  if (!lockHeld) {
    if (fs.existsSync(switchLockPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(switchLockPath, 'utf8'));
        if (info && info.pid && isPidAlive(info.pid)) {
          unregisterRun(process.pid);
          printError(`another agy/agys session is switching (PID ${info.pid})`);
          process.exit(EXIT_RUNNING);
        }
      } catch (_) {}
    }
  }

  let child;
  try {
    child = spawn(agyBin, args, {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
    });
  } catch (err) {
    unregisterRun(process.pid);
    if (lockHeld) releaseSwitchLock();
    printError(`failed to spawn agy: ${err.message}`);
    process.exit(EXIT_NO_AGY);
  }

  if (lockHeld) {
    // Release switch lock now that process is spawned and registered
    releaseSwitchLock();
  }

  let sigintReceived = false;
  let sigtermReceived = false;

  const onSigInt = () => {
    sigintReceived = true;
    // Don't kill child; in same process group child already received SIGINT
  };
  const onSigTerm = () => {
    sigtermReceived = true;
    try { child.kill('SIGTERM'); } catch (_) {}
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  child.on('error', (err) => {
    unregisterRun(process.pid);
    printError(`agy process error: ${err.message}`);
    process.exit(EXIT_NO_AGY);
  });

  child.on('close', (code, signal) => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
    unregisterRun(process.pid);

    // Token sync: capture any token refreshed by agy during session
    try {
      withStateLock(() => {
        captureCurrent({ exitOnCorrupt: false });
      });
    } catch (syncErr) {
      printWarn(`failed to sync token after session: ${syncErr.message}`);
    }

    if (signal === 'SIGINT' || sigintReceived) {
      process.exit(EXIT_SIGINT);
    }
    if (signal === 'SIGTERM' || sigtermReceived) {
      process.exit(EXIT_SIGTERM);
    }
    if (code !== null) {
      process.exit(code);
    }
    process.exit(EXIT_OK);
  });
}

async function main(argv) {
  const args = argv || [];

  if (args.length === 0) {
    // agys with no args: launch agy interactively
    spawnAgy([]);
    return;
  }

  const first = args[0];

  // Escape hatch: agys -- <args...>
  if (first === '--') {
    spawnAgy(args.slice(1));
    return;
  }

  // Reserved subcommands check on argv[0]
  if (first === 'help' || first === '--help') {
    printHelp();
    process.exit(EXIT_OK);
  }
  if (first === 'version' || first === '--version') {
    process.stdout.write(`agys v${VERSION}\n`);
    process.exit(EXIT_OK);
  }
  if (first === 'save') {
    cmdSave(args.slice(1));
    return;
  }
  if (first === 'list' || first === 'ls') {
    cmdList(args.slice(1));
    return;
  }
  if (first === 'current') {
    cmdCurrent(args.slice(1));
    return;
  }
  if (first === 'use' || first === 'switch') {
    cmdUse(args.slice(1));
    return;
  }
  if (first === 'rm') {
    cmdRm(args.slice(1));
    return;
  }
  if (first === 'next') {
    cmdNext(args.slice(1));
    return;
  }
  if (first === 'login') {
    await cmdLogin(args.slice(1));
    return;
  }
  if (first === 'doctor') {
    cmdDoctor(args.slice(1));
    return;
  }

  // Non-reserved argument: transparent proxy to agy
  spawnAgy(args);
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).catch((err) => {
    printError(err.message);
    process.exit(EXIT_TOKEN_ERROR);
  });
}

module.exports = {
  main,
  readToken,
  writeToken,
  parseToken,
  readKeychain,
  writeKeychain,
  getAgysHome,
  getAgyTokenPath,
  getAgyBin,
  findAgyBin,
  loadConfig,
  saveConfig,
  listAccounts,
  getCurrentAccount,
  captureCurrent,
  installAccount,
  acquireSwitchLock,
  releaseSwitchLock,
  acquireStateLock,
  releaseStateLock,
  withStateLock,
  registerRun,
  unregisterRun,
  getRunningSessions,
  assertNoRuns,
  cleanupOldLoginDirs,
  validateAccountName,
  slugifyEmail,
  snapshotRealAuth,
  writeBackRealAuth,
  spawnAgy,
  isDarwinPlatform,
  RESERVED_WORDS,
  VERSION,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_RUNNING,
  EXIT_NO_ACCOUNTS,
  EXIT_TOKEN_ERROR,
  EXIT_NO_AGY,
  EXIT_LOCK_ERROR,
  EXIT_SIGINT,
  EXIT_SIGTERM,
};
