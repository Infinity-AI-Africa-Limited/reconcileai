export function buildRuntimePreparation(
  outputDirectory: string
): Promise<{ hold: true; liveEnabled: false; probeSha256: string }>;
