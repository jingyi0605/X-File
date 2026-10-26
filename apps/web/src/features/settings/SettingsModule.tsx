import { useId, useState, type ReactNode } from "react";

interface SettingsModuleProps {
  title: string;
  description?: string;
  status?: string;
  actions?: ReactNode;
  feedback?: ReactNode;
  defaultExpanded?: boolean;
  listItem?: boolean;
  children: ReactNode;
}

export function SettingsModule({
  title,
  description,
  status,
  actions,
  feedback,
  defaultExpanded = true,
  listItem = false,
  children,
}: SettingsModuleProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="settings-module" role={listItem ? "listitem" : undefined} aria-label={title}>
      <div className="settings-module-header">
        <h3 className="settings-module-heading" aria-label={title}>
          <button
            type="button"
            className="settings-module-toggle"
            aria-label={title}
            aria-expanded={expanded}
            aria-controls={`${id}-body`}
            aria-describedby={description ? `${id}-description` : undefined}
            onClick={() => setExpanded((current) => !current)}
          >
            <svg className="settings-module-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
            <span className="settings-module-copy">
              <span className="settings-module-title">{title}</span>
              {description ? <span className="settings-module-description" id={`${id}-description`}>{description}</span> : null}
            </span>
          </button>
        </h3>
        {status || actions ? (
          <div className="settings-module-actions">
            {status ? <span className="settings-module-status">{status}</span> : null}
            {actions}
          </div>
        ) : null}
      </div>
      {feedback ? <div className="settings-module-feedback">{feedback}</div> : null}
      {/* 保留已挂载的表单，折叠只影响显示，不丢失输入或中断正在执行的操作。 */}
      <div className="settings-module-body" id={`${id}-body`} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
