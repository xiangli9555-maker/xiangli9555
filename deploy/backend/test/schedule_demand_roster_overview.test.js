const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', '..', '..', 'preview-录制档期-精修版.html');
const SRC = fs.readFileSync(HTML, 'utf8');
const has = (re, message) => assert.ok(re.test(SRC), message);

test('需求视图包含角色构成堆叠图框架', () => {
  has(/id="demandRosterOverview"/, '应包含概览容器');
  has(/id="demandRosterBar"/, '应包含堆叠条容器');
  has(/id="demandRosterLegend"/, '应包含图例容器');
  has(/角色构成 · 堆叠分布/, '应显示角色构成标题');
  has(/图例可点击筛选/, '应说明图例可点击筛选');
});

test('需求角色构成由真实 voice_estimates 动态渲染', () => {
  has(/function collectDemandRosterStats\(\)/, '应提供角色去重统计函数');
  has(/function renderDemandRosterOverview\(\)/, '应提供概览渲染函数');
  has(/function setDemandRosterCat\(cat\)/, '应提供类别筛选函数');
  has(/ACTOR_STATE\.demandCat/, '应维护需求类别筛选状态');
});

test('需求视图类别筛选基于聚合行 category，不写死演示数据', () => {
  has(/category:\s*categoryOf\(v\)/, '聚合行应携带真实类别');
  has(/ACTOR_STATE\.demandCat !== 'all'/, '需求列表应应用类别筛选');
  assert.equal(/demandRosterLegend[^]*指挥官\s*7[^]*干员\s*21/.test(SRC), false, '不得写死原型人数');
});

test('堆叠图保留六类顺序并支持键盘可达的 button', () => {
  has(/DEMAND_ROSTER_CAT_ORDER\s*=\s*\['指挥官','干员','Boss','AI兵','NPC','AI系统音'\]/, '应保持六类固定顺序');
  has(/class="demand-roster-seg/, '堆叠段应使用 button');
  has(/class="demand-roster-li/, '图例应使用 button');
});
