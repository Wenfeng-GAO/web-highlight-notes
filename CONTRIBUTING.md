# 贡献指南 / Contributing

## 修 bug 的规则（Bug rule）

每个 bug 都必须有：

1. **一个 GitHub issue**（打 `bug` 标签）：现象、复现步骤、根因、影响版本、修复计划。修复后才发现的 bug 也要补登记，并链接修复它的 PR。
2. **一个回归测试**：能在修复前失败、修复后通过（单元测试或 Playwright e2e）。修复 PR 的描述里写 `Fixes #N`。
3. **一次同类问题排查**：找出同一类错误可能出现的其它地方（例如同一个 URL/scheme 过滤在别处也用了），逐个检查。真问题在同一个 PR 里修掉，或另开 issue。PR 描述里附一张简表：检查位置 / 结果 / 测试。

Every bug needs an issue (labelled `bug`), a regression test that fails before the fix, and a sweep for similar cases, with the sweep summarised in the PR (place checked / result / test). The fixing PR says `Fixes #N`.

## 本地检查（Checks）

- `npm test`：单元测试（vitest）。
- `xvfb-run -a npx playwright test`：e2e（需要 `xdotool`，见 `.github/workflows/ci.yml`）。
- 界面文案都走 `_locales/zh_CN` 和 `_locales/en`，两边键必须一致（`tests/unit/i18n.test.js` 会检查）。
