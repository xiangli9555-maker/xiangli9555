// vadoc.js — 选角资料 Word 导出件(.docx)解析 → 声优库新建表单字段
// 纯 Node 标准库（zlib 解压 + 手工 ZIP 目录解析），无 npm 依赖，可直接跑在预构建镜像里。
// 与 scripts/parse_va_doc.py（本机 CDP+OCR 通路）同一套章节解析逻辑，但输入是干净的 docx 文本。

const zlib = require('zlib');
const { assertZipSafe } = require('./zip_guard');

// ---------------- 最小 ZIP 读取（只取目标文件） ----------------
function readZipEntry(buf, name) {
  // End Of Central Directory 签名 0x06054b50（从尾部找）
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 docx（找不到 ZIP 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const fname = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (fname === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(dataOff, dataOff + compSize);
      if (uncompSize > 25 * 1024 * 1024 || uncompSize / Math.max(1, compSize) > 100) {
        throw Object.assign(new Error('zip_limits_exceeded'), { status: 413 });
      }
      if (method === 0) return comp;
      if (method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: uncompSize || 25 * 1024 * 1024 });
      throw new Error('不支持的压缩方式 ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---------------- docx → 行 ----------------
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function docxToLines(buffer) {
  assertZipSafe(buffer, {
    maxEntries: 2_000,
    maxEntryUncompressed: 25 * 1024 * 1024,
    maxTotalUncompressed: 50 * 1024 * 1024,
    maxCompressionRatio: 100,
  });
  const xmlBuf = readZipEntry(buffer, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 里找不到 word/document.xml');
  let xml = xmlBuf.toString('utf8');
  xml = xml.replace(/<w:tab[^>]*\/>/g, '\t')
           .replace(/<w:br[^>]*\/>/g, '\n')
           .replace(/<\/w:p>/g, '\n');
  xml = xml.replace(/<[^>]+>/g, '');
  xml = decodeEntities(xml);
  return xml.split('\n').map(s => s.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean);
}

// 文档内超链接的真实 URL（显示文本常被截断；rels 里才是完整地址）
function docxLinks(buffer) {
  const relsBuf = readZipEntry(buffer, 'word/_rels/document.xml.rels');
  if (!relsBuf) return [];
  const rels = relsBuf.toString('utf8');
  const map = {};
  const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let m;
  while ((m = re.exec(rels))) {
    const target = decodeEntities(m[2]);
    if (/^https?:/.test(target)) map[m[1]] = target;
  }
  if (!Object.keys(map).length) return [];
  // 按 document.xml 中 w:hyperlink 出现顺序取 r:id → 真实 URL
  const docBuf = readZipEntry(buffer, 'word/document.xml');
  const doc = docBuf ? docBuf.toString('utf8') : '';
  const ids = [];
  const hre = /<w:hyperlink\b[^>]*r:id="([^"]+)"/g;
  while ((m = hre.exec(doc))) ids.push(m[1]);
  const out = [];
  for (const id of ids) {
    const u = map[id];
    if (u && !out.includes(u)) out.push(u);
  }
  // 兜底：hyperlink 没匹配到时，给全部外部链接
  if (!out.length) Object.values(map).forEach(u => { if (!out.includes(u)) out.push(u); });
  return out.filter(u => !/weixin\.qq\.com|docs\.qq\.com/.test(u));
}

// ---------------- 章节解析（与 parse_va_doc.py 同规则） ----------------
const CJK_RE = /[一-鿿]/;
const hasCjk = (s) => CJK_RE.test(s || '');

const SECTION_KEYS = [
  ['info',        ['基础信息', 'INFO']],
  ['background',  ['背景故事', 'BACKGROUND']],
  ['personality', ['性格特征', 'PERSONALITY']],
  ['voice_req',   ['声音要求', 'VOICE REQUIREMENTS']],
  ['audition',    ['试音台词', 'AUDITION']],
  ['references',  ['声音参考', 'REFERENCES']],
];

function splitSections(lines) {
  const secs = { pre: [] };
  let cur = 'pre';
  for (const ln of lines) {
    let hit = null;
    for (const [key, kws] of SECTION_KEYS) {
      if (ln.length < 40 && kws.some(kw => ln.includes(kw))) { hit = key; break; }
    }
    if (hit) { cur = hit; if (!secs[cur]) secs[cur] = []; continue; }
    if (!secs[cur]) secs[cur] = [];
    secs[cur].push(ln);
  }
  return secs;
}

function parseVaDocx(buffer, sourceName) {
  const lines = docxToLines(buffer);
  const links = docxLinks(buffer);
  if (lines.length < 10) throw new Error('文档文本过少（' + lines.length + ' 行），请确认导出的是选角资料 Word');
  const secs = splitSections(lines);
  const f = {};
  const meta = { sections: {}, source: sourceName || '' };
  Object.keys(secs).forEach(k => { meta.sections[k] = secs[k].length; });

  // ---- 标题：分类 + 角色名 ----
  let titleCn = '', titleEn = '';
  for (const ln of secs.pre.slice(0, 14)) {
    if (ln.includes('选角资料') || ln.includes('Casting')) {
      if (hasCjk(ln) && !titleCn) titleCn = ln;
      else if (!hasCjk(ln) && !titleEn) titleEn = ln;
    }
  }
  let num = '', nameCn = '', nameEn = '';
  const m = titleCn.match(/(指挥官|干员|Boss|AI兵|NPC|AI系统音)\s*(\d+)?\s*(.+?)\s*选角资料/);
  if (m) {
    f.category = m[1];
    num = m[2] || '';
    nameCn = m[3].trim();
  } else {
    for (const ln of secs.pre.slice(0, 14)) {
      const mc = ln.match(/(指挥官|干员|Boss|AI兵|NPC|AI系统音)\s*(\d+)?/);
      if (mc) { f.category = mc[1]; num = mc[2] || ''; break; }
    }
    if (!f.category) {
      const mf = titleCn.match(/^员\s*(\d+)/);
      if (mf) { f.category = '干员'; num = mf[1]; }
    }
  }
  const me = titleEn.match(/-\s*([A-Za-z·.\s]+?)\s*Casting/);
  if (me) nameEn = me[1].trim();

  // ---- 基础信息：姓名/Name ----
  const infoLines = secs.info || [];
  const infoTxt = infoLines.join('\n');
  const mn = infoTxt.match(/姓名[/／]Name[：:]\s*(.+)/);
  if (mn) {
    for (const p of mn[1].trim().split(/\s*[/／]\s*/)) {
      if (hasCjk(p) && !nameCn) nameCn = p.trim();
      else if (!hasCjk(p) && !nameEn) nameEn = p.trim();
    }
  }
  f.role_cn = (num && nameCn && !nameCn.startsWith(num)) ? num + nameCn : (nameCn || (num + nameEn));
  f.role_en = nameEn;

  // ---- 性别 ----
  const voiceTxt = (secs.voice_req || []).join('\n') + '\n' + infoTxt;
  if (/女性|女音/.test(voiceTxt)) f.gender = '女';
  else if (/男性|男音/.test(voiceTxt)) f.gender = '男';

  // ---- basic_info / persona ----
  const bi = [];
  if (infoLines.length) { bi.push('【基础信息】'); bi.push(...infoLines); }
  if ((secs.voice_req || []).length) { bi.push('【声音要求】'); bi.push(...secs.voice_req); }
  f.basic_info = bi.join('\n');

  const ps = [];
  if ((secs.background || []).length) { ps.push('【背景故事】'); ps.push(...secs.background); }
  if ((secs.personality || []).length) { ps.push('【性格特征】'); ps.push(...secs.personality); }
  f.persona = ps.join('\n');

  // ---- 试音台词：中英分行 ----
  const cnLines = [], enLines = [];
  for (const ln of (secs.audition || [])) {
    if (/^(个性台词|战斗台词|Character|Combat)/.test(ln)) continue;
    const clean = ln.replace(/^\d+\s*[.、)．]\s*/, '').trim();
    if (!clean) continue;
    (hasCjk(clean) ? cnLines : enLines).push(clean);
  }
  f.lines_cn = cnLines.join('\n');
  f.lines_en = enLines.join('\n');

  // ---- 参考链接：真实 rels URL + 参考条目标题 ----
  const refs = [];
  for (const ln of (secs.references || [])) {
    if (/^(中文|English|ENGLISH|CN|EN)\b/.test(ln) && ln.length < 15) continue;
    if (/https?:/.test(ln)) continue;              // 显示文本里的 URL 常截断，用 rels 的完整 URL 替代
    if (hasCjk(ln)) refs.push(ln);                  // 条目标题（如《无期迷途》卓娅…）
  }
  f.ref_links = refs.concat(links).join('\n');

  f.notes = '';
  f.source_doc_url = sourceName || '';   // 文件导入时存文件名作存档引用
  meta.doc_links = links.length;
  meta.text_lines = lines.length;
  return { fields: f, meta };
}

