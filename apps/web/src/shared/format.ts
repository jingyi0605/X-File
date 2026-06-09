import { getLocaleForIntl, t } from "../i18n";

export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return t("commonUnknown");
  }

  if (value < 1024) {
    return t("commonBytes", { count: value });
  }

  const kib = value / 1024;
  if (kib < 1024) {
    return t("commonKiB", { count: kib.toFixed(1) });
  }

  const mib = kib / 1024;
  if (mib < 1024) {
    return t("commonMiB", { count: mib.toFixed(1) });
  }

  return t("commonGiB", { count: (mib / 1024).toFixed(1) });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return t("commonUnknown");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(getLocaleForIntl(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinCommaList(value: string[] | null | undefined): string {
  return (value ?? []).join(", ");
}

export function getPathName(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "");
  if (!normalized) {
    return t("libraryRootFolder");
  }
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
