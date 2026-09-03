// 方案 B 守卫：分享面板「发送」→ 唤起企业微信客户端（wxwork:// URL Scheme）
// 契约要点：
//   1. 唤起前必须先把摘要写进剪贴板（scheme 属非官方写法，失效时用户仍能手动粘贴）
//   2. 单选「个人」且该人配置了企微账号 → 直达其聊天窗；群聊 / 多选 / 无账号 → 仅唤起客户端
//   3. 唤起失败（未安装客户端 / 协议被拦截）必须显式提示，禁止静默失败
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'vo-manager-refined.html');
const MIRROR = path.join(__dirname, '..', '..', 'frontend', 'vo-manager-refined.html');
const SRC = fs.readFileSync(ROOT, 'utf8');

const has = (re, message) => assert.ok(re.test(SRC), message);

// ---------- URL 构造 ----------
test('提供 wxwork scheme 构造函数，个人直达 / 其他仅唤起', () => {
  has(/function buildWecomLaunchUrl\(targets\)/, '应提供 scheme 构造函数');
  has(/wxwork:\/\/message\?username=/, '单个人应拼 username 直达聊天窗');
  has(/return 'wxwork:\/\/'/, '群聊 / 多选 / 无账号应降级为仅唤起客户端');
});

test('scheme 构造函数可被抽取执行，且行为符合三档口径', () => {
  const i0 = SRC.indexOf('function buildWecomLaunchUrl(targets)');
  assert.ok(i0 > -1, '应能定位 buildWecomLaunchUrl');
  const i1 = SRC.indexOf('\nfunction ', i0 + 10);
  const block = SRC.slice(i0, i1 > i0 ? i1 : undefined);
  const buildWecomLaunchUrl = new Function(block + '\nreturn buildWecomLaunchUrl;')();

  // 单选个人 + 有企微账号 → 直达
  assert.equal(
    buildWecomLaunchUrl([{ kind: 'person', wecomId: 'bojackgguan' }]),
    'wxwork://message?username=bojackgguan'
  );
  // 单选个人但没配企微账号 → 只唤起客户端，不能拼出空 username
  assert.equal(buildWecomLaunchUrl([{ kind: 'person', wecomId: '' }]), 'wxwork://');
  // 群聊无法通过 scheme 定位会话 → 只唤起客户端
  assert.equal(buildWecomLaunchUrl([{ kind: 'group', id: 'g-vomi-pm' }]), 'wxwork://');
  // 多选 → 只唤起客户端
  assert.equal(
    buildWecomLaunchUrl([
      { kind: 'person', wecomId: 'a' },
      { kind: 'person', wecomId: 'b' }
    ]),
    'wxwork://'
  );
  // 空输入安全降级
  assert.equal(buildWecomLaunchUrl([]), 'wxwork://');
  assert.equal(buildWecomLaunchUrl(null), 'wxwork://');
  // 特殊字符必须转义，防止拼出畸形 scheme
  assert.equal(
    buildWecomLaunchUrl([{ kind: 'person', wecomId: 'a b&c' }]),
    'wxwork://message?username=a%20b%26c'
  );
});

// ---------- 唤起与失败提示 ----------
test('唤起动作独立成函数，并带失败兜底提示', () => {
  has(/function launchWecomClient\(url\)/, '应提供唤起函数');
  has(/visibilitychange/, '应通过页面可见性变化判断是否成功切出');
  has(/未能唤起企业微信/, '唤起失败必须显式提示，不允许静默');
});

test('发送流程：先复制摘要，再唤起客户端', () => {
  const i0 = SRC.indexOf('async function confirmShareSend()');
  assert.ok(i0 > -1, '应能定位 confirmShareSend');
  const block = SRC.slice(i0, i0 + 2400);
  const copyAt = block.indexOf('copyTextToClipboard');
  const launchAt = block.indexOf('launchWecomClient');
  assert.ok(copyAt > -1, '发送流程应复制摘要');
  assert.ok(launchAt > -1, '发送流程应唤起企业微信');
  assert.ok(copyAt < launchAt, '必须先复制摘要再唤起，避免唤起后剪贴板为空');
});

test('联系人条目携带企微账号，来源是 USER_PROFILES.cw 而非臆造', () => {
  has(/wecomId:\s*u\.cw/, '个人联系人应从 USER_PROFILES.cw 取企微账号');
  has(/data-wecom=/, 'picker 条目应把企微账号写入 data 属性供发送时读取');
});

// ---------- 部署副本一致 ----------
test('部署副本与根权威文件保持一致', () => {
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), SRC, 'deploy/frontend 副本必须与根文件一致');
});
