import { useEffect, useMemo, useState } from "react";

import { t } from "../../i18n";
import { DesktopModal, ModalActions, ModalSection } from "../../shared/modal";
import {
  EXTENSION_TEMPLATE_INDUSTRIES,
  EXTENSION_TEMPLATE_WORK_NATURES,
  getExtensionTemplateExtensions,
  type ExtensionTemplateIndustry,
  type ExtensionTemplateWorkNature,
} from "./extension-template-catalog";

interface ExtensionTemplateWizardProps {
  open: boolean;
  onApply: (extensions: string[]) => void;
  onClose: () => void;
}

interface ExtensionTemplateSelectionState {
  industries: ExtensionTemplateIndustry[];
  workNatures: ExtensionTemplateWorkNature[];
  excludedExtensions: string[];
}

const EXTENSION_TEMPLATE_SELECTION_STORAGE_KEY = "x-file.settings.extension-template-selection";

export function ExtensionTemplateWizard({
  open,
  onApply,
  onClose,
}: ExtensionTemplateWizardProps) {
  const [selection, setSelection] = useState<ExtensionTemplateSelectionState>(
    readExtensionTemplateSelection,
  );
  const selectedIndustries = selection.industries;
  const selectedWorkNatures = selection.workNatures;
  const excludedExtensions = useMemo(
    () => new Set(selection.excludedExtensions),
    [selection.excludedExtensions],
  );
  const recommendedExtensions = useMemo(
    () => getExtensionTemplateExtensions(selectedIndustries, selectedWorkNatures),
    [selectedIndustries, selectedWorkNatures],
  );
  const selectedExtensions = useMemo(
    () => recommendedExtensions
      .filter((extension) => !excludedExtensions.has(extension))
      .sort(compareExtensions),
    [excludedExtensions, recommendedExtensions],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      EXTENSION_TEMPLATE_SELECTION_STORAGE_KEY,
      JSON.stringify(selection),
    );
  }, [selection]);

  function toggleIndustry(nextIndustry: ExtensionTemplateIndustry): void {
    setSelection((current) => ({
      ...current,
      industries: toggleTemplateSelection(current.industries, nextIndustry),
      excludedExtensions: [],
    }));
  }

  function toggleWorkNature(nextWorkNature: ExtensionTemplateWorkNature): void {
    setSelection((current) => ({
      ...current,
      workNatures: toggleTemplateSelection(current.workNatures, nextWorkNature),
      excludedExtensions: [],
    }));
  }

  function toggleExtension(extension: string): void {
    setSelection((current) => {
      const next = new Set(current.excludedExtensions);
      if (next.has(extension)) {
        next.delete(extension);
      } else {
        next.add(extension);
      }
      return {
        ...current,
        excludedExtensions: Array.from(next).sort(compareExtensions),
      };
    });
  }

  return (
    <DesktopModal
      open={open}
      title={t("settingsExtensionTemplateTitle")}
      description={t("settingsExtensionTemplateDescription")}
      size="wide"
      layout="form"
      onClose={onClose}
      footer={
        <ModalActions align="between">
          <span className="settings-extension-template-count">
            {t("settingsExtensionTemplateCount", { count: selectedExtensions.length })}
          </span>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onClose}>
              {t("actionCancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!selectedExtensions.length}
              onClick={() => onApply(selectedExtensions)}
            >
              {t("settingsExtensionTemplateApply")}
            </button>
          </div>
        </ModalActions>
      }
    >
      <div className="settings-extension-template-layout">
        <div className="settings-extension-template-choices">
          <ModalSection
            heading={t("settingsExtensionTemplateIndustryTitle")}
            description={t("settingsExtensionTemplateIndustryDescription")}
          >
            <div className="settings-extension-template-options" role="group" aria-label={t("settingsExtensionTemplateIndustryTitle")}>
              {EXTENSION_TEMPLATE_INDUSTRIES.map((option) => {
                const selected = selectedIndustries.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={selected ? "settings-extension-template-option active" : "settings-extension-template-option"}
                    aria-checked={selected}
                    role="checkbox"
                    onClick={() => toggleIndustry(option.id)}
                  >
                    <strong>{t(option.labelKey)}</strong>
                    <span>{t(option.descriptionKey)}</span>
                  </button>
                );
              })}
            </div>
          </ModalSection>
          <ModalSection
            heading={t("settingsExtensionTemplateWorkTitle")}
            description={t("settingsExtensionTemplateWorkDescription")}
          >
            <div className="settings-extension-template-options" role="group" aria-label={t("settingsExtensionTemplateWorkTitle")}>
              {EXTENSION_TEMPLATE_WORK_NATURES.map((option) => {
                const selected = selectedWorkNatures.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={selected ? "settings-extension-template-option active" : "settings-extension-template-option"}
                    aria-checked={selected}
                    role="checkbox"
                    onClick={() => toggleWorkNature(option.id)}
                  >
                    <strong>{t(option.labelKey)}</strong>
                    <span>{t(option.descriptionKey)}</span>
                  </button>
                );
              })}
            </div>
          </ModalSection>
        </div>
        <ModalSection
          className="settings-extension-template-preview"
          heading={t("settingsExtensionTemplatePreviewTitle")}
          description={t("settingsExtensionTemplatePreviewDescription")}
        >
          <div className="affairs-extension-tabpanel settings-extension-template-chip-list">
            {selectedExtensions.map((extension) => (
              <button
                key={extension}
                type="button"
                className="affairs-extension-chip active"
                aria-pressed="true"
                onClick={() => toggleExtension(extension)}
              >
                {extension}
              </button>
            ))}
            {recommendedExtensions
              .filter((extension) => excludedExtensions.has(extension))
              .map((extension) => (
                <button
                  key={extension}
                  type="button"
                  className="affairs-extension-chip"
                  aria-pressed="false"
                  onClick={() => toggleExtension(extension)}
                >
                  {extension}
                </button>
              ))}
            {!selectedExtensions.length ? (
              <p className="affairs-extension-empty">{t("settingsExtensionTemplateEmpty")}</p>
            ) : null}
          </div>
          <p className="settings-extension-template-hint">
            {t("settingsExtensionTemplateHint")}
          </p>
        </ModalSection>
      </div>
    </DesktopModal>
  );
}

