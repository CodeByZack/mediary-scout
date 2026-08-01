import { describe, it, expect } from "vitest";
import { shouldShowConnectNotice } from "./connect-notice";
import type { ConnectNoticeConditions } from "./connect-notice";

describe("shouldShowConnectNotice", () => {
  const baseConditions: ConnectNoticeConditions = {
    isDemo: false,
    accountId: "acc_123",
    dismissedAt: null,
    hasTunnelToken: false,
  };

  it("shows when all conditions are met", () => {
    expect(shouldShowConnectNotice(baseConditions)).toBe(true);
  });

  it("hides in demo mode", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, isDemo: true })).toBe(false);
  });

  it("hides when not logged in", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, accountId: null })).toBe(false);
  });

  it("hides when already dismissed", () => {
    expect(shouldShowConnectNotice({ ...baseConditions, dismissedAt: "2026-08-01T12:00:00Z" })).toBe(
      false
    );
  });

  it("shows even when tunnel token exists (已开通也显示「已上线」确认横幅)", () => {
    // 之前「有 token 不显示」导致已开通实例(软路由)永远看不到横幅 —— 真实反馈。
    // 有 token = 已开通,横幅切换为「远程访问已上线」确认文案(组件层区分)。
    expect(shouldShowConnectNotice({ ...baseConditions, hasTunnelToken: true })).toBe(true);
  });

  it("hides when multiple conditions fail", () => {
    expect(
      shouldShowConnectNotice({
        isDemo: true,
        accountId: null,
        dismissedAt: "2026-08-01T12:00:00Z",
        hasTunnelToken: true,
      })
    ).toBe(false);
  });
});