// ==================== NPC 声线表（多角色）解析 ====================
// 格式特征：无「选角资料/Casting Profile」章节；用 `【类型】角色名 [EN Name]` 或
// `[Category] EN Name` 作为每个 NPC 的锚点行；后接 2-6 行自由描述 + 一行「声线：xxx」。
// 中英双区（前半中文，后半英文以「英文版/EN Version/New NPCs」为分界）。

const CAT_BRACKET = /^【([^】]+)】\s*(.+)$/;
const CAT_SQUARE  = /^\[([^\]]+)\]\s*(.+)$/;

// 类别关键词 → 声优库大类
function guessCategory(bracketTag, roleText) {
  const s = (bracketTag + ' ' + roleText).toLowerCase();
  if (/boss|老大|头目|领袖|leader|godfather|大佬|长官|指挥官|commander|superior/i.test(bracketTag)) return 'Boss';
  if (/干员|operat|special\s*ops|特战/i.test(bracketTag)) return '干员';
  if (/ai|系统音|广播/i.test(bracketTag)) return 'AI系统音';
  if (/ai兵|杂兵|士兵|soldier|grunt|thug|参赛者|contestant|管事|主持人|host|announcer|成员|member|路人/i.test(bracketTag)) return 'NPC';
  return 'NPC';
}

