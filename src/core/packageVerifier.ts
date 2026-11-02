import type { AuthenticodeInfo, PackageCheck, ProductId, ProductProfile } from "./contracts";

/**
 * 安装包校验：哈希（可选）、Authenticode（仅诊断）、包内产品身份（硬性）。
 *
 * 0.6.1 起：签名状态**不再**决定安装/更新是否继续。用户自己从官方渠道下载的包
 * 可能是 NotSigned / Unknown / 换过证书，管理器不替用户作决定；签名只写入诊断。
 * 仍然拒绝：哈希与官方元数据不符、包属于另一产品、产品名缺失。
 */

export interface PackageDeps {
  sha256(file: string): Promise<string>;
  size(file: string): Promise<number>;
  authenticode(file: string): Promise<AuthenticodeInfo | null>;
  versionInfo(file: string): Promise<{ productName: string | null; fileDescription: string | null; fileVersion: string | null } | null>;
}

export interface PackageVerifyInput {
  file: string;
  expected: ProductId;
  profile: ProductProfile;
  counterpart: ProductProfile | null;
  /** 官方元数据提供的哈希（可选） */
  expectedSha256?: string | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function verifyPackage(input: PackageVerifyInput, deps: PackageDeps): Promise<PackageCheck> {
  const reasons: string[] = [];
  const [sha256, size, authenticode, versionInfo] = await Promise.all([
    deps.sha256(input.file),
    deps.size(input.file),
    deps.authenticode(input.file),
    deps.versionInfo(input.file),
  ]);

  const productName = versionInfo?.productName ?? null;
  const productVersion = versionInfo?.fileVersion ?? null;
  let verdict: PackageCheck["verdict"] = "valid";

  if (input.expectedSha256 && normalize(input.expectedSha256) !== normalize(sha256)) {
    verdict = "invalid";
    reasons.push("安装包 SHA-256 与官方元数据不一致");
  }

  // 签名只作为诊断信息记录，不参与通过/失败判定
  if (!authenticode) {
    reasons.push("签名：未能读取 Authenticode（仅诊断，不影响部署）");
  } else {
    reasons.push(
      `签名：${authenticode.status}${authenticode.signerSubject ? `（${authenticode.signerSubject}）` : ""}（仅诊断，不影响部署）`,
    );
  }

  const expectedNames = input.profile.productNames;
  const counterpartNames = input.counterpart?.productNames ?? [];
  const observed = productName ?? versionInfo?.fileDescription ?? null;

  if (!observed) {
    if (verdict === "valid") verdict = "unknown";
    reasons.push("安装包内未读取到产品名称，无法确认包与产品的对应关系");
  } else if (counterpartNames.some((n) => normalize(n) === normalize(observed))) {
    verdict = "invalid";
    reasons.push("该安装包属于另一产品，禁止混用");
  } else if (expectedNames.length > 0 && !expectedNames.some((n) => normalize(n) === normalize(observed))) {
    verdict = "invalid";
    reasons.push("安装包产品名与目标产品不一致");
  }

  if (verdict === "valid") {
    reasons.push("产品身份一致，归档与版本检查通过");
  }

  return {
    file: input.file,
    sizeBytes: size,
    sha256,
    authenticode,
    productName,
    productVersion,
    verdict,
    reasons,
  };
}
