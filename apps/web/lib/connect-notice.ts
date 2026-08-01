/**
 * Connect notice — top banner on home page.
 *
 * 两态:
 * - 未开通(无 TUNNEL_TOKEN):推广横幅,邀请开通远程访问。
 * - 已开通(有 TUNNEL_TOKEN):「远程访问已上线」确认横幅(可关闭)。
 * Pure logic, testable without DB.
 */

export const CONNECT_NOTICE_DISMISSED_KEY = "connect_notice_dismissed_at";

export interface ConnectNoticeConditions {
  isDemo: boolean;
  /** 桌面版(Electron)不提供远程访问 —— 横幅绝不出现。 */
  isDesktop: boolean;
  accountId: string | null;
  dismissedAt: string | null;
  hasTunnelToken: boolean;
}

/**
 * 判断是否显示 Connect 通知横幅。
 * 
 * 出现条件（必须全部满足）：
 * 1. 不是 demo 模式
 * 2. 已登录（有 accountId）
 * 3. 从未关闭过横幅（dismissedAt 为 null）
 * 
 * hasTunnelToken 不参与显示判定(已开通的实例同样显示「已上线」确认横幅,
 * 文案由 banner 组件按 hasTunnelToken 区分)。之前「有 token 不显示」导致
 * 软路由(已配置 TUNNEL_TOKEN)永远看不到横幅 —— 用户期望看到「远程访问
 * 已上线」确认。
 */
export function shouldShowConnectNotice(
  conditions: ConnectNoticeConditions
): boolean {
  const { isDemo, isDesktop, accountId, dismissedAt } = conditions;

  // 任一条件不满足就不显示
  if (isDemo) return false;
  if (isDesktop) return false;
  if (!accountId) return false;
  if (dismissedAt !== null) return false;

  return true;
}
