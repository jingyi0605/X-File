import { PdfContinuousPreview } from "./PdfContinuousPreview";

const MAX_PAGES = 500;

export function OfficeConvertedPdfPreview({ bytes, path, onError }: { bytes: Uint8Array; path: string; onError: () => void }) {
  return <PdfContinuousPreview bytes={bytes} path={path} maxPages={MAX_PAGES} onError={onError} />;
}
