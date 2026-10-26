import type { SVGProps } from "react";

const iconPaths = {
  appearance: "M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a1 1 0 0 1 0-2h2a6 6 0 0 0 6-6c0-3-4-5-9-5ZM7.5 8h.01M12 6.5h.01M6 12h.01M17 8h.01",
  library: "M4 5h16v15H4zM3 2h18v3H3m6 5h6",
  integration: "M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5",
  network: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z",
  updates: "M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 11.6-3L20 8M4 16l2.9 3A7 7 0 0 0 18.5 16",
  locate: "M12 3v3m0 12v3M3 12h3m12 0h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3v4m-2-2h4",
  preview: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  download: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5",
  copy: "M9 9h12v12H9zM5 15H3V3h12v2",
  rename: "m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
  delete: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
} as const;

export type InterfaceIconName = keyof typeof iconPaths;

export function InterfaceIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: InterfaceIconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={iconPaths[name]} />
    </svg>
  );
}
