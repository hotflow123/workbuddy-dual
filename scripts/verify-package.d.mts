export interface VerifyResult {
  ok: boolean;
  problems: string[];
  checked: number;
}

export function verifyUnpacked(unpackedDirectory: string, electronDistDirectory: string): Promise<VerifyResult>;