// 从锚点名切出中/英角色名。
// 背景（2026-09-02 修复）：原实现用 `roleCn = txt.replace(/\s+[A-Za-z].*$/, '')`，遇到
// `克劳斯·阿德勒 (Klaus Adler) 代号“钟表匠”` 时，正则会在 "Klaus Adler" 中间的空格处命中
// （空格后紧跟字母 A），把 " Adler) 代号…" 一并吃掉，落库成 `克劳斯·阿德勒 (Klaus` +
// `Klaus Adler)`。这里改为：先摘括号内的纯拉丁段当英文名，再把中文名截到首个拉丁段之前，
// 最后去掉「代号… / Codename…」这类中文尾注。
function splitRoleName(txt) {
  let s = String(txt || '').trim();
  let en = '';
  // 1) 摘括号英文名（半角/全角皆可），括号整体从中文名里移除
  s = s.replace(/[（(]\s*([^）)]{1,80}?)\s*[)）]/g, (all, inner) => {
    const t = inner.trim();
    if (!en && /^[A-Za-z][A-Za-z0-9\.\-·'&,\s]*$/.test(t)) {
      en = t.replace(/\s+/g, ' ').trim();
      return ' ';
    }
    return all;
  });
  s = s.replace(/\s+/g, ' ').trim();
  // 2) 摘尾部拉丁名（含紧贴无空格的情况，如 `卢卡斯Lukas`）；括号里已拿到英文名时不再覆盖
  const lat = s.match(/[A-Za-z][A-Za-z0-9\.\-·'&,\s]*$/);
  if (lat) {
    const t = lat[0].trim();
    s = s.slice(0, lat.index).trim();
    if (!en && t) en = t;
  }
  // 3) 去掉中文尾注（代号 / Codename / 别名 / aka 起，到行尾）
  s = s.replace(/[\s·,，、]*(?:代号|Codename|别名|aka).*$/i, '').trim();
  return { cn: s, en };
}

// 从「声线：22岁；男性；青年；…」/「Voice: Male, 25-35. …」提取性别 + 完整声线描述
function parseVoiceLine(txt) {
  const out = { gender: '', voice_desc: txt };
  if (/女性|女音|female/i.test(txt)) out.gender = '女';
  else if (/男性|男音|\bmale\b/i.test(txt)) out.gender = '男';
  return out;
}

// 拆分 NPC 段：从中/英区各自的锚点开始，直到下一个锚点或区末
function splitNpcBlocks(lines) {
  // 找中英分界
  let enStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^【英文版】|^EN\s*Version$|^English\s*Version$/i.test(lines[i])) { enStart = i; break; }
  }
  const cnLines = lines.slice(0, enStart);
  const enLines = lines.slice(enStart);

  const parseSide = (arr, pattern) => {
    const anchors = [];
    arr.forEach((ln, i) => { if (pattern.test(ln)) anchors.push(i); });
    const blocks = [];
    for (let k = 0; k < anchors.length; k++) {
      const from = anchors[k], to = k + 1 < anchors.length ? anchors[k+1] : arr.length;
      blocks.push({ head: arr[from], body: arr.slice(from + 1, to) });
    }
    return blocks;
  };
  return {
    cn: parseSide(cnLines, CAT_BRACKET),
    en: parseSide(enLines, CAT_SQUARE),
    header: cnLines.slice(0, (parseSide(cnLines, CAT_BRACKET)[0]||{head:''}).head ? cnLines.indexOf((parseSide(cnLines, CAT_BRACKET)[0]||{head:''}).head) : 0)
  };
}

