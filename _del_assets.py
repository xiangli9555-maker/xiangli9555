import os, shutil
root = os.path.dirname(os.path.abspath(__file__))
d = os.path.join(root, '_rollback', 'removed_assets_20260819')
os.makedirs(d, exist_ok=True)
for folder in ['.', 'deploy/frontend']:
    fpath = root if folder == '.' else os.path.join(root, folder)
    for fn in os.listdir(fpath):
        if '资产库' in fn and fn.endswith('.html'):
            src = os.path.join(fpath, fn)
            prefix = 'deploy-' if folder != '.' else ''
            dst = os.path.join(d, prefix + fn)
            shutil.move(src, dst)
            print('moved ->', dst)
print('done')
