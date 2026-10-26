import { useLayoutEffect, useRef, type ReactNode } from "react";

interface AnimatedDetailsProps {
  open: boolean;
  label: string;
  depth: number;
  summary: ReactNode;
  onOpenChange: () => void;
  children: ReactNode;
}

export function AnimatedDetails({ open, label, depth, summary, onOpenChange, children }: AnimatedDetailsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const initialOpen = useRef(open);
  const hasOpened = useRef(open);
  if (open) hasOpened.current = true;

  useLayoutEffect(() => {
    const details = detailsRef.current;
    const content = contentRef.current;
    if (!details || !content) return;

    const from = details.open ? content.getBoundingClientRect().height : 0;
    if (open) details.open = true;
    const to = open ? content.scrollHeight : 0;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!content.animate || reducedMotion || from === to) {
      details.open = open;
      return;
    }

    // 收起动画结束后再关闭原生 details，避免浏览器立即隐藏内容。
    const styles = getComputedStyle(details);
    const animation = content.animate(
      [{ height: `${from}px`, opacity: open ? 0 : 1 }, { height: `${to}px`, opacity: open ? 1 : 0 }],
      {
        duration: Number.parseFloat(styles.getPropertyValue("--tree-motion-duration")) || 220,
        easing: styles.getPropertyValue("--motion-easing").trim() || "ease",
      },
    );
    animation.onfinish = () => { details.open = open; };
    return () => animation.cancel();
  }, [open]);

  return (
    <details
      ref={detailsRef}
      open={initialOpen.current}
      className="affairs-tag-tree-node"
      role="treeitem"
      aria-label={label}
      aria-expanded={open}
      data-depth={depth}
      data-expanded={open}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (!(event.target as Element).closest("button")) onOpenChange();
        }}
      >
        {summary}
      </summary>
      <div ref={contentRef} className="affairs-tag-tree-reveal affairs-tag-tree-children" role="group" aria-hidden={!open} inert={!open}>
        {hasOpened.current ? children : null}
      </div>
    </details>
  );
}
