#!/usr/bin/env python3
"""Rebuild Chrome Web Store assets from store/src + store/raw into store/out.
Requires google-chrome (headless) and Pillow. Run: python3 store/build.py"""
import os, subprocess, tempfile
from PIL import Image
D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(D, 'out'); os.makedirs(OUT, exist_ok=True)
FONT = '"Noto Sans CJK SC","PingFang SC",system-ui,sans-serif'

def shot(html, out, w, h, opaque=True):
    with tempfile.NamedTemporaryFile('w', suffix='.html', dir=D, delete=False) as f:
        f.write(html); p = f.name
    try:
        subprocess.run(['google-chrome', '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', f'--window-size={w},{h}', f'--screenshot={out}',
                        '--default-background-color=00000000', 'file://' + p], check=True, capture_output=True)
    finally:
        os.remove(p)
    im = Image.open(out)
    if opaque: im = im.convert('RGB')
    im.save(out)

# icons (transparent)
for name, svg, s in [('icon128', 'icon.svg', 128), ('icon48', 'icon-small.svg', 48), ('icon16', 'icon-small.svg', 16)]:
    shot(f'<html><body style="margin:0;background:transparent"><img src="src/{svg}" width="{s}" height="{s}" style="display:block"></body></html>',
         os.path.join(OUT, f'{name}.png'), s, s, opaque=False)

CSS = '''*{margin:0;box-sizing:border-box}body{width:1280px;height:800px;overflow:hidden;background:#FFFBEB;font-family:%s;color:#1F2328}
.h{height:118px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px}
.t{font-size:40px;font-weight:700;letter-spacing:1px}.s{font-size:18px;color:#6B7280}
.c{position:absolute;left:112px;top:124px;width:1056px;height:660px;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.14);border:1px solid #E5E7EB;background:#fff}
.c img{width:1056px;height:660px;display:block}
mark{background:rgba(250,204,21,.6);padding:0 4px;border-radius:3px;color:inherit}''' % FONT
SHOTS = {
 'zh': [('1-highlight-toolbar', '选中文字，<mark>一键划线</mark>', '划线会自动保存，在已授权的网站刷新后也还在'),
        ('2-note-bubble', '在划线旁<mark>写下批注</mark>', '点一下划线就能补充你的想法'),
        ('3-side-panel', '一页看全，<mark>导出 Markdown</mark>', '侧边栏汇总划线、批注和页面摘要，一键复制到笔记软件')],
 'en': [('1-highlight-toolbar-en', 'Select text, <mark>highlight in one click</mark>', 'Highlights are saved locally and come back after reload on sites you allow'),
        ('2-note-bubble-en', '<mark>Add a note</mark> to any highlight', 'Click a highlight to write down your thoughts'),
        ('3-side-panel-en', 'See it all, <mark>export to Markdown</mark>', 'The side panel collects highlights, notes and a page summary')],
}
for lang, items in SHOTS.items():
    for i, (raw, t, s) in enumerate(items, 1):
        shot(f'<html><head><style>{CSS}</style></head><body><div class="h"><div class="t">{t}</div><div class="s">{s}</div></div>'
             f'<div class="c"><img src="raw/{raw}.png"></div></body></html>', os.path.join(OUT, f'screenshot-{i}-{lang}.png'), 1280, 800)

PROMO = '''<html><head><style>*{margin:0;box-sizing:border-box}body{width:440px;height:280px;overflow:hidden;background:#FFFBEB;font-family:%s;color:#1F2328;display:flex;align-items:center;padding:0 32px;gap:22px}
img{width:104px;height:104px;flex:none}.n{font-weight:700;line-height:1.2}.z{font-size:16px;margin-top:10px;color:#4B5563;line-height:1.5}
mark{background:#FACC15;color:#1F2328;padding:0 4px;border-radius:3px}</style></head><body>
<img src="src/icon-small.svg"><div><div class="n" style="font-size:%dpx">%s</div><div class="z">%s</div></div></body></html>'''
shot(PROMO % (FONT, 30, '划线批注', '网页<mark>划线</mark> · 写批注<br>一键导出 Markdown'), os.path.join(OUT, 'promo-440x280-zh.png'), 440, 280)
shot(PROMO % (FONT, 24, 'Web Highlight Notes', '<mark>Highlight</mark> &amp; take notes<br>Export to Markdown'), os.path.join(OUT, 'promo-440x280-en.png'), 440, 280)
for f in sorted(os.listdir(OUT)):
    im = Image.open(os.path.join(OUT, f)); print(f, im.size, im.mode)
