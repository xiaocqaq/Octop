import * as React from "react";
import { Tooltip } from "antd";

/** The retained titlebar must not inherit sticky touch/synthetic hover state. */
export function SideChatToggleTooltip({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const [hoverTitle, setHoverTitle] = React.useState<string | null>(null);
  React.useEffect(() => setHoverTitle(null), [title]);
  const dismiss = () => setHoverTitle(null);

  return (
    <Tooltip
      title={title}
      trigger={[]}
      open={Boolean(title) && hoverTitle === title}
    >
      <span
        style={{ display: "inline-flex" }}
        onPointerEnter={(event) => {
          setHoverTitle(
            event.pointerType === "mouse" && event.buttons === 0
              ? title ?? null
              : null,
          );
        }}
        onPointerLeave={dismiss}
        onPointerDownCapture={dismiss}
        onClickCapture={dismiss}
        onBlur={dismiss}
      >
        {children}
      </span>
    </Tooltip>
  );
}
