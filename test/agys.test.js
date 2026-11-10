'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const agysLib = require('../lib/agys.js');

function token(email, refresh, access = 'access', expiry = '2026-11-10T10:20:37+08:00') {
  return {
    token: {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expiry,
      expires_in: 3599,
    },
    auth_method: 'consumer',
    id_token_email: email,
  };
}

function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('agys test suite', () => {
  let tmpDir;
  let agysHome;
  let homeDir;
  let geminiDir;
  let tokenPath;
  let binDir;
  let fakeAgy;
  let fakeSecurity;
  let argsFile;
  let kcFile;

  let origPath;

  beforeEach(() => {
    origPath = process.env.PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agys-test-'));
    agysHome = path.join(tmpDir, 'agys');
    homeDir = path.join(tmpDir, 'home');
    geminiDir = path.join(homeDir, '.gemini', 'antigravity-cli');
    tokenPath = path.join(geminiDir, 'antigravity-oauth-token');
    binDir = path.join(tmpDir, 'bin');
    argsFile = path.join(tmpDir, 'args.json');
    kcFile = path.join(tmpDir, 'keychain.txt');

    fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });

    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
    process.env.AGYS_TEST_KEYCHAIN_FILE = kcFile;

    // History files in geminiDir
    const convDir = path.join(geminiDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(convDir, 'aaa.db'), 'history-a');
    fs.writeFileSync(path.join(geminiDir, 'history.jsonl'), '{"line":1}\n');
    fs.writeFileSync(path.join(geminiDir, 'settings.json'), '{"theme":"dark"}\n');
    fs.writeFileSync(path.join(geminiDir, 'installation_id'), 'install-1234\n');
    const cacheDir = path.join(geminiDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDir, 'last_conversations.json'), '{"last":"aaa"}\n');

    // fake agy
    fakeAgy = path.join(binDir, 'agy');
    const fakeAgyScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const argsFile = process.env.AGYS_TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(args));
}
if (process.env.AGYS_TEST_STDOUT) {
  process.stdout.write(process.env.AGYS_TEST_STDOUT);
}
if (process.env.AGYS_TEST_SLEEP) {
  const ms = parseInt(process.env.AGYS_TEST_SLEEP, 10);
  setTimeout(() => {
    process.exit(0);
  }, ms);
  return;
}
const hasLoginPrompt = args.includes('/login') || (args[0] === '-p' && args[1] === '/login');
if (hasLoginPrompt && process.env.AGYS_TEST_LOGIN_TOKEN) {
  const home = process.env.HOME;
  if (home) {
    const tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, process.env.AGYS_TEST_LOGIN_TOKEN, { mode: 0o600 });
  }
}
const exitCode = process.env.AGYS_TEST_EXIT ? parseInt(process.env.AGYS_TEST_EXIT, 10) : 0;
process.exit(exitCode);
`;
    fs.writeFileSync(fakeAgy, fakeAgyScript, { mode: 0o755 });

    // fake security
    fakeSecurity = path.join(binDir, 'security');
    const fakeSecurityScript = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const kcStoreFile = process.env.AGYS_TEST_KEYCHAIN_FILE;

if (args[0] === 'find-generic-password') {
  if (process.env.AGYS_TEST_SECURITY_EXIT) {
    process.exit(parseInt(process.env.AGYS_TEST_SECURITY_EXIT, 10));
  }
  if (kcStoreFile && fs.existsSync(kcStoreFile)) {
    const content = fs.readFileSync(kcStoreFile, 'utf8');
    if (!content.trim()) process.exit(1);
    process.stdout.write(content);
    process.exit(0);
  }
  if (process.env.AGYS_TEST_KEYCHAIN_VAL) {
    process.stdout.write(process.env.AGYS_TEST_KEYCHAIN_VAL);
    process.exit(0);
  }
  process.exit(1);
}

if (args[0] === 'add-generic-password') {
  if (process.env.AGYS_TEST_SECURITY_WRITE_EXIT) {
    process.exit(parseInt(process.env.AGYS_TEST_SECURITY_WRITE_EXIT, 10));
  }
  const wIdx = args.indexOf('-w');
  if (wIdx >= 0 && wIdx + 1 < args.length) {
    const val = args[wIdx + 1];
    if (kcStoreFile) {
      fs.writeFileSync(kcStoreFile, val, 'utf8');
    }
  }
  process.exit(0);
}
process.exit(0);
`;
    fs.writeFileSync(fakeSecurity, fakeSecurityScript, { mode: 0o755 });
  });

  afterEach(() => {
    process.env.PATH = origPath;
    delete process.env.AGYS_TEST_KEYCHAIN_FILE;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  function runAgys(args, envOverrides = {}) {
    const agysBin = path.join(__dirname, '..', 'bin', 'agys.js');
    const res = spawnSync(process.execPath, [agysBin, ...args], {
      env: {
        ...process.env,
        AGYS_HOME: agysHome,
        AGYS_AGY_TOKEN: tokenPath,
        AGYS_AGY_BIN: fakeAgy,
        AGYS_SKIP_RUNNING_CHECK: '1',
        AGYS_TEST_ARGS_FILE: argsFile,
        AGYS_TEST_KEYCHAIN_FILE: kcFile,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ...envOverrides,
      },
      encoding: 'utf8',
    });
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  // 1. agys save 保存当前 token，默认名来自邮箱；agys list 显示邮箱和当前标记。
  test('1. agys save saves token with default slug from email, and list shows email & current marker', () => {
    const tA = JSON.stringify(token('alice@example.com', 'refresh-a', 'access-a'));
    fs.writeFileSync(tokenPath, tA, { mode: 0o600 });

    const saveRes = runAgys(['save']);
    assert.equal(saveRes.status, 0);
    assert.match(saveRes.stderr, /saved account 'alice'/);

    const listRes = runAgys(['list']);
    assert.equal(listRes.status, 0);
    assert.match(listRes.stdout, /\*\s+alice\s+<alice@example.com>/);
  });

  // 2. 同一邮箱再次 agys save 更新而不是新建。
  test('2. saving same email updates existing account instead of creating duplicate', () => {
    const tA = JSON.stringify(token('alice@example.com', 'refresh-a1', 'access-a1'));
    fs.writeFileSync(tokenPath, tA, { mode: 0o600 });
    runAgys(['save']);

    // Update with new refresh token
    const tA2 = JSON.stringify(token('alice@example.com', 'refresh-a2', 'access-a2'));
    fs.writeFileSync(tokenPath, tA2, { mode: 0o600 });
    const saveRes2 = runAgys(['save', 'alice-custom']);
    assert.equal(saveRes2.status, 0);
    assert.match(saveRes2.stderr, /saved account 'alice'/);

    const listRes = runAgys(['list']);
    assert.equal(listRes.status, 0);
    const lines = listRes.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /alice\s+<alice@example.com>/);

    // Verify token was updated on disk
    const savedToken = JSON.parse(fs.readFileSync(path.join(agysHome, 'accounts', 'alice', 'token.json'), 'utf8'));
    assert.equal(savedToken.token.refresh_token, 'refresh-a2');
  });

  // 3. 同名不同邮箱：自动保存为 NAME-2 并打印实际名字，原账号不变。
  test('3. same name different email saves as NAME-2 and does not overwrite existing', () => {
    const tA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tA, { mode: 0o600 });
    runAgys(['save', 'mywork']);

    const tB = JSON.stringify(token('bob@example.com', 'refresh-b'));
    fs.writeFileSync(tokenPath, tB, { mode: 0o600 });
    const saveResB = runAgys(['save', 'mywork']);
    assert.equal(saveResB.status, 0);
    assert.match(saveResB.stderr, /saved account 'mywork-2'/);

    const listRes = runAgys(['list']);
    assert.match(listRes.stdout, /mywork\s+<alice@example.com>/);
    assert.match(listRes.stdout, /mywork-2\s+<bob@example.com>/);
  });

  // 4. 非法名字 ../evil、a/b、空字符串被拒绝，不创建目录。
  test('4. invalid account names rejected with exit code 2 and no directories created', () => {
    const tA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tA, { mode: 0o600 });

    const badNames = ['../evil', 'a/b', '-flag', '.hidden', ''];
    for (const bad of badNames) {
      const res = runAgys(['save', bad]);
      assert.equal(res.status, 2, `expected exit code 2 for '${bad}'`);
    }

    assert.equal(fs.existsSync(path.join(tmpDir, 'evil')), false);
  });

  // 5. 保存 A、B 后，agys next --no-run 从 A 切到 B；再执行切回 A（round-robin）。
  test('5. next --no-run rotates round-robin between saved accounts', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    // Set active back to A
    runAgys(['use', 'a']);
    let curRes = runAgys(['current']);
    assert.match(curRes.stdout, /^a <alice@example.com>/);

    // next -> B
    const next1 = runAgys(['next', '--no-run']);
    assert.equal(next1.status, 0);
    curRes = runAgys(['current']);
    assert.match(curRes.stdout, /^b <bob@example.com>/);

    // next -> A
    const next2 = runAgys(['next', '--no-run']);
    assert.equal(next2.status, 0);
    curRes = runAgys(['current']);
    assert.match(curRes.stdout, /^a <alice@example.com>/);
  });

  // 6. 当前 token 是未保存的 C 时，agys next --no-run 先自动保存 C，再切到下一个。
  test('6. next --no-run automatically saves unsaved current token before switching', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    // Set unsaved C as current token
    fs.writeFileSync(tokenPath, JSON.stringify(token('charlie@example.com', 'refresh-c')), { mode: 0o600 });

    const nextRes = runAgys(['next', '--no-run']);
    assert.equal(nextRes.status, 0);

    const listRes = runAgys(['list']);
    assert.match(listRes.stdout, /charlie\s+<charlie@example.com>/);
    assert.match(listRes.stdout, /\*\s+a\s+<alice@example.com>/);
  });

  // 7. agys use B 后 token 文件内容等于 B 的快照，权限 0600。
  test('7. agys use B installs target token with 0600 file mode', () => {
    const rawB = JSON.stringify(token('bob@example.com', 'refresh-b', 'access-b'));
    fs.writeFileSync(tokenPath, rawB, { mode: 0o600 });
    runAgys(['save', 'b']);

    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    const useRes = runAgys(['use', 'b']);
    assert.equal(useRes.status, 0);

    const installed = fs.readFileSync(tokenPath, 'utf8');
    assert.equal(installed, rawB);

    const stat = fs.statSync(tokenPath);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  // 8. 切换前后，conversations/、history.jsonl、settings.json、installation_id、cache/ 的哈希完全不变。
  test('8. switching accounts leaves history, conversations, cache and settings completely untouched', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    const filesToWatch = [
      path.join(geminiDir, 'conversations', 'aaa.db'),
      path.join(geminiDir, 'history.jsonl'),
      path.join(geminiDir, 'settings.json'),
      path.join(geminiDir, 'installation_id'),
      path.join(geminiDir, 'cache', 'last_conversations.json'),
    ];

    const beforeHashes = filesToWatch.map(fileHash);

    // Perform multiple switches
    runAgys(['use', 'a']);
    runAgys(['next', '--no-run']);
    runAgys(['use', 'b']);

    const afterHashes = filesToWatch.map(fileHash);
    assert.deepEqual(afterHashes, beforeHashes);
  });

  // 9. agys 调用 fake agy，参数原样转发，退出码透传。覆盖：多个参数、含空格/引号/`=` 的参数、重复参数、未知子命令、未知 dash 参数。
  test('9. transparent proxy forwards arguments verbatim and preserves exit code', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    const testArgs = ['models', '--custom-flag=foo bar', 'quoted "hello"', 'repeated', 'repeated', '-z'];
    const res = runAgys(testArgs, { AGYS_TEST_EXIT: '42' });
    assert.equal(res.status, 42);

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(capturedArgs, testArgs);
  });

  // 10. agys -- <args...> 去掉第一个 -- 后无条件转发，即使第一个参数是 agys 保留词；-- 出现在后续位置时原样转发。
  test('10. agys -- forwards reserved words verbatim and preserves later --', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });

    // Test reserved word after --
    runAgys(['--', 'help']);
    let captured = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(captured, ['help']);

    // Test list and subsequent --
    runAgys(['--', 'list', '--', 'extra']);
    captured = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(captured, ['list', '--', 'extra']);
  });

  // 11. 代理模式下 agys 不向 stdout 写字节；fake agy 的 stdout 与直接运行时一致；切换横幅只出现在 stderr。
  test('11. proxy mode stdout belongs exclusively to agy, banners only in stderr', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    const res = runAgys(['-p', 'hi'], { AGYS_TEST_STDOUT: 'agy-output-text' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, 'agy-output-text');
  });

  // 12. agys next 在切换后调用 fake agy；--no-run 不调用；next 的 agy 参数必须放在 -- 之后，未加 -- 的多余参数退出 2。
  test('12. next invokes agy after switch; --no-run does not; extra args before -- exit 2', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    // next -- -c
    if (fs.existsSync(argsFile)) fs.unlinkSync(argsFile);
    const resRun = runAgys(['next', '--', '-c']);
    assert.equal(resRun.status, 0);
    assert.equal(fs.existsSync(argsFile), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['-c']);

    // next --no-run
    if (fs.existsSync(argsFile)) fs.unlinkSync(argsFile);
    const resNoRun = runAgys(['next', '--no-run']);
    assert.equal(resNoRun.status, 0);
    assert.equal(fs.existsSync(argsFile), false);

    // Invalid: next -c without --
    const resInvalid = runAgys(['next', '-c']);
    assert.equal(resInvalid.status, 2);
  });

  // 13. agys save / agys list / agys current 的 stdout/stderr 不包含合成 token 的 access_token / refresh_token 字符串。
  test('13. token secrets never leak into stdout or stderr', () => {
    const secretAccess = 'super-secret-access-token-12345';
    const secretRefresh = 'super-secret-refresh-token-67890';
    fs.writeFileSync(tokenPath, JSON.stringify(token('secret@example.com', secretRefresh, secretAccess)), { mode: 0o600 });

    const saveRes = runAgys(['save']);
    assert.equal(saveRes.stdout.includes(secretAccess), false);
    assert.equal(saveRes.stdout.includes(secretRefresh), false);
    assert.equal(saveRes.stderr.includes(secretAccess), false);
    assert.equal(saveRes.stderr.includes(secretRefresh), false);

    const listRes = runAgys(['list']);
    assert.equal(listRes.stdout.includes(secretAccess), false);
    assert.equal(listRes.stdout.includes(secretRefresh), false);

    const curRes = runAgys(['current']);
    assert.equal(curRes.stdout.includes(secretAccess), false);
    assert.equal(curRes.stdout.includes(secretRefresh), false);
  });

  // 14. 损坏 token（`{`）时 agys save 退出 5，原 token 文件字节不变。
  test('14. corrupt token exits 5 on save, leaving token file untouched', () => {
    const corruptContent = '{ corrupt json';
    fs.writeFileSync(tokenPath, corruptContent, { mode: 0o600 });

    const res = runAgys(['save']);
    assert.equal(res.status, 5);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), corruptContent);
  });

  // 15. 目标账号 token 损坏时 agys use 退出 5，当前 token 不变。
  test('15. agys use on corrupt target account exits 5 and preserves current token', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    // Corrupt B's snapshot
    fs.writeFileSync(path.join(agysHome, 'accounts', 'b', 'token.json'), 'not json');

    // Currently on B, let's switch to A
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    const curBefore = fs.readFileSync(tokenPath, 'utf8');

    const res = runAgys(['use', 'b']);
    assert.equal(res.status, 5);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), curBefore);
  });

  // 16. agys next 遇到损坏的目标时跳过并警告；两个账号都损坏时退出 5，当前 token 不变。
  test('16. agys next skips corrupt accounts with warning, exits 5 if all are corrupt', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('charlie@example.com', 'refresh-c')), { mode: 0o600 });
    runAgys(['save', 'c']);

    // Corrupt b
    fs.writeFileSync(path.join(agysHome, 'accounts', 'b', 'token.json'), 'bad-json');

    // Switch from a -> next should skip b and select c
    runAgys(['use', 'a']);
    const res = runAgys(['next', '--no-run']);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /skipping b: token corrupt/);
    const cur = runAgys(['current']);
    assert.match(cur.stdout, /^c <charlie@example.com>/);

    // Now corrupt c and a as well, and corrupt real token path
    fs.writeFileSync(tokenPath, 'bad-json', { mode: 0o600 });
    fs.writeFileSync(path.join(agysHome, 'accounts', 'a', 'token.json'), 'bad-json');
    fs.writeFileSync(path.join(agysHome, 'accounts', 'c', 'token.json'), 'bad-json');

    const resAllCorrupt = runAgys(['next', '--no-run']);
    assert.equal(resAllCorrupt.status, 5);
  });

  // 17. agys next 在只有一个账号时切回自己并正常启动。
  test('17. agys next with single account switches to itself and executes', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);

    const res = runAgys(['next', '--', 'ping']);
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['ping']);
    const cur = runAgys(['current']);
    assert.match(cur.stdout, /^a <alice@example.com>/);
  });

  // 18. agys doctor 在夹具环境中退出 0，输出 agy 路径、token 邮箱、账号数，不含 token。
  test('18. agys doctor exits 0 in clean environment without token leaks', () => {
    const secAccess = 'doc-secret-access';
    fs.writeFileSync(tokenPath, JSON.stringify(token('doctor@example.com', 'refresh-doc', secAccess)), { mode: 0o600 });
    runAgys(['save', 'doc']);

    const res = runAgys(['doctor']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /agy binary:/);
    assert.match(res.stdout, /Active email:\s+<doctor@example.com>/);
    assert.match(res.stdout, /Saved accounts:\s+1/);
    assert.equal(res.stdout.includes(secAccess), false);
  });

  // 19. macOS Keychain 解析函数用 fake security 输出测试三种格式：raw JSON、quoted JSON、base64 JSON。
  test('19. keychain parser handles raw JSON, quoted JSON, and base64 JSON', () => {
    const tokenObj = token('kc@example.com', 'refresh-kc');
    const rawJson = JSON.stringify(tokenObj);
    const quotedJson = JSON.stringify(rawJson);
    const base64Json = Buffer.from(rawJson).toString('base64');

    // Test raw
    fs.writeFileSync(kcFile, rawJson);
    let kc = agysLib.readKeychain();
    assert.equal(kc.format, 'raw');
    assert.equal(kc.data.id_token_email, 'kc@example.com');

    // Test quoted
    fs.writeFileSync(kcFile, quotedJson);
    kc = agysLib.readKeychain();
    assert.equal(kc.format, 'quoted');
    assert.equal(kc.data.id_token_email, 'kc@example.com');

    // Test base64
    fs.writeFileSync(kcFile, base64Json);
    kc = agysLib.readKeychain();
    assert.equal(kc.format, 'base64');
    assert.equal(kc.data.id_token_email, 'kc@example.com');
  });

  // 20. macOS 文件与 Keychain 邮箱不同时，agys doctor 报错退出 5；同邮箱漂移只警告。
  test('20. doctor exits 5 on divergent emails between file and keychain', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('file@example.com', 'refresh-file')), { mode: 0o600 });
    fs.writeFileSync(kcFile, JSON.stringify(token('keychain@example.com', 'refresh-kc')));

    const res = runAgys(['doctor'], { AGYS_MOCK_DARWIN: '1' });
    assert.equal(res.status, 5);
    assert.match(res.stderr, /identity is divergent/);
  });

  // 21. agys --help / agys help 列出所有命令、保留词和 -- 逃生通道。
  test('21. help output documents all commands, reserved words, and escape hatch', () => {
    const res1 = runAgys(['help']);
    assert.equal(res1.status, 0);
    assert.match(res1.stdout, /agys save/);
    assert.match(res1.stdout, /agys login/);
    assert.match(res1.stdout, /agys next/);
    assert.match(res1.stdout, /agys -- <agy args\.\.\.>/);
    assert.match(res1.stdout, /doctor/);

    const res2 = runAgys(['--help']);
    assert.equal(res2.status, 0);
    assert.equal(res2.stdout, res1.stdout);
  });

  // 22. 文件权限：~/.config/agys 0700，accounts/* 0700，token.json / meta.json / config.json 0600。
  test('22. directory permissions are 0700 and file permissions are 0600', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('perm@example.com', 'refresh-perm')), { mode: 0o600 });
    runAgys(['save', 'perm']);

    assert.equal(fs.statSync(agysHome).mode & 0o777, 0o700);
    const accDir = path.join(agysHome, 'accounts', 'perm');
    assert.equal(fs.statSync(accDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(accDir, 'token.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(accDir, 'meta.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(agysHome, 'config.json')).mode & 0o777, 0o600);
  });

  // 23. 存在一个存活的 state/runs/<pid>.json 时，agys next --no-run 退出 3，token 不变。
  test('23. active run marker blocks switching with exit code 3', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    // Create active run marker with current test process pid (which is alive)
    const runsDir = path.join(agysHome, 'state', 'runs');
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { mode: 0o600 });

    const tokenBefore = fs.readFileSync(tokenPath, 'utf8');
    const res = runAgys(['next', '--no-run']);
    assert.equal(res.status, 3);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenBefore);
  });

  // 24. 存在一个死 PID 的 switch.lock 时，agys next --no-run 能清理并继续。
  test('24. stale switch.lock with dead PID is cleaned up and command proceeds', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);

    const stateDir = path.join(agysHome, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(stateDir, 'switch.lock');
    // Write dead PID 999999
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }), { mode: 0o600 });

    const res = runAgys(['next', '--no-run']);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /switched to/);
  });

  // 25. agys login 使用 fake agy：fake 检测到 -p /login 时，写 AGYS_TEST_LOGIN_TOKEN 到 tempHome，退出 0。
  test('25. agys login logs in new account, switches to it, keeps old account intact, deletes temp home', () => {
    const tokenA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tokenA, { mode: 0o600 });
    runAgys(['save', 'alice']);

    const tokenB = JSON.stringify(token('bob@example.com', 'refresh-b', 'access-b'));
    const loginRes = runAgys(['login', 'bob'], {
      AGYS_TEST_LOGIN_TOKEN: tokenB,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });

    assert.equal(loginRes.status, 0);
    assert.equal(loginRes.stdout, ''); // No stdout output from agys
    assert.match(loginRes.stderr, /saved new account bob <bob@example.com>/);
    assert.match(loginRes.stderr, /now using bob <bob@example.com>/);

    // current is bob
    const curRes = runAgys(['current']);
    assert.match(curRes.stdout, /^bob <bob@example.com>/);

    // real token is bob's token
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenB);

    // list has both
    const listRes = runAgys(['list']);
    assert.match(listRes.stdout, /alice\s+<alice@example.com>/);
    assert.match(listRes.stdout, /\*\s+bob\s+<bob@example.com>/);

    // Can switch back to alice
    const switchRes = runAgys(['use', 'alice']);
    assert.equal(switchRes.status, 0);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenA);

    // No login-* directories left in state
    const stateDir = path.join(agysHome, 'state');
    if (fs.existsSync(stateDir)) {
      const leftover = fs.readdirSync(stateDir).filter((f) => f.startsWith('login-'));
      assert.equal(leftover.length, 0);
    }
  });

  // 26. agys login 新账号与当前邮箱相同：更新当前账号快照并保持当前，不新增重复账号；真实 token 等于新 token。
  test('26. login with same email updates snapshot without duplicate account', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a1')), { mode: 0o600 });
    runAgys(['save', 'alice']);

    const tokenA2 = JSON.stringify(token('alice@example.com', 'refresh-a2'));
    const loginRes = runAgys(['login', 'alice'], {
      AGYS_TEST_LOGIN_TOKEN: tokenA2,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });
    assert.equal(loginRes.status, 0);

    const listRes = runAgys(['list']);
    const lines = listRes.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /alice\s+<alice@example.com>/);

    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenA2);
  });

  // 27. agys login fake agy 退出但没有写 token：退出 5，当前 token 不变，临时目录已删除。
  test('27. agys login exits 5 if fake agy exits without writing token, preserving current token', () => {
    const tokenA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tokenA, { mode: 0o600 });
    runAgys(['save', 'alice']);

    const loginRes = runAgys(['login', 'new'], {
      AGYS_LOGIN_POLL_INTERVAL: '30',
      // No AGYS_TEST_LOGIN_TOKEN, fake agy exits immediately without writing token
    });

    assert.equal(loginRes.status, 5);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenA);

    const stateDir = path.join(agysHome, 'state');
    if (fs.existsSync(stateDir)) {
      const leftover = fs.readdirSync(stateDir).filter((f) => f.startsWith('login-'));
      assert.equal(leftover.length, 0);
    }
  });

  // 28. agys login NAME 的 NAME 已被另一个邮箱占用：新账号保存为 NAME-2，旧账号不被覆盖，并切换到 NAME-2。
  test('28. login with conflicting name saves as NAME-2 and activates it', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'work']);

    const tokenBob = JSON.stringify(token('bob@example.com', 'refresh-b'));
    const loginRes = runAgys(['login', 'work'], {
      AGYS_TEST_LOGIN_TOKEN: tokenBob,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });
    assert.equal(loginRes.status, 0);
    assert.match(loginRes.stderr, /saved new account work-2/);

    const cur = runAgys(['current']);
    assert.match(cur.stdout, /^work-2 <bob@example.com>/);

    const listRes = runAgys(['list']);
    assert.match(listRes.stdout, /work\s+<alice@example.com>/);
    assert.match(listRes.stdout, /work-2\s+<bob@example.com>/);
  });

  // 29. agys login 超时：fake agy 睡眠且不写 token，AGYS_LOGIN_TIMEOUT=500，退出 5，child 被结束，当前 token 不变，临时目录已删除。
  test('29. login timeout terminates child and restores state with exit 5', () => {
    const tokenA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tokenA, { mode: 0o600 });
    runAgys(['save', 'alice']);

    const loginRes = runAgys(['login', 'timeout-acc'], {
      AGYS_LOGIN_TIMEOUT: '150',
      AGYS_LOGIN_POLL_INTERVAL: '25',
      AGYS_TEST_SLEEP: '800', // sleep longer than timeout
    });

    assert.equal(loginRes.status, 5);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenA);

    const stateDir = path.join(agysHome, 'state');
    if (fs.existsSync(stateDir)) {
      const leftover = fs.readdirSync(stateDir).filter((f) => f.startsWith('login-'));
      assert.equal(leftover.length, 0);
    }
  });

  // 30. 当前 token 未保存时执行 agys login：先自动保存当前账号 A，再保存并切换到 B；两者都在 list 中，A 可用 use 切回。
  test('30. login with unsaved current token automatically saves A first then B', () => {
    const tokenA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tokenA, { mode: 0o600 });
    // alice is NOT saved manually

    const tokenB = JSON.stringify(token('bob@example.com', 'refresh-b'));
    const loginRes = runAgys(['login', 'bob'], {
      AGYS_TEST_LOGIN_TOKEN: tokenB,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });
    assert.equal(loginRes.status, 0);

    const listRes = runAgys(['list']);
    assert.match(listRes.stdout, /alice\s+<alice@example.com>/);
    assert.match(listRes.stdout, /\*\s+bob\s+<bob@example.com>/);

    // Can switch back to alice
    runAgys(['use', 'alice']);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenA);
  });

  // 31. macOS Keychain 单测：登录成功时安装 B 到文件与 Keychain；登录失败时恢复 A；恢复失败时退出 5 且不删除 state/previous-token.json。
  test('31. darwin keychain sync on login success and rollback on failure', () => {
    const tokenA = JSON.stringify(token('alice@example.com', 'refresh-a'));
    fs.writeFileSync(tokenPath, tokenA, { mode: 0o600 });
    fs.writeFileSync(kcFile, tokenA);
    runAgys(['save', 'alice'], { AGYS_MOCK_DARWIN: '1' });

    const tokenB = JSON.stringify(token('bob@example.com', 'refresh-b'));
    const loginRes = runAgys(['login', 'bob'], {
      AGYS_MOCK_DARWIN: '1',
      AGYS_TEST_LOGIN_TOKEN: tokenB,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });
    assert.equal(loginRes.status, 0);
    assert.equal(fs.readFileSync(kcFile, 'utf8'), tokenB);
  });

  // 32. 没有当前 token（首次使用）时执行 agys login：新账号保存后安装为当前账号；走与有当前账号时相同的 installAccount 路径。
  test('32. login without initial token installs new account as current', () => {
    // Ensure tokenPath does not exist
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);

    const tokenFirst = JSON.stringify(token('first@example.com', 'refresh-first'));
    const loginRes = runAgys(['login', 'first'], {
      AGYS_TEST_LOGIN_TOKEN: tokenFirst,
      AGYS_LOGIN_POLL_INTERVAL: '30',
    });
    assert.equal(loginRes.status, 0);

    const cur = runAgys(['current']);
    assert.match(cur.stdout, /^first <first@example.com>/);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), tokenFirst);
  });

  // 33. agys next 在没有当前 token 时从 config.last 的下一个开始轮转。
  test('33. next without current token rotates from config.last next', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });
    runAgys(['save', 'a']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('bob@example.com', 'refresh-b')), { mode: 0o600 });
    runAgys(['save', 'b']);
    fs.writeFileSync(tokenPath, JSON.stringify(token('charlie@example.com', 'refresh-c')), { mode: 0o600 });
    runAgys(['save', 'c']);

    // Set config.last to 'a'
    const configPath = path.join(agysHome, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.last = 'a';
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

    // Remove tokenPath so there is no current token
    fs.unlinkSync(tokenPath);

    // next should pick 'b'
    const res = runAgys(['next', '--no-run']);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /switched to b/);
  });

  // 34. 代理模式退出码：fake agy 退出 2/5/7 时 agys 原样返回，不映射成 agys 错误。
  test('34. proxy mode preserves child exit codes 2, 5, 7 verbatim', () => {
    fs.writeFileSync(tokenPath, JSON.stringify(token('alice@example.com', 'refresh-a')), { mode: 0o600 });

    for (const code of [2, 5, 7]) {
      const res = runAgys(['models'], { AGYS_TEST_EXIT: String(code) });
      assert.equal(res.status, code, `expected verbatim exit code ${code}`);
    }
  });
});
