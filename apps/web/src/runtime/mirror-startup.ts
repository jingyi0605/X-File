export type RuntimeMode = "local" | "mirror";

export function shouldAllowMirrorStartupWithoutHttpAuth(
  mode: RuntimeMode,
  error: unknown,
): boolean {
  if (mode !== "mirror" || !error || typeof error !== "object") {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number"
    && (status === 0 || status === 404 || status >= 500)
  );
}
