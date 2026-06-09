import { createPortal } from "react-dom";
import { useEffect, useId, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { t } from "../../i18n";

export type DesktopModalSizePreset = "narrow" | "compact" | "regular" | "wide" | "xwide" | "full";
export type DesktopModalLayoutPreset = "confirm" | "form" | "list" | "viewer";

interface DesktopModalProps {
  readonly open?: boolean;
  readonly title: string;
  readonly description?: string;
  readonly hideHeader?: boolean;
  readonly size?: DesktopModalSizePreset;
  readonly layout?: DesktopModalLayoutPreset;
  readonly dismissible?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly closeOnEscape?: boolean;
  readonly backdropVisible?: boolean;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly titleClassName?: string;
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly titleProps?: Omit<HTMLAttributes<HTMLHeadingElement>, "id" | "children" | "className" | "ref"> & Record<`data-${string}`, string | undefined>;
  readonly headerActions?: ReactNode;
  readonly beforeCloseButton?: ReactNode;
  readonly footer?: ReactNode;
  readonly showCloseButton?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function DesktopModal({
  open = true,
  title,
  description,
  hideHeader = false,
  size = "compact",
  layout = "form",
  dismissible = true,
  closeOnBackdrop = true,
  closeOnEscape = true,
  backdropVisible = true,
  className,
  bodyClassName,
  titleClassName,
  titleRef,
  titleProps,
  headerActions,
  beforeCloseButton,
  footer,
  showCloseButton = true,
  onClose,
  children
}: DesktopModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const canCloseOnBackdrop = dismissible && closeOnBackdrop;
  const canCloseOnEscape = dismissible && closeOnEscape;

  useEffect(() => {
    if (!open || !canCloseOnEscape) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canCloseOnEscape, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="workbench-modal-layer desktop-modal-layer"
      data-fullscreen={size === "full" ? "true" : undefined}
      data-layout={layout}
      data-backdrop-visible={backdropVisible ? "true" : "false"}
    >
      <button
        type="button"
        className="workbench-modal-backdrop"
        aria-label={t("actionClose")}
        disabled={!canCloseOnBackdrop}
        onClick={() => {
          if (canCloseOnBackdrop) onClose();
        }}
      />
      <section
        className={`workbench-modal-card surface-card desktop-modal-card${className ? ` ${className}` : ""}`}
        data-size={size}
        data-layout={layout}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hideHeader ? undefined : titleId}
        aria-label={hideHeader ? title : undefined}
        aria-describedby={!hideHeader && description ? descriptionId : undefined}
      >
        {!hideHeader ? (
          <div className="workbench-modal-header desktop-modal-header">
            <div className="workbench-modal-title-wrap">
              <h2 id={titleId} className={titleClassName} ref={titleRef} {...titleProps}>
                {title}
              </h2>
              {description ? <p id={descriptionId}>{description}</p> : null}
            </div>
            {headerActions || beforeCloseButton || showCloseButton ? (
              <div className="workbench-modal-header-actions">
                {headerActions}
                {beforeCloseButton}
                {showCloseButton ? (
                  <button
                    type="button"
                    className="desktop-modal-close"
                    aria-label={t("actionClose")}
                    disabled={!dismissible}
                    onClick={() => {
                      if (dismissible) onClose();
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={bodyClassName ? `workbench-modal-body desktop-modal-body ${bodyClassName}` : "workbench-modal-body desktop-modal-body"}>{children}</div>
        {footer ? <div className="workbench-modal-footer desktop-modal-footer">{footer}</div> : null}
      </section>
    </div>,
    document.body
  );
}
