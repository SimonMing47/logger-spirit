"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type VirtualListHandle = {
  scrollToIndex: (
    index: number,
    options?: { align?: "start" | "center" | "end" },
  ) => void;
  scrollToOffset: (offset: number) => void;
};

type VirtualListProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  itemCount: number;
  itemHeight: number;
  overscan?: number;
  renderRow: (index: number, style: React.CSSProperties) => React.ReactNode;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const VirtualList = forwardRef<VirtualListHandle, VirtualListProps>(function VirtualList(
  {
    itemCount,
    itemHeight,
    overscan = 6,
    className,
    style,
    onScroll,
    renderRow,
    ...rest
  }: VirtualListProps,
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      scrollToOffset: (offset: number) => {
        const el = containerRef.current;
        if (!el || itemHeight <= 0 || itemCount <= 0) {
          return;
        }

        const maxScroll = Math.max(0, itemCount * itemHeight - el.clientHeight);
        const next = clamp(offset, 0, maxScroll);
        el.scrollTop = next;
        setScrollTop(next);
      },
      scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => {
        const el = containerRef.current;
        if (!el || itemHeight <= 0 || itemCount <= 0) {
          return;
        }

        const safeIndex = clamp(index, 0, itemCount - 1);
        const maxScroll = Math.max(0, itemCount * itemHeight - el.clientHeight);
        const align = options?.align ?? "start";

        let offset = safeIndex * itemHeight;
        if (align === "center") {
          offset = safeIndex * itemHeight - el.clientHeight / 2 + itemHeight / 2;
        } else if (align === "end") {
          offset = safeIndex * itemHeight - el.clientHeight + itemHeight;
        }

        const next = clamp(offset, 0, maxScroll);
        el.scrollTop = next;
        setScrollTop(next);
      },
    }),
    [itemCount, itemHeight],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    setViewportHeight(el.clientHeight);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    if (itemCount <= 0 || itemHeight <= 0 || viewportHeight <= 0) {
      return { start: 0, end: -1, topPad: 0, bottomPad: 0 };
    }

    const rawStart = Math.floor(scrollTop / itemHeight);
    const start = Math.max(0, rawStart - overscan);
    const visibleCount = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
    const end = Math.min(itemCount - 1, start + visibleCount - 1);

    const topPad = start * itemHeight;
    const bottomPad = Math.max(0, (itemCount - end - 1) * itemHeight);

    return { start, end, topPad, bottomPad };
  }, [itemCount, itemHeight, overscan, scrollTop, viewportHeight]);

  const rows = useMemo(() => {
    if (range.end < range.start) {
      return [];
    }

    const styleForRow: React.CSSProperties = { height: itemHeight };
    const rendered: React.ReactNode[] = [];
    for (let index = range.start; index <= range.end; index += 1) {
      rendered.push(
        <div key={index} style={styleForRow}>
          {renderRow(index, styleForRow)}
        </div>,
      );
    }

    return rendered;
  }, [itemHeight, range.end, range.start, renderRow]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
      onScroll={(event) => {
        setScrollTop((event.currentTarget as HTMLDivElement).scrollTop);
        onScroll?.(event);
      }}
      {...rest}
    >
      {range.topPad > 0 ? <div style={{ height: range.topPad }} /> : null}
      {rows}
      {range.bottomPad > 0 ? <div style={{ height: range.bottomPad }} /> : null}
    </div>
  );
});

VirtualList.displayName = "VirtualList";
