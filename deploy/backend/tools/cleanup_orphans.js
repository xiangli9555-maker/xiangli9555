// 清理验证过程中产生的孤儿腾讯文档（探针表 + 空壳汇总板确认）。
// 用法: docker exec vo-backend node /app/tools_cleanup_orphans.js
const m = require('/app/src/cw_mcp_client.js');

// 已知孤儿（探针表，来自本轮/上轮验证；空壳板 DTnhEZXhibFZmRWFM 按历史清理记录应已删除，再次调用仅作确认）
const ORPHANS = [
  'NGUAlTEsyyKz', // 本轮 __probe_single_now smartsheet
  'NjfYtTVBrNLD', // 本轮 mcpprobe3 create_file
  'NuzfjYLoYRaF',  // 上轮探针表
  'DTnhEZXhibFZmRWFM', // 空壳 Yang1.0 汇总板（按历史清理记录应已删除，确认）
];

(async () => {
  const cookie = await m.openSession();
  for (const id of ORPHANS) {
    try {
      const r = await m.deleteFile(id, cookie);
      const ok = r && (r.code === 0 || r.ret === 0 || (r.data && !r.data.code) );
      console.log(ok ? 'DELETE_OK  ' : 'DELETE_RSP ', id, JSON.stringify(r).slice(0, 140));
    } catch (e) {
      console.log('DELETE_FAIL', id, (e.message || '').slice(0, 160));
    }
  }
  console.log('CLEANUP_DONE');
})();
