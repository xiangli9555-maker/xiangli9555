import zipfile, os, shutil
root = 'deploy'
out = 'deploy-vo-manager.zip'
if os.path.exists(out):
    os.remove(out)
# 跳过的文件模式（备份、临时诊断、隐藏目录）
def should_skip(dp, fn):
    if fn.startswith('_diag'): return True
    if '.bak' in fn: return True
    if fn.endswith('.removed-20260818'): return True
    if any(part.startswith('.bak') for part in dp.split(os.sep)): return True
    return False

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if should_skip(dp, fn):
                continue
            full = os.path.join(dp, fn)
            if not os.path.exists(full):
                continue
            arc = os.path.join(os.path.basename(root), os.path.relpath(full, root))
            z.write(full, arc)
print('zip created:', out, os.path.getsize(out), 'bytes')
