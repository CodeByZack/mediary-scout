# Pending 积累方案 — 设计文档

> 2026-09-10 · 解决"部分覆盖被丢弃"和"尾部重转制造假 partial"两个问题

---

## 1. 问题

### 1.1 部分覆盖被丢弃

现在 fast path 的转存流程是**全有或全无**：

```
转存候选 A → staging → digest → 认出 8/10 集
  → 没全覆盖 → 清 staging → 有用部分全丢 ❌

转存候选 B → staging → digest → 认出 10/10 集
  → 全覆盖 → finalizeLanding → 落库 ✅
```

一个包哪怕认出了 8/10 集，只要没全覆盖就要清掉重来。前几个候选的有用部分全部浪费。

### 1.2 尾部重转制造假 partial

之前有"尾部重转"机制：两池耗尽后，按覆盖数降序重转最优候选。但因为重转时**没有重新调 AI 映射**，用旧的 overrides 做 lookup，如果源包内容变了（文件删了/换了名），覆盖率会跳水（34→10）。

结果：明明主流程认出了 34 集，尾部重转只认出 10 集就落库了，制造了"假 partial"。

**已删**：2026-09-10 直接删掉尾部重转，改为报"未找到"更诚实。

### 1.3 多季获取容错差

多季获取（如 1+2 季）要求一个包包含所有季。缺一季就整包丢弃。

---

## 2. 方案：Pending 积累

### 2.1 核心思路

把"识别"和"落库"解耦：

```
现在: 转存 → staging → digest → 没全覆盖就清 → 有用部分全丢
新方案: 转存 → staging → digest → 有覆盖就搬 pending → 清 staging → 继续
```

新增一个 `pending/` 目录，累积已识别的集数，跨候选持久。所有候选试完后再统一落库。

### 2.2 目录结构

```
sandbox/
├── staging/    ← 每次转存的临时区（用完就清，不变）
├── pending/    ← 累积已识别的集（跨候选持久，新增）
└── target/     ← 最终落库位置（不变）
```

### 2.3 全覆盖走快路径

如果某个候选覆盖了所有需要的集，**不进 pending**，直接从 staging 落库：

```
for each candidate:
  1. 转存 → staging
  2. digest → 覆盖情况

  if 全覆盖:
    → finalizeLanding(from staging) → 落库 → 结束 ✅
    // happy path 不变，不绕 pending

  else:
    → 搬已覆盖的到 pending（同源优先）
    → 清 staging
    → 继续下一个候选

所有候选试完:
  → finalizeLanding(from pending) → 落库
```

### 2.4 同源优先算法

尽量让同一季的集数来自同一个分享（质量一致），实在补不上才跨源拼。

```typescript
interface PendingEntry {
  code: string;        // S01E01
  filePath: string;    // staging 里的路径
  source: string;      // 候选 ID
}

const pending = new Map<string, PendingEntry>();
let bestCount = 0;    // 当前主力源的最多集数

for (const candidate of allCandidates) {
  const digest = await digestStaging(candidate);
  const count = digest.covered.size;

  if (count > bestCount) {
    // 新主力：覆盖旧的同名集
    for (const [code, filePath] of digest.covered) {
      pending.set(code, { code, filePath, source: candidate.id });
    }
    bestCount = count;
  } else {
    // 只补独有的
    for (const [code, filePath] of digest.covered) {
      if (!pending.has(code)) {
        pending.set(code, { code, filePath, source: candidate.id });
      }
    }
  }

  // 搬文件：staging → pending
  for (const [code, entry] of pending) {
    if (entry.source === candidate.id) {
      await sandbox.moveFile({
        from: 'staging',
        to: 'pending',
        fileId: entry.filePath,
        newName: `${code}.mkv`,  // 规范命名
      });
    }
  }

  await sandbox.clearStaging();
}

// 最终落库：pending → target
await finalizeLanding({
  source: 'pending',
  entries: [...pending.values()],
  canonicalTitle: target.title,
  seasons,
  skipCodes: onDiskCodes,
});
```

### 2.5 流程示例

| 轮次 | 候选 | 覆盖 | 动作 | pending 状态 |
|---|---|---|---|---|
| 1 | A | {E01,E02,E03} | 新建主力(3集) | {E01←A, E02←A, E03←A} |
| 2 | B | {E02,E03,E04,E05} | 新主力(4集)→覆盖 E02/E03 | {E01←A, E02←B, E03←B, E04←B, E05←B} |
| 3 | C | {E06,E07} | 只补独有(2集) | {E01←A, E02←B, E03←B, E04←B, E05←B, E06←C, E07←C} |

主力 B 占 4/7 = 57%，A 补 1 个独有，C 补 2 个独有。

### 2.6 结账报告

```
转存 3 次，从 3 个候选拼出 7/10 集
主力源: B（4 集），补充: A（1 集）+ C（2 集）
缺: E08, E09, E10
```

---

## 3. 影响范围

### 3.1 需要改的文件

| 文件 | 改动 | 工作量 |
|---|---|---|
| `staging-digest.ts` | 返回 `Map<code, filePath>`（不只 code 列表） | 小 |
| `finalize-landing.ts` | 增加 `source: 'staging' | 'pending'` 参数 | 小 |
| `tv.ts` | 主循环：转存→digest→搬pending→清staging→继续 | 中 |
| `movie.ts` | 同上 | 中 |
| `landing.ts` | 新增 `moveToPending` + 同源优先算法 | 中 |
| `steps.ts` | 新增 step 类型（moveToPending, finalizeFromPending） | 小 |
| `budgets.ts` | 删 `MAX_TAIL_RETRANSFER`（已删） | 无 |
| 测试 | 全量适配 | 大 |

### 3.2 不动的

- `episode-code.ts` — 解析逻辑不变
- `candidate-grader.ts` — 评分不变
- `arbitrator.ts` — AI 映射不变（digest 后仍调）
- 搜索逻辑 — 搜一次，候选池不变
- `finalize-landing.ts` 的落库逻辑（rename/move/mark）不变，只改 source

---

## 4. 风险点

| 风险 | 缓解 |
|---|---|
| pending 残留 | run 结束必须清 pending（挂 `withStagingCleanup` 同款生命周期） |
| 同名覆盖 | 主力替换时，旧文件要从 pending 删掉再搬新的 |
| staging 残留 | 搬完必须清 staging，防下一条候选污染 |
| 全覆盖走 staging | 快路径不变，pending 只在部分覆盖时才用 |
| 结账统计 | 需要统计"从几个候选拼出多少集" |

---

## 5. 顺便解决

1. **尾部重转**（已删）——不需要了，pending 自动积累
2. **假 partial**（34→10 跳水）——不会出现，pending 只放已识别的
3. **多季获取容错差**——pending 天然支持跨候选积累，一季从 A 拿，二季从 B 拿

---

## 6. 工作量估算

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | `staging-digest` 返回 Map + `landing.ts` 加 moveToPending | 2h |
| 2 | `tv.ts` / `movie.ts` 主循环改造 + 同源优先 | 3h |
| 3 | `finalize-landing` 支持 pending 来源 | 1h |
| 4 | 测试全量适配 | 4h |
| **合计** | | **~10h** |

---

## 7. 关联改动（已落地）

- `MAX_TRANSFER_ATTEMPTS` 10→5（转存预算下调）
- 兜底搜索仅 `!primaryHasA` 时触发（有 A 试尽不兜底）
- Phase 1 条件 `grading.ranked.length > 0`（有候选就进，不只 A）
- 尾部重转已删（-157 行）
