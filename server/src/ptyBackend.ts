export type PtyBackend = "platform-default" | "winpty" | "conpty";

export type PtyBackendConfig = {
  backend: PtyBackend;
  useConpty?: boolean;
  useWindowsConsoleInput: boolean;
};

export function resolvePtyBackend(
  platform: NodeJS.Platform,
  configuredValue?: string,
): PtyBackendConfig {
  if (platform !== "win32") {
    return {
      backend: "platform-default",
      useWindowsConsoleInput: false,
    };
  }

  const normalizedValue = configuredValue?.trim().toLowerCase();
  if (!normalizedValue || normalizedValue === "conpty") {
    return {
      backend: "conpty",
      useConpty: true,
      useWindowsConsoleInput: true,
    };
  }
  if (normalizedValue === "winpty") {
    return {
      backend: "winpty",
      useConpty: false,
      useWindowsConsoleInput: false,
    };
  }

  throw new Error('TERMRAIL_WINDOWS_PTY must be either "winpty" or "conpty"');
}
