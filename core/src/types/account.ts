export {};
export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  /** 账号归属用户名（多用户体系：普通用户只见自己的账号） */
  owner?: string;
  /** 抓包登录附加：游戏好友 GID */
  gid?: string;
  /** 抓包登录附加：微信 openId */
  openId?: string;
  /** 登录方式：qr / capture / manual 等 */
  loginType?: string;
  /** 微信扫码登录附加：openid（应用宝侧用户标识，自动刷新 Code 依赖） */
  wxid?: string;
  /** 微信扫码登录附加：应用宝登录缓冲凭证（可换发 Code） */
  loginBuffer?: string;
  /** 微信扫码登录附加：滚动刷新令牌（保活/续期 loginBuffer） */
  refreshtoken?: string;
  /** 微信扫码登录附加：访问令牌（配合 refreshtoken 使用） */
  accesstoken?: string;
  /** 服务端凭据到期时间（毫秒），用于到期前 35–45 分钟保活 */
  wxCredentialExpiresAt?: number;
  /** 服务端凭据有效期（秒） */
  wxCredentialExpiresIn?: number;
  /** 观察到 refreshtoken 的时间（毫秒） */
  wxRefreshTokenObservedAt?: number;
  /** 最近一次凭据续期成功时间（毫秒） */
  wxCredentialLastSuccessAt?: number;
  /** 是否允许自动登录（false 时跳过自动启动与保活） */
  autoLogin?: boolean;
  /** 是否已执行过"微信账号默认开启自动刷新"的一次性迁移 */
  wxDefaultsApplied?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
