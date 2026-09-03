// 声优库方案 C「悬浮铅笔 + Popover 编辑卡」守卫（2026-09-03）
//
// 用户定稿：替换 09-02 上线的方案 A（点击单元格即编辑 / contenteditable）。
// 核心思路（用户原话）：
//   · 表格永远干净（无 contenteditable），阅读优先
//   · hover 行 → 铅笔淡入；点击 → popover 卡片浮在行旁边
//   · 卡片内 2 列 grid 表单，地点 / 录音棚分开输入
//   · 点卡片外部自动关闭，Esc 也可关闭
//   · 类似 Notion / Linear 的编辑体验
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = path.join(ROOT, 'preview-声优库-精修版.html');
const DEPLOY = path.join(ROOT, 'deploy', 'frontend', 'preview-声优库-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');

// ---------- 1. 表格回归纯只读 ----------
test('表格单元格不得再带 contenteditable', () => {
  assert.doesNotMatch(SRC, /contenteditable="true"/, '方案 C 要求表格永远干净，阅读优先');
});

test('移除方案 A 遗留的就地编辑事件链', () => {
  // 旧实现靠 tbody 的 focusout / dblclick 提交，方案 C 不再需要
  assert.doesNotMatch(SRC, /tbody\.addEventListener\('focusout'/, '不应再有就地编辑的 focusout 提交');
  assert.doesNotMatch(SRC, /td\.closest\('td\.ed'\)/, '不应再按 td.ed 捕获编辑目标');
});

// ---------- 2. 无按钮 · 点击整行打开编辑卡 ----------
// 2026-09-03 四次定稿（用户原话）：「悬浮的时候不要出现编辑卡片，
// 点击该行的时候再出现对应的编辑卡片信息」。hover 只做行高亮预示，
// 真正开卡改为 click 触发 —— 更可控，不会误弹。
test('铅笔按钮已完全下线', () => {
  assert.doesNotMatch(SRC, /row-edit-btn/, '不得再有铅笔按钮类');
  assert.doesNotMatch(SRC, /rowEditFloat/, '不得再有浮层铅笔单例');
  assert.doesNotMatch(SRC, /rowEditBtn/, '单元格生成器不得再接收铅笔参数');
  assert.doesNotMatch(SRC, /has-row-edit/, '不得再给列留铅笔位');
});

test('hover 不得弹卡，只做行高亮', () => {
  assert.doesNotMatch(SRC, /ROW_HOVER_OPEN_DELAY/, 'hover 打开延迟已无意义，应移除');
  assert.doesNotMatch(SRC, /function scheduleRowEditor\(/, 'hover 延迟调度应移除');
  // hover 委托保留，但只负责 armed 高亮，不得调用 openRowEditor
  const i1 = SRC.indexOf("tbody.addEventListener('mouseover'");
  assert.ok(i1 > 0, '应保留 mouseover 委托做行高亮');
  // 只截本块（到第一个 }); 为止），避免窗口跨到后面的 click 委托导致误判
  const hoverBlock = SRC.slice(i1, SRC.indexOf("});", i1) + 3);
  assert.doesNotMatch(hoverBlock, /openRowEditor\(/, 'hover 委托不得直接开卡');
  assert.match(hoverBlock, /setArmedRow\(/, 'hover 应只更新 armed 行高亮');
});
test('click 整行才打开编辑卡', () => {
  const i1 = SRC.indexOf("tbody.addEventListener('click'");
  assert.ok(i1 > 0, '应有 click 事件委托');
  const clickBlock = SRC.slice(i1, SRC.indexOf("});", i1) + 3);
  assert.match(clickBlock, /openRowEditor\(/, 'click 应打开编辑卡');
  // 触发资格判定收敛在 shouldOpenRowEditor：分组行 / 角色信息列 / 行内控件一律避让
  const i2 = SRC.indexOf('function shouldOpenRowEditor(');
  assert.ok(i2 > 0, '应有 shouldOpenRowEditor 资格判定');
  const guard = SRC.slice(i2, i2 + 800);
  assert.match(guard, /cat-section/, '分组标题行不得触发');
  assert.match(guard, /casting-cell/, '角色信息列有双击下载，需避让');
  assert.match(guard, /button, a, input, select, textarea/, '行内交互控件需避让');
});

test('编辑卡定位跟随鼠标点击位置', () => {
  assert.match(SRC, /ROW_EDITOR_MOUSE/, '应记录最近鼠标位置供定位使用');
  assert.match(SRC, /clientX/, '应读取鼠标横坐标');
  assert.match(SRC, /clientY/, '应读取鼠标纵坐标');
});

test('再次点击同一行应收起（切换语义）', () => {
  const i0 = SRC.indexOf('function openRowEditor(');
  const block = SRC.slice(i0, i0 + 700);
  assert.match(block, /ROW_EDITOR\.rid === id/, '应判断是否点的是同一行');
  assert.match(block, /dismissRowEditor|closeRowEditor/, '同行再点应关闭');
});

test('点击开卡不得被「点空白清筛选」误伤', () => {
  // 行本身带 data-rid，已在 isBlankAreaClick 的排除清单内；卡片同样需排除
  const i0 = SRC.indexOf('function isBlankAreaClick(');
  const block = SRC.slice(i0, i0 + 2000);
  assert.match(block, /row-editor-pop/, '编辑卡不得被判为空白');
  assert.match(block, /data-rid/, '数据行不得被判为空白');
});

// ---------- 3. Popover 编辑卡 ----------
test('编辑卡为 2 列 grid 表单', () => {
  assert.match(SRC, /\.row-editor-pop\b/, '应有 popover 容器类');
  assert.match(SRC, /\.rep-grid\{[^}]*grid-template-columns:repeat\(2,/, '表单应为 2 列 grid');
});

test('地点与录音棚拆成独立输入框', () => {
  const i0 = SRC.indexOf('function openRowEditor(');
  const block = SRC.slice(i0, SRC.indexOf('\nasync function saveRowEditor(', i0));
  // 字段名通过 field(label, f, val) 传入，断言 4 个独立调用而非渲染后的 data-f 字面量
  ['cn_location', 'cn_studio', 'en_location', 'en_studio'].forEach(f => {
    assert.match(block, new RegExp(`'${f}'`), `应有独立的 ${f} 输入`);
  });
  // 不得再出现方案 A 的复合字段
  assert.doesNotMatch(block, /loc_studio_(cn|en)/, '不得沿用「地点·录音棚」复合字段');
  assert.match(SRC, /data-f="\$\{f\}"/, '输入框应带 data-f 标记字段名');
});

test('编辑卡含角色中英名与中英声优字段', () => {
  const i0 = SRC.indexOf('function openRowEditor(');
  const block = SRC.slice(i0, SRC.indexOf('\nasync function saveRowEditor(', i0));
  ['role_cn', 'role_en', 'cn_va', 'en_va'].forEach(f => {
    assert.match(block, new RegExp(`'${f}'`), `应含 ${f} 输入`);
  });
});

test('编辑卡头部显示大类徽章与角色名，保存/取消双按钮', () => {
  assert.match(SRC, /class="rep-head"/, '应有卡片头部');
  assert.match(SRC, /saveRowEditor\(/, '应有保存动作');
  assert.match(SRC, /closeRowEditor\(/, '应有取消/关闭动作');
});

test('点击模式下关闭逻辑已简化，无需 hover 冻结与静默', () => {
  // 卡片只因用户点击而出现，不会「关掉后自己弹回来」，所以 hover 时代的
  // ROW_HOVER_SUPPRESS_RID / ROW_HOVER_MUTE_UNTIL 两套补丁必须一并移除，避免死代码。
  assert.doesNotMatch(SRC, /ROW_HOVER_SUPPRESS_RID/, 'hover 冻结标记应移除');
  assert.doesNotMatch(SRC, /ROW_HOVER_MUTE_UNTIL/, '全局静默期应移除');
  assert.match(SRC, /function dismissRowEditor\(\)/, '主动关闭统一走无参 dismissRowEditor');
  const i0 = SRC.indexOf('function dismissRowEditor()');
  const block = SRC.slice(i0, i0 + 300);
  assert.match(block, /closeRowEditor\(\)/, '应移除卡片');
  assert.match(block, /setArmedRow\(null\)/, '应清掉行高亮');
});

// ---------- 4. 关闭交互 ----------
test('点外部与 Esc 均可关闭编辑卡', () => {
  assert.match(SRC, /'Escape'[\s\S]{0,300}dismissRowEditor/, 'Esc 应关闭');
  assert.match(SRC, /addEventListener\('mousedown'[\s\S]{0,400}dismissRowEditor/, '点卡片外部应关闭');
  assert.match(SRC, /function isWithinRowEditZone\(/, '当前编辑行与卡片本身不算「外部」');
});

test('编辑卡打开时点空白不触发清筛选', () => {
  const i0 = SRC.indexOf('function isBlankAreaClick(');
  const block = SRC.slice(i0, i0 + 2000);
  assert.match(block, /row-editor-pop|row-edit-btn/, '编辑卡与铅笔不得被判为空白');
});

// ---------- 5. 落库链路复用，不得重写 ----------
test('保存走既有 saveCellEdits 直写 DB 链路', () => {
  const i0 = SRC.indexOf('function saveRowEditor(');
  assert.ok(i0 > 0, '应存在 saveRowEditor');
  const block = SRC.slice(i0, SRC.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /saveCellEdits\(/, '应复用既有落库层，避免另开一套写入逻辑');
});

test('保存前校验角色中文名非空且不重复', () => {
  const i0 = SRC.indexOf('function saveRowEditor(');
  const block = SRC.slice(i0, SRC.indexOf('\nfunction ', i0 + 10));
  assert.match(block, /role_cn/, '应校验 role_cn');
  assert.match(block, /重复|dup/, '应保留重名校验');
});

// ---------- 6. deploy 副本一致 ----------
test('deploy 副本与根权威文件一致', () => {
  assert.ok(fs.existsSync(DEPLOY), 'deploy 副本应存在');
  assert.equal(fs.readFileSync(DEPLOY, 'utf8'), SRC, '根文件与 deploy 副本必须一致');
});
