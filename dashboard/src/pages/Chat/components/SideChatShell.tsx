import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import styles from "./SideChatShell.module.less";

const MAIN_MIN_WIDTH = 320;
const SIDE_MIN_WIDTH = 280;
const KEY_STEP = 16;

interface SideChatShellProps {
  open: boolean;
  mobile: boolean;
  onHide: () => void;
  children: ReactNode;
}

export default function SideChatShell({
  open,
  mobile,
  onHide,
  children,
}: SideChatShellProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  // Move the same composer DOM between layouts so a breakpoint change keeps its state.
  const [contentHost] = useState(() => document.createElement("div"));
  const attachContent = useCallback(
    (slot: HTMLDivElement | null) => {
      slot?.appendChild(contentHost);
    },
    [contentHost],
  );
  const drag = useRef<{ pointerId: number; x: number; width: number }>();
  const [availableWidth, setAvailableWidth] = useState(0);
  const [preferredWidth, setPreferredWidth] = useState<number>();

  useLayoutEffect(() => {
    const row = shellRef.current?.parentElement;
    if (!row || mobile || !open) return;
    const measure = () => setAvailableWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      drag.current = undefined;
      observer.disconnect();
    };
  }, [mobile, open]);

  const maxWidth = Math.max(0, availableWidth - MAIN_MIN_WIDTH);
  const minWidth = Math.min(SIDE_MIN_WIDTH, maxWidth);
  const clamp = (width: number) =>
    Math.min(maxWidth, Math.max(minWidth, width));
  const width = clamp(
    preferredWidth ?? Math.min(Math.round(availableWidth * 0.44), 560),
  );

  function resizeByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const { key } = event;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "Home" &&
      key !== "End"
    )
      return;
    const next = {
      ArrowLeft: width + KEY_STEP,
      ArrowRight: width - KEY_STEP,
      Home: minWidth,
      End: maxWidth,
    }[key];
    event.preventDefault();
    setPreferredWidth(clamp(next));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setPreferredWidth(clamp(start.width + start.x - event.clientX));
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.type !== "lostpointercapture") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleContentKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The stable portal is a React sibling of Drawer, so its events do not bubble to Drawer.
    if (!mobile || !open || event.defaultPrevented || event.key !== "Escape")
      return;
    event.stopPropagation();
    onHide();
  }

  return (
    <>
      {mobile ? (
        <Drawer
          aria-label={t("chat.sideChat.title")}
          placement="right"
          width="min(92vw, 480px)"
          open={open}
          onClose={onHide}
          closable={false}
          keyboard={open}
          forceRender
          styles={{
            body: { padding: 0, paddingTop: "env(safe-area-inset-top, 0px)" },
          }}
          rootStyle={{ visibility: open ? undefined : "hidden" }}
        >
          <div className={styles.contentSlot} ref={attachContent} />
        </Drawer>
      ) : (
        <div
          className={styles.desktop}
          ref={shellRef}
          hidden={!open}
          style={{ width }}
        >
          {open && (
            <div
              className={styles.separator}
              role="separator"
              tabIndex={0}
              aria-label={t("chat.sideChat.resize")}
              aria-orientation="vertical"
              aria-controls={panelId}
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              onKeyDown={resizeByKeyboard}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={stopDrag}
              onPointerCancel={stopDrag}
              onLostPointerCapture={stopDrag}
            />
          )}
          <div
            id={panelId}
            className={styles.contentSlot}
            ref={attachContent}
          />
        </div>
      )}
      {createPortal(
        <div className={styles.content} onKeyDown={handleContentKeyDown}>
          {children}
        </div>,
        contentHost,
      )}
    </>
  );
}
