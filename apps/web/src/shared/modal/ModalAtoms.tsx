import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ModalTone = "default" | "accent" | "success" | "warning" | "danger";

interface ModalSectionProps {
  readonly heading?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly tone?: Exclude<ModalTone, "success" | "warning">;
  readonly className?: string;
  readonly children: ReactNode;
}

interface ModalFieldProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly className?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}

interface ModalActionsProps extends HTMLAttributes<HTMLDivElement> {
  readonly align?: "start" | "end" | "between";
  readonly stack?: boolean;
}

interface ModalEmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly compact?: boolean;
  readonly tone?: "default" | "danger";
}

interface ModalTagProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ModalTone;
}

export function ModalSection({ heading, description, actions, tone = "default", className, children }: ModalSectionProps) {
  return (
    <section className={joinClassNames("modal-section", className)} data-tone={tone !== "default" ? tone : undefined}>
      {heading || description || actions ? (
        <div className="modal-section-header">
          <div className="modal-section-copy">
            {heading ? <strong className="modal-section-heading modal-section-title">{heading}</strong> : null}
            {description ? <p className="modal-section-description">{description}</p> : null}
          </div>
          {actions ? <div className="modal-section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ModalField({ label, description, className, htmlFor, children }: ModalFieldProps) {
  return (
    <div className={joinClassNames("workbench-modal-field", "modal-field", className)}>
      <div className="modal-field-copy">
        {htmlFor ? <label className="modal-field-label" htmlFor={htmlFor}>{label}</label> : <span className="modal-field-label">{label}</span>}
        {description ? <span className="modal-field-description">{description}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function ModalActions({ align = "end", stack = false, className, children, ...props }: ModalActionsProps) {
  return (
    <div className={joinClassNames("workbench-modal-actions", "modal-actions", className)} data-align={align} data-stack={stack ? "true" : undefined} {...props}>
      {children}
    </div>
  );
}

export function ModalEmptyState({ title, description, action, className, compact = false, tone = "default" }: ModalEmptyStateProps) {
  return (
    <div className={joinClassNames("modal-empty-state", className)} data-compact={compact ? "true" : undefined} data-tone={tone !== "default" ? tone : undefined}>
      <strong className="modal-empty-state-title">{title}</strong>
      {description ? <p className="modal-empty-state-description">{description}</p> : null}
      {action ? <div className="modal-empty-state-action">{action}</div> : null}
    </div>
  );
}

export function ModalTag({ tone = "default", className, children, ...props }: ModalTagProps) {
  return (
    <span className={joinClassNames("modal-tag", className)} data-tone={tone !== "default" ? tone : undefined} {...props}>
      {children}
    </span>
  );
}

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