function parseNpcRoster(buffer, sourceName) {
  const lines = docxToLines(buffer);
  const links = docxLinks(buffer);
  const meta = { source: sourceName || '', text_lines: lines.length, doc_links: links.length, mode: 'npc-roster' };

  const { cn, en, header } = splitNpcBlocks(lines);
  if (!cn.length) throw new Error('未识别到任何【类别】角色 锚点，请确认文档格式');

  // 英文块按顺序尝试与中文块一一匹配（相同顺序）
  const characters = cn.map((block, idx) => {
    const m = CAT_BRACKET.exec(block.head);
    const bracket = m ? m[1].trim() : '';
    const rawHead = m ? m[2].trim() : block.head;
    const parsed = splitRoleName(rawHead);
    const roleCn = parsed.cn || rawHead;
    let roleEn = parsed.en;

    // 找同序号的英文块补充
    const enBlock = en[idx];
    let enBody = [];
    if (enBlock) {
      const em = CAT_SQUARE.exec(enBlock.head);
      if (em && !roleEn) roleEn = em[2].replace(/[,—-]\s*(Codename|codename).*/i,'').trim();
      enBody = enBlock.body;
    }
    // 末兜底：头部残留的拉丁段（不再包含收尾括号，避免 `Klaus Adler)`）
    if (!roleEn) {
      const tail = rawHead.match(/[A-Za-z][A-Za-z0-9\.\-·'&,\s]{1,60}/);
      if (tail) roleEn = tail[0].trim();
    }

    // 从中文体里找「声线：xxx」
    const voiceLn = block.body.find(l => /^声线[:：]/.test(l)) || '';
    const { gender, voice_desc } = parseVoiceLine(voiceLn.replace(/^声线[:：]\s*/, ''));

    // basic_info = header 共享背景（前 6 行内）+ voice_desc
    const bi = [];
    if (header.length && idx === 0) { /* 首段可注入共享背景 */ }
    if (voice_desc) bi.push('【声线】' + voice_desc);
    if (enBody.length) {
      const enVoice = enBody.find(l => /^voice(\s*reference)?[:：]/i.test(l));
      if (enVoice) bi.push('【Voice】' + enVoice.replace(/^voice(\s*reference)?[:：]\s*/i, ''));
    }

    // persona = 除声线行外的自由描述（中 + 英）
    const persona = [];
    const cnPersona = block.body.filter(l => !/^声线[:：]/.test(l) && !/^HYPERLINK/i.test(l));
    if (cnPersona.length) { persona.push('【人设 · 中】'); persona.push(...cnPersona); }
    const enPersona = enBody.filter(l => !/^voice(\s*reference)?[:：]/i.test(l) && !/^HYPERLINK/i.test(l));
    if (enPersona.length) { persona.push('【Persona · EN】'); persona.push(...enPersona); }

    // 兄弟俩共享的顶部背景：如果 header 里有非空文本，且当前块 idx==0，把 header 塞进 persona 前
    // 更简单：所有 NPC 都能看到共享 header，但避免重复 → 只给第一段带
    if (idx === 0 && header.length) {
      persona.unshift('【共享背景】');
      header.forEach(h => persona.push(h));
    }

    // 参考链接：本段包含 "HYPERLINK" 或 "中文参考/英文参考/CN ref/EN ref" 的行，配合 rels 里的完整 URL
    // 简化：所有 rels 链接给第一段（用户后续可编辑）
    const refs = idx === 0 ? links.slice() : [];

    return {
      fields: {
        category: 'NPC',       // npc-roster 文档整份视为 NPC；bracket 里的类型词只当作来源标签放到 notes
        role_cn: roleCn,
        role_en: roleEn,
        gender,
        basic_info: bi.join('\n'),
        persona: persona.join('\n'),
        lines_cn: '',           // NPC 表无试音台词
        lines_en: '',
        ref_links: refs.join('\n'),
        notes: bracket ? '来源类别：' + bracket : '',
        source_doc_url: sourceName || ''
      },
      meta: { bracket, voice_line: voiceLn }
    };
  });

  meta.count = characters.length;
  return { characters, meta };
}

// 自动分派：先检测是否是「选角资料/Casting Profile」格式；否则按 NPC 表处理
function parseVaDocxAuto(buffer, sourceName) {
  const lines = docxToLines(buffer);
  const isSingleProfile = lines.slice(0, 15).some(l => /选角资料|Casting\s*Profile/i.test(l));
  if (isSingleProfile) {
    const r = parseVaDocx(buffer, sourceName);
    return { mode: 'single-profile', characters: [r], meta: r.meta };
  }
  return { mode: 'npc-roster', ...parseNpcRoster(buffer, sourceName) };
}

module.exports = { parseVaDocx, parseNpcRoster, parseVaDocxAuto, splitRoleName };