function compareExtensions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function toggleTemplateSelection<T extends string>(current: T[], value: T): T[] {
  if (current.includes(value)) {
    return current.length > 1 ? current.filter((item) => item !== value) : current;
  }
  return [...current, value];
}

function readExtensionTemplateSelection(): ExtensionTemplateSelectionState {
  const fallback: ExtensionTemplateSelectionState = {
    industries: ["general"],
    workNatures: ["office"],
    excludedExtensions: [],
  };
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(EXTENSION_TEMPLATE_SELECTION_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<ExtensionTemplateSelectionState>;
    const industries = Array.isArray(parsed.industries)
      ? uniqueValidIndustries(parsed.industries)
      : [];
    const workNatures = Array.isArray(parsed.workNatures)
      ? uniqueValidWorkNatures(parsed.workNatures)
      : [];
    const excludedExtensions = Array.isArray(parsed.excludedExtensions)
      ? Array.from(new Set(parsed.excludedExtensions.filter((value): value is string => typeof value === "string")))
      : [];
    return {
      industries: industries.length ? industries : fallback.industries,
      workNatures: workNatures.length ? workNatures : fallback.workNatures,
      excludedExtensions,
    };
  } catch {
    return fallback;
  }
}

function uniqueValidIndustries(values: unknown[]): ExtensionTemplateIndustry[] {
  return Array.from(new Set(
    values.filter((value): value is ExtensionTemplateIndustry =>
      EXTENSION_TEMPLATE_INDUSTRIES.some((option) => option.id === value),
    ),
  ));
}

function uniqueValidWorkNatures(values: unknown[]): ExtensionTemplateWorkNature[] {
  return Array.from(new Set(
    values.filter((value): value is ExtensionTemplateWorkNature =>
      EXTENSION_TEMPLATE_WORK_NATURES.some((option) => option.id === value),
    ),
  ));
}
