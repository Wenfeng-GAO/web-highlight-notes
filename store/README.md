# Chrome Web Store assets

- `out/`: assets ready to upload
  - `icon128.png`: store icon, 128×128 with 16px transparent margin
  - `icon48.png`, `icon16.png`: small icons for the extension itself
  - `screenshot-{1,2,3}-{zh,en}.png`: store screenshots, 1280×800
  - `promo-440x280-{zh,en}.png`: small promo tile
- `raw/`: real 0.1.3 / 0.1.4 UI captures the screenshots are built from
- `src/`: icon SVG sources

Rebuild with `python3 store/build.py`. It needs google-chrome and Pillow.
For the first submission, upload the zh set only. The en set is for 0.1.5.
