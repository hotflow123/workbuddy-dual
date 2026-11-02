import type { ProductId } from "./contracts";

/**
 * 已知产品特征（与“证据状态”分离）。
 *
 * 这里只放**产品自身的稳定特征**：对外名称与主程序文件名。
 * 不包含任何安装路径、盘符、用户名或版本号——不同电脑的安装位置不同，
 * 这些特征只用于“识别与提示”，绝不能单独放行写操作（写操作只由证据门决定）。
 */
export interface ProductTraits {
  product: ProductId;
  displayName: string;
  /** 元数据 productName 的允许值（大小写不敏感，精确匹配） */
  productNames: string[];
  /** 主程序文件名，仅作为线索 */
  executableNames: string[];
}

export const PRODUCT_TRAITS: Record<ProductId, ProductTraits> = {
  "workbuddy-cn": {
    product: "workbuddy-cn",
    displayName: "国内版 WorkBuddy",
    productNames: ["WorkBuddy"],
    executableNames: ["WorkBuddy.exe"],
  },
  "workbuddy-ai": {
    product: "workbuddy-ai",
    displayName: "国际版 WorkBuddy AI",
    productNames: ["WorkBuddy AI", "WorkBuddyAI"],
    executableNames: ["WorkBuddyAI.exe"],
  },
};

export const PRODUCT_IDS: ProductId[] = ["workbuddy-cn", "workbuddy-ai"];

/**
 * 官方下载入口（人工核验于 2026-10-19，见 docs/evidence/official-packages-2026-10-19.json）。
 * 只用于 `shell.openExternal` 打开首页，供用户自行下载；
 * 不含任何下载直链或 API，避免猜测端点。域名变更时必须重新核验后再改这里。
 */
export const OFFICIAL_SITES: Record<ProductId, { url: string; label: string; verifiedAt: string }> = {
  "workbuddy-cn": { url: "https://www.workbuddy.cn/", label: "WorkBuddy 官方网站", verifiedAt: "2026-10-19" },
  "workbuddy-ai": { url: "https://www.workbuddy.ai/", label: "WorkBuddy AI 官方网站", verifiedAt: "2026-10-19" },
};

/**
 * 界面顶栏展示的 API 赞助商入口。
 * 只有主进程会读取这里的 url；渲染进程既拿不到也改不了，
 * 因此不存在“任意 URL 打开”通道。
 */
export const SPONSOR_SITE = {
  url: "https://memefast.cc/",
  label: "API赞助商：memefast.cc",
} as const;

export function traitsOf(product: ProductId): ProductTraits {
  return PRODUCT_TRAITS[product];
}

export function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** 元数据产品名 → 产品；无法唯一确定时返回 null（不猜） */
export function productFromProductName(productName: string | null): ProductId | null {
  const value = normalizeName(productName);
  if (value === "") return null;
  const matched = PRODUCT_IDS.filter((id) => PRODUCT_TRAITS[id].productNames.some((n) => normalizeName(n) === value));
  return matched.length === 1 ? matched[0]! : null;
}
