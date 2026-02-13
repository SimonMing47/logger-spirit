"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CanvasItem,
  CanvasShape,
  CanvasShapeType,
  CanvasState,
  LogReference,
} from "@/types/logspace";

type CanvasBoardProps = {
  value: CanvasState;
  onChange: (next: CanvasState) => void;
  activeLogRef?: string | null;
  onOpenLinkedLog?: (ref: LogReference) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
};

type CanvasTool =
  | "select"
  | "note"
  | "text"
  | "line"
  | "rect"
  | "ellipse"
  | "arrow";

type CanvasSelection =
  | {
      itemIds: string[];
      shapeIds: string[];
      primary: {
        kind: "item" | "shape";
        id: string;
      };
    }
  | null;

type DraftShape = {
  type: CanvasShapeType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type DraftTextBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type SelectionBox = {
  pointerId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type PanState = {
  startX: number;
  startY: number;
  originOffsetX: number;
  originOffsetY: number;
};

type DragSession = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  zoom: number;
  moved: boolean;
  lockX: boolean;
  items: Array<{
    id: string;
    originX: number;
    originY: number;
    lockedX: boolean;
  }>;
  shapes: Array<{
    id: string;
    originX1: number;
    originY1: number;
    originX2: number;
    originY2: number;
  }>;
  otherX: number[];
  otherY: number[];
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
};

const BOARD_WIDTH = 3200;
const BOARD_HEIGHT = 1800;
const NOTE_WIDTH = 240;
const NOTE_HEIGHT = 96;
const TEXT_MIN_WIDTH = 140;
const TEXT_HEIGHT = 44;
const TIMELINE_Y = 220;
const TIMELINE_MARGIN_X = 120;
const TIMELINE_STROKE = "#7596ee";
const TIMELINE_LINK_STROKE = "#5f7fd8";
const SNAP_THRESHOLD = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function canvasItemWidth(item: CanvasItem): number {
  return item.kind === "note"
    ? (item.width ?? NOTE_WIDTH)
    : (item.width ?? TEXT_MIN_WIDTH);
}

function canvasItemHeight(item: CanvasItem): number {
  return item.kind === "note" ? NOTE_HEIGHT : TEXT_HEIGHT;
}

function computeTimelineLayout(items: CanvasItem[]): {
  xById: Map<string, number>;
  minTimestamp?: number;
  maxTimestamp?: number;
} {
  const timeItems = items.filter((item) => typeof item.timestamp === "number");
  const xById = new Map<string, number>();

  if (timeItems.length === 0) {
    return { xById };
  }

  const timestamps = timeItems.map((item) => item.timestamp as number);
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);
  const range = Math.max(1, maxTimestamp - minTimestamp);
  const usableWidth = Math.max(1, BOARD_WIDTH - TIMELINE_MARGIN_X * 2);

  for (const item of timeItems) {
    const width = canvasItemWidth(item);
    const centerX =
      timeItems.length === 1
        ? BOARD_WIDTH / 2
        : TIMELINE_MARGIN_X + (((item.timestamp as number) - minTimestamp) / range) * usableWidth;
    const x = clamp(centerX - width / 2, 0, BOARD_WIDTH - width);
    xById.set(item.id, x);
  }

  return { xById, minTimestamp, maxTimestamp };
}

function randomPaperColor(): string {
  const palette = [
    "#f9edb8",
    "#f6d1dd",
    "#d5eff3",
    "#ffe1bc",
    "#d7f3d7",
    "#e0e0ff",
  ];
  return palette[Math.floor(Math.random() * palette.length)] ?? "#f9edb8";
}

function createCanvasItem(input: {
  kind: "note" | "text";
  text: string;
  x: number;
  y: number;
  color: string;
  width?: number;
  link?: LogReference;
  timestamp?: number;
  comment?: string;
}): CanvasItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    text: input.text,
    x: input.x,
    y: input.y,
    color: input.color,
    textColor: input.kind === "text" ? input.color : "#24325f",
    width: input.kind === "note" ? NOTE_WIDTH : input.width,
    link: input.link,
    timestamp: input.timestamp,
    comment: input.comment,
  };
}

function createShapeFromDraft(
  draft: DraftShape,
  color: string,
  strokeWidth: number,
): CanvasShape {
  return {
    id: `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: draft.type,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    color,
    strokeWidth,
    fill: draft.type === "rect" || draft.type === "ellipse" ? `${color}22` : undefined,
  };
}

function shapeRect(shape: CanvasShape | DraftShape | DraftTextBox) {
  const left = Math.min(shape.x1, shape.x2);
  const top = Math.min(shape.y1, shape.y2);
  const width = Math.abs(shape.x2 - shape.x1);
  const height = Math.abs(shape.y2 - shape.y1);

  return { left, top, width, height };
}

function arrowHeadPoints(shape: CanvasShape): string {
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const size = 8 + shape.strokeWidth;

  const x = shape.x2;
  const y = shape.y2;

  const leftX = x - size * Math.cos(angle - Math.PI / 6);
  const leftY = y - size * Math.sin(angle - Math.PI / 6);
  const rightX = x - size * Math.cos(angle + Math.PI / 6);
  const rightY = y - size * Math.sin(angle + Math.PI / 6);

  return `${x},${y} ${leftX},${leftY} ${rightX},${rightY}`;
}

function toolToShape(tool: CanvasTool): CanvasShapeType | null {
  if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "arrow") {
    return tool;
  }
  return null;
}

function logRefKey(link: LogReference): string {
  return `${link.rootId}::${link.filePath}::${link.line}`;
}

function formatTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function CanvasBoard({
  value,
  onChange,
  activeLogRef,
  onOpenLinkedLog,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: CanvasBoardProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [tool, setTool] = useState<CanvasTool>("select");
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [draftShape, setDraftShape] = useState<DraftShape | null>(null);
  const [draftTextBox, setDraftTextBox] = useState<DraftTextBox | null>(null);
  const [panState, setPanState] = useState<PanState | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number } | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const dragSessionRef = useRef<DragSession | null>(null);
  const valueRef = useRef(value);
  const clipboardRef = useRef<{ items: CanvasItem[]; shapes: CanvasShape[] } | null>(null);

  const boardStyle = useMemo(
    () => ({
      transform: `translate(${value.offsetX}px, ${value.offsetY}px) scale(${value.zoom})`,
      transformOrigin: "0 0",
    }),
    [value.offsetX, value.offsetY, value.zoom],
  );

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const toWorldPoint = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }

    const x = (clientX - rect.left - value.offsetX) / value.zoom;
    const y = (clientY - rect.top - value.offsetY) / value.zoom;

    return {
      x: clamp(x, 0, BOARD_WIDTH),
      y: clamp(y, 0, BOARD_HEIGHT),
    };
  };

  const patchCanvas = useCallback(
    (patch: Partial<CanvasState>) => {
      const next = { ...valueRef.current, ...patch };
      valueRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const selectSingle = useCallback(
    (kind: "item" | "shape", id: string) => {
      setSelection({
        itemIds: kind === "item" ? [id] : [],
        shapeIds: kind === "shape" ? [id] : [],
        primary: { kind, id },
      });
    },
    [setSelection],
  );

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, [setSelection]);

  const addSnippet = (
    text: string,
    x: number,
    y: number,
    link?: LogReference,
    timestamp?: number,
  ) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const note = createCanvasItem({
      kind: "note",
      text: normalized,
      x,
      y,
      color: randomPaperColor(),
      link,
      timestamp,
    });

    const nextItems = [...valueRef.current.items, note];
    const timeline = computeTimelineLayout(nextItems);
    const renderX = timeline.xById.get(note.id) ?? note.x;
    const itemWidth = canvasItemWidth(note);
    const itemHeight = canvasItemHeight(note);

    const viewport = viewportRef.current?.getBoundingClientRect();
    const zoom = valueRef.current.zoom;

    let nextOffsetX = valueRef.current.offsetX;
    let nextOffsetY = valueRef.current.offsetY;

    if (viewport) {
      const worldLeft = (-valueRef.current.offsetX) / zoom;
      const worldTop = (-valueRef.current.offsetY) / zoom;
      const worldRight = (viewport.width - valueRef.current.offsetX) / zoom;
      const worldBottom = (viewport.height - valueRef.current.offsetY) / zoom;

      const marginWorldX = 28 / zoom;
      const marginWorldY = 22 / zoom;

      const itemLeft = renderX;
      const itemTop = note.y;
      const itemRight = renderX + itemWidth;
      const itemBottom = note.y + itemHeight;

      const fullyVisible =
        itemLeft >= worldLeft + marginWorldX &&
        itemRight <= worldRight - marginWorldX &&
        itemTop >= worldTop + marginWorldY &&
        itemBottom <= worldBottom - marginWorldY;

      if (!fullyVisible) {
        nextOffsetX = viewport.width / 2 - (renderX + itemWidth / 2) * zoom;
        nextOffsetY = viewport.height / 2 - (note.y + itemHeight / 2) * zoom;
      }
    }

    patchCanvas({
      items: nextItems,
      offsetX: nextOffsetX,
      offsetY: nextOffsetY,
    });
    selectSingle("item", note.id);
  };

  const deleteItem = (id: string) => {
    patchCanvas({
      items: valueRef.current.items.filter((item) => item.id !== id),
    });

    setSelection((current) => {
      if (!current) {
        return current;
      }
      const nextItemIds = current.itemIds.filter((itemId) => itemId !== id);
      if (nextItemIds.length === 0 && current.shapeIds.length === 0) {
        return null;
      }

      const nextPrimary =
        current.primary.kind === "item" && current.primary.id === id
          ? current.shapeIds.length > 0
            ? { kind: "shape" as const, id: current.shapeIds[0] }
            : { kind: "item" as const, id: nextItemIds[0] }
          : current.primary;

      return {
        itemIds: nextItemIds,
        shapeIds: current.shapeIds,
        primary: nextPrimary,
      };
    });
  };

  const applyColorToSelection = () => {
    if (!selection) {
      return;
    }

    const selectedItems = new Set(selection.itemIds);
    const selectedShapes = new Set(selection.shapeIds);

    patchCanvas({
      items: valueRef.current.items.map((item) => {
        if (!selectedItems.has(item.id)) {
          return item;
        }

        if (item.kind === "text") {
          return {
            ...item,
            color: valueRef.current.activeColor,
            textColor: valueRef.current.activeColor,
          };
        }

        return { ...item, color: valueRef.current.activeColor };
      }),
      shapes: valueRef.current.shapes.map((shape) =>
        selectedShapes.has(shape.id)
          ? {
              ...shape,
              color: valueRef.current.activeColor,
              fill:
                shape.type === "rect" || shape.type === "ellipse"
                  ? `${valueRef.current.activeColor}22`
                  : shape.fill,
            }
          : shape,
      ),
    });
  };

  const handleBoardPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const pointer = toWorldPoint(event.clientX, event.clientY);

    if (event.button === 1 || (event.button === 0 && spacePressed)) {
      setPanState({
        startX: event.clientX,
        startY: event.clientY,
        originOffsetX: value.offsetX,
        originOffsetY: value.offsetY,
      });
      event.preventDefault();
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    if (tool === "note") {
      const note = createCanvasItem({
        kind: "note",
        text: "双击编辑便签",
        x: pointer.x,
        y: pointer.y,
        color: randomPaperColor(),
      });
      patchCanvas({ items: [...valueRef.current.items, note] });
      selectSingle("item", note.id);
      setEditingItemId(null);
      return;
    }

    if (tool === "text") {
      setDraftTextBox({
        x1: pointer.x,
        y1: pointer.y,
        x2: pointer.x,
        y2: pointer.y,
      });
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    const shapeType = toolToShape(tool);
    if (shapeType) {
      setDraftShape({
        type: shapeType,
        x1: pointer.x,
        y1: pointer.y,
        x2: pointer.x,
        y2: pointer.y,
      });
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "select") {
      clearSelection();
      setEditingItemId(null);
      setSelectionBox({
        pointerId: event.pointerId,
        x1: pointer.x,
        y1: pointer.y,
        x2: pointer.x,
        y2: pointer.y,
      });
      event.preventDefault();
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    clearSelection();
    setEditingItemId(null);
  };

  const handleBoardPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (panState) {
      patchCanvas({
        offsetX: panState.originOffsetX + (event.clientX - panState.startX),
        offsetY: panState.originOffsetY + (event.clientY - panState.startY),
      });
      return;
    }

    const pointer = toWorldPoint(event.clientX, event.clientY);

    if (selectionBox && selectionBox.pointerId === event.pointerId) {
      setSelectionBox((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          x2: pointer.x,
          y2: pointer.y,
        };
      });
      return;
    }

    setDraftShape((current) => {
      if (!current) {
        return current;
      }

      let nextX = pointer.x;
      let nextY = pointer.y;

      if (event.shiftKey) {
        const dx = pointer.x - current.x1;
        const dy = pointer.y - current.y1;

        if (current.type === "line" || current.type === "arrow") {
          const length = Math.hypot(dx, dy);
          if (length > 0.001) {
            const step = Math.PI / 12;
            const angle = Math.atan2(dy, dx);
            const snapped = Math.round(angle / step) * step;
            nextX = current.x1 + Math.cos(snapped) * length;
            nextY = current.y1 + Math.sin(snapped) * length;
          }
        } else if (current.type === "rect" || current.type === "ellipse") {
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          const signX = dx === 0 ? 1 : Math.sign(dx);
          const signY = dy === 0 ? 1 : Math.sign(dy);
          nextX = current.x1 + signX * size;
          nextY = current.y1 + signY * size;
        }
      }

      return {
        ...current,
        x2: clamp(nextX, 0, BOARD_WIDTH),
        y2: clamp(nextY, 0, BOARD_HEIGHT),
      };
    });

    setDraftTextBox((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        x2: pointer.x,
        y2: pointer.y,
      };
    });
  };

  const finishInteraction = (event?: React.PointerEvent<SVGSVGElement>) => {
    if (event && svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    if (panState) {
      setPanState(null);
      return;
    }

    if (selectionBox && event && selectionBox.pointerId === event.pointerId) {
      const left = Math.min(selectionBox.x1, selectionBox.x2);
      const top = Math.min(selectionBox.y1, selectionBox.y2);
      const right = Math.max(selectionBox.x1, selectionBox.x2);
      const bottom = Math.max(selectionBox.y1, selectionBox.y2);
      const width = right - left;
      const height = bottom - top;

      setSelectionBox(null);
      setSnapGuides(null);

      if (width < 4 && height < 4) {
        clearSelection();
        return;
      }

      const hitsItemIds: string[] = [];
      const hitsShapeIds: string[] = [];

      valueRef.current.items.forEach((item) => {
        const x = timelineLayout.xById.get(item.id) ?? item.x;
        const y = item.y;
        const w = canvasItemWidth(item);
        const h = canvasItemHeight(item);
        const itemLeft = x;
        const itemTop = y;
        const itemRight = x + w;
        const itemBottom = y + h;

        const intersects =
          itemRight >= left && itemLeft <= right && itemBottom >= top && itemTop <= bottom;

        if (intersects) {
          hitsItemIds.push(item.id);
        }
      });

      valueRef.current.shapes.forEach((shape) => {
        const rect = shapeRect(shape);
        const shapeLeft = rect.left;
        const shapeTop = rect.top;
        const shapeRight = rect.left + rect.width;
        const shapeBottom = rect.top + rect.height;

        const intersects =
          shapeRight >= left && shapeLeft <= right && shapeBottom >= top && shapeTop <= bottom;

        if (intersects) {
          hitsShapeIds.push(shape.id);
        }
      });

      if (hitsItemIds.length === 0 && hitsShapeIds.length === 0) {
        clearSelection();
        return;
      }

      setSelection({
        itemIds: hitsItemIds,
        shapeIds: hitsShapeIds,
        primary:
          hitsItemIds.length > 0
            ? { kind: "item", id: hitsItemIds[0] }
            : { kind: "shape", id: hitsShapeIds[0] },
      });
      return;
    }

    if (draftTextBox) {
      const rect = shapeRect(draftTextBox);
      const textItem = createCanvasItem({
        kind: "text",
        text: "",
        x: rect.left,
        y: rect.top,
        color: valueRef.current.activeColor,
        width: clamp(rect.width || TEXT_MIN_WIDTH, TEXT_MIN_WIDTH, 1000),
      });

      patchCanvas({
        items: [...valueRef.current.items, textItem],
      });
      selectSingle("item", textItem.id);
      setEditingItemId(textItem.id);
      setDraftTextBox(null);
      return;
    }

    if (!draftShape) {
      return;
    }

    const width = Math.abs(draftShape.x2 - draftShape.x1);
    const height = Math.abs(draftShape.y2 - draftShape.y1);

    if (width < 2 && height < 2) {
      setDraftShape(null);
      return;
    }

    const nextShape = createShapeFromDraft(
      draftShape,
      valueRef.current.activeColor,
      valueRef.current.strokeWidth,
    );

    patchCanvas({ shapes: [...valueRef.current.shapes, nextShape] });
    selectSingle("shape", nextShape.id);
    setDraftShape(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const viewport = viewportRef.current;
      if (!viewport || document.activeElement !== viewport) {
        return;
      }

      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          onRedo?.();
        } else {
          onUndo?.();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "y") {
        event.preventDefault();
        onRedo?.();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "a") {
        if (selection && selection.itemIds.length + selection.shapeIds.length > 0) {
          // Let browser select text when there is an active selection inside the canvas item.
          const selectedText = window.getSelection()?.toString().trim() ?? "";
          if (selectedText) {
            return;
          }
        }

        event.preventDefault();
        const allItemIds = valueRef.current.items.map((item) => item.id);
        const allShapeIds = valueRef.current.shapes.map((shape) => shape.id);
        if (allItemIds.length === 0 && allShapeIds.length === 0) {
          clearSelection();
          return;
        }
        setSelection({
          itemIds: allItemIds,
          shapeIds: allShapeIds,
          primary:
            allItemIds.length > 0
              ? { kind: "item", id: allItemIds[0] }
              : { kind: "shape", id: allShapeIds[0] },
        });
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "c") {
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        if (selectedText) {
          return;
        }
        if (!selection) {
          return;
        }
        event.preventDefault();
        clipboardRef.current = {
          items: valueRef.current.items.filter((item) => selection.itemIds.includes(item.id)),
          shapes: valueRef.current.shapes.filter((shape) => selection.shapeIds.includes(shape.id)),
        };
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "v") {
        const selectedText = window.getSelection()?.toString().trim() ?? "";
        if (selectedText) {
          return;
        }

        const clip = clipboardRef.current;
        if (!clip || (clip.items.length === 0 && clip.shapes.length === 0)) {
          return;
        }

        event.preventDefault();
        const now = Date.now();
        const clonedItems = clip.items.map((item, index) => ({
          ...item,
          id: `item-${now}-${Math.random().toString(36).slice(2, 8)}-${index}`,
          x: item.x + 18,
          y: item.y + 18,
        }));
        const clonedShapes = clip.shapes.map((shape, index) => ({
          ...shape,
          id: `shape-${now}-${Math.random().toString(36).slice(2, 8)}-${index}`,
          x1: shape.x1 + 18,
          y1: shape.y1 + 18,
          x2: shape.x2 + 18,
          y2: shape.y2 + 18,
        }));

        patchCanvas({
          items: [...valueRef.current.items, ...clonedItems],
          shapes: [...valueRef.current.shapes, ...clonedShapes],
        });

        setSelection({
          itemIds: clonedItems.map((item) => item.id),
          shapeIds: clonedShapes.map((shape) => shape.id),
          primary:
            clonedItems.length > 0
              ? { kind: "item", id: clonedItems[0].id }
              : { kind: "shape", id: clonedShapes[0].id },
        });
        setTool("select");
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        setSpacePressed(true);
        return;
      }

      if (event.key === "Escape") {
        clearSelection();
        setEditingItemId(null);
        setDraftShape(null);
        setDraftTextBox(null);
        setSelectionBox(null);
        setPanState(null);
        setSnapGuides(null);
        setTool("select");
        return;
      }

      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        ["v", "n", "t", "l", "r", "o", "a"].includes(key)
      ) {
        event.preventDefault();
        if (key === "v") {
          setTool("select");
        } else if (key === "n") {
          setTool("note");
        } else if (key === "t") {
          setTool("text");
        } else if (key === "l") {
          setTool("line");
        } else if (key === "r") {
          setTool("rect");
        } else if (key === "o") {
          setTool("ellipse");
        } else if (key === "a") {
          setTool("arrow");
        }
        return;
      }

      if (!editingItemId && selection && tool === "select") {
        const step = event.shiftKey ? 16 : 4;
        const dx =
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        const dy =
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0;

        if (dx !== 0 || dy !== 0) {
          event.preventDefault();

          const selectedItems = new Set(selection.itemIds);
          const selectedShapes = new Set(selection.shapeIds);

          patchCanvas({
            items: valueRef.current.items.map((item) => {
              if (!selectedItems.has(item.id)) {
                return item;
              }
              const width = canvasItemWidth(item);
              const nextX =
                typeof item.timestamp === "number"
                  ? item.x
                  : clamp(item.x + dx, 0, BOARD_WIDTH - width);
              const nextY = clamp(item.y + dy, 0, BOARD_HEIGHT - 60);
              return { ...item, x: nextX, y: nextY };
            }),
            shapes: valueRef.current.shapes.map((shape) => {
              if (!selectedShapes.has(shape.id)) {
                return shape;
              }
              const next = {
                ...shape,
                x1: clamp(shape.x1 + dx, 0, BOARD_WIDTH),
                y1: clamp(shape.y1 + dy, 0, BOARD_HEIGHT),
                x2: clamp(shape.x2 + dx, 0, BOARD_WIDTH),
                y2: clamp(shape.y2 + dy, 0, BOARD_HEIGHT),
              };
              return next;
            }),
          });
          return;
        }
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (!selection) {
        return;
      }

      event.preventDefault();

      const selectedItems = new Set(selection.itemIds);
      const selectedShapes = new Set(selection.shapeIds);

      patchCanvas({
        items: valueRef.current.items.filter((item) => !selectedItems.has(item.id)),
        shapes: valueRef.current.shapes.filter((shape) => !selectedShapes.has(shape.id)),
      });

      if (editingItemId && selectedItems.has(editingItemId)) {
        setEditingItemId(null);
      }

      clearSelection();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") {
        setSpacePressed(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    clearSelection,
    editingItemId,
    onRedo,
    onUndo,
    patchCanvas,
    selection,
    tool,
  ]);

  const timelineLayout = computeTimelineLayout(value.items);

  const toggleSelection = useCallback(
    (kind: "item" | "shape", id: string) => {
      setSelection((current) => {
        if (!current) {
          return {
            itemIds: kind === "item" ? [id] : [],
            shapeIds: kind === "shape" ? [id] : [],
            primary: { kind, id },
          };
        }

        const nextItemIds =
          kind === "item"
            ? current.itemIds.includes(id)
              ? current.itemIds.filter((itemId) => itemId !== id)
              : [...current.itemIds, id]
            : current.itemIds;

        const nextShapeIds =
          kind === "shape"
            ? current.shapeIds.includes(id)
              ? current.shapeIds.filter((shapeId) => shapeId !== id)
              : [...current.shapeIds, id]
            : current.shapeIds;

        if (nextItemIds.length === 0 && nextShapeIds.length === 0) {
          return null;
        }

        const removedPrimary = current.primary.kind === kind && current.primary.id === id;
        const nextPrimary = removedPrimary
          ? nextItemIds.length > 0
            ? { kind: "item" as const, id: nextItemIds[0] }
            : { kind: "shape" as const, id: nextShapeIds[0] }
          : current.primary;

        return {
          itemIds: nextItemIds,
          shapeIds: nextShapeIds,
          primary: nextPrimary,
        };
      });
    },
    [setSelection],
  );

  const beginDragSession = useCallback(
    (event: React.PointerEvent, selectionToDrag: CanvasSelection, clickedLink?: LogReference) => {
      if (!selectionToDrag) {
        return;
      }

      if (dragSessionRef.current) {
        return;
      }

      event.preventDefault();

      const startClientX = event.clientX;
      const startClientY = event.clientY;

      let currentItems = valueRef.current.items;
      let currentShapes = valueRef.current.shapes;
      let workingSelection = selectionToDrag;

      if (event.altKey) {
        const now = Date.now();
        const newItemIds: string[] = [];
        const newShapeIds: string[] = [];

        const clonedItems: CanvasItem[] = [];
        selectionToDrag.itemIds.forEach((itemId, index) => {
          const original = currentItems.find((item) => item.id === itemId);
          if (!original) {
            return;
          }
          const cloned: CanvasItem = {
            ...original,
            id: `item-${now}-${Math.random().toString(36).slice(2, 8)}-${index}`,
            x: original.x + 18,
            y: original.y + 18,
          };
          clonedItems.push(cloned);
          newItemIds.push(cloned.id);
        });

        const clonedShapes: CanvasShape[] = [];
        selectionToDrag.shapeIds.forEach((shapeId, index) => {
          const original = currentShapes.find((shape) => shape.id === shapeId);
          if (!original) {
            return;
          }
          const cloned: CanvasShape = {
            ...original,
            id: `shape-${now}-${Math.random().toString(36).slice(2, 8)}-${index}`,
            x1: original.x1 + 18,
            y1: original.y1 + 18,
            x2: original.x2 + 18,
            y2: original.y2 + 18,
          };
          clonedShapes.push(cloned);
          newShapeIds.push(cloned.id);
        });

        currentItems = [...currentItems, ...clonedItems];
        currentShapes = [...currentShapes, ...clonedShapes];

        workingSelection = {
          itemIds: newItemIds,
          shapeIds: newShapeIds,
          primary:
            newItemIds.length > 0
              ? { kind: "item", id: newItemIds[0] }
              : { kind: "shape", id: newShapeIds[0] },
        };

        patchCanvas({
          items: currentItems,
          shapes: currentShapes,
        });
        setSelection(workingSelection);
      }

      const timeline = computeTimelineLayout(currentItems);
      const selectedItemSet = new Set(workingSelection.itemIds);
      const selectedShapeSet = new Set(workingSelection.shapeIds);

      const sessionItems = workingSelection.itemIds
        .map((itemId) => {
          const item = currentItems.find((candidate) => candidate.id === itemId);
          if (!item) {
            return null;
          }
          return {
            id: itemId,
            originX: timeline.xById.get(itemId) ?? item.x,
            originY: item.y,
            lockedX: typeof item.timestamp === "number",
          };
        })
        .filter(Boolean) as DragSession["items"];

      const sessionShapes = workingSelection.shapeIds
        .map((shapeId) => {
          const shape = currentShapes.find((candidate) => candidate.id === shapeId);
          if (!shape) {
            return null;
          }
          return {
            id: shapeId,
            originX1: shape.x1,
            originY1: shape.y1,
            originX2: shape.x2,
            originY2: shape.y2,
          };
        })
        .filter(Boolean) as DragSession["shapes"];

      const lockX = sessionItems.some((item) => item.lockedX);

      const otherX: number[] = [];
      const otherY: number[] = [];

      currentItems.forEach((item) => {
        if (selectedItemSet.has(item.id)) {
          return;
        }

        const x = timeline.xById.get(item.id) ?? item.x;
        const y = item.y;
        const w = canvasItemWidth(item);
        const h = canvasItemHeight(item);

        otherX.push(x, x + w / 2, x + w);
        otherY.push(y, y + h / 2, y + h);
      });

      currentShapes.forEach((shape) => {
        if (selectedShapeSet.has(shape.id)) {
          return;
        }

        const rect = shapeRect(shape);
        const x = rect.left;
        const y = rect.top;
        const w = rect.width;
        const h = rect.height;

        otherX.push(x, x + w / 2, x + w);
        otherY.push(y, y + h / 2, y + h);
      });

      const move = (moveEvent: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || session.pointerId !== moveEvent.pointerId) {
          return;
        }

        let dx = (moveEvent.clientX - session.startClientX) / session.zoom;
        let dy = (moveEvent.clientY - session.startClientY) / session.zoom;

        if (!session.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
          session.moved = true;
        }

        if (moveEvent.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) {
            dy = 0;
          } else {
            dx = 0;
          }
        }

        if (session.lockX) {
          dx = 0;
        }

        // Compute snap based on group bounds.
        let snapDx = 0;
        let snapDy = 0;
        let guideX: number | undefined;
        let guideY: number | undefined;

        const groupBounds = {
          left: Infinity,
          right: -Infinity,
          top: Infinity,
          bottom: -Infinity,
        };

        session.items.forEach((itemEntry) => {
          const current = valueRef.current.items.find((item) => item.id === itemEntry.id);
          if (!current) {
            return;
          }
          const w = canvasItemWidth(current);
          const h = canvasItemHeight(current);
          const x = itemEntry.lockedX ? itemEntry.originX : itemEntry.originX + dx;
          const y = itemEntry.originY + dy;
          groupBounds.left = Math.min(groupBounds.left, x);
          groupBounds.right = Math.max(groupBounds.right, x + w);
          groupBounds.top = Math.min(groupBounds.top, y);
          groupBounds.bottom = Math.max(groupBounds.bottom, y + h);
        });

        session.shapes.forEach((shapeEntry) => {
          const rect = shapeRect({
            x1: shapeEntry.originX1 + dx,
            y1: shapeEntry.originY1 + dy,
            x2: shapeEntry.originX2 + dx,
            y2: shapeEntry.originY2 + dy,
          });
          groupBounds.left = Math.min(groupBounds.left, rect.left);
          groupBounds.right = Math.max(groupBounds.right, rect.left + rect.width);
          groupBounds.top = Math.min(groupBounds.top, rect.top);
          groupBounds.bottom = Math.max(groupBounds.bottom, rect.top + rect.height);
        });

        if (Number.isFinite(groupBounds.left)) {
          const groupCenterX = (groupBounds.left + groupBounds.right) / 2;
          const groupCenterY = (groupBounds.top + groupBounds.bottom) / 2;
          const groupLinesX = [groupBounds.left, groupCenterX, groupBounds.right];
          const groupLinesY = [groupBounds.top, groupCenterY, groupBounds.bottom];

          if (!session.lockX) {
            let best = SNAP_THRESHOLD + 1;
            groupLinesX.forEach((line) => {
              session.otherX.forEach((target) => {
                const diff = target - line;
                if (Math.abs(diff) <= SNAP_THRESHOLD && Math.abs(diff) < Math.abs(best)) {
                  best = diff;
                  guideX = target;
                }
              });
            });
            if (guideX !== undefined) {
              snapDx = best;
            }
          }

          let bestY = SNAP_THRESHOLD + 1;
          groupLinesY.forEach((line) => {
            session.otherY.forEach((target) => {
              const diff = target - line;
              if (Math.abs(diff) <= SNAP_THRESHOLD && Math.abs(diff) < Math.abs(bestY)) {
                bestY = diff;
                guideY = target;
              }
            });
          });
          if (guideY !== undefined) {
            snapDy = bestY;
          }
        }

        dx += snapDx;
        dy += snapDy;

        setSnapGuides(guideX !== undefined || guideY !== undefined ? { x: guideX, y: guideY } : null);

        const nextItems = valueRef.current.items.map((item) => {
          const entry = session.items.find((candidate) => candidate.id === item.id);
          if (!entry) {
            return item;
          }

          const w = canvasItemWidth(item);
          const nextX = entry.lockedX ? item.x : clamp(entry.originX + dx, 0, BOARD_WIDTH - w);
          const nextY = clamp(entry.originY + dy, 0, BOARD_HEIGHT - 60);

          return {
            ...item,
            x: nextX,
            y: nextY,
          };
        });

        const nextShapes = valueRef.current.shapes.map((shape) => {
          const entry = session.shapes.find((candidate) => candidate.id === shape.id);
          if (!entry) {
            return shape;
          }

          return {
            ...shape,
            x1: clamp(entry.originX1 + dx, 0, BOARD_WIDTH),
            y1: clamp(entry.originY1 + dy, 0, BOARD_HEIGHT),
            x2: clamp(entry.originX2 + dx, 0, BOARD_WIDTH),
            y2: clamp(entry.originY2 + dy, 0, BOARD_HEIGHT),
          };
        });

        patchCanvas({
          items: nextItems,
          shapes: nextShapes,
        });
      };

      const up = (upEvent: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || session.pointerId !== upEvent.pointerId) {
          return;
        }

        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        dragSessionRef.current = null;
        setDragging(false);
        setSnapGuides(null);

        if (!session.moved && clickedLink && onOpenLinkedLog) {
          onOpenLinkedLog(clickedLink);
        }
      };

      dragSessionRef.current = {
        pointerId: event.pointerId,
        startClientX,
        startClientY,
        zoom: valueRef.current.zoom,
        moved: false,
        lockX,
        items: sessionItems,
        shapes: sessionShapes,
        otherX,
        otherY,
        move,
        up,
      };

      setDragging(true);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onOpenLinkedLog, patchCanvas, setDragging, setSelection, setSnapGuides],
  );

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    viewportRef.current?.focus();

    const point = toWorldPoint(event.clientX, event.clientY);

    const rawSnippet =
      event.dataTransfer.getData("application/logger-snippet") ||
      event.dataTransfer.getData("application/json") ||
      event.dataTransfer.getData("text/plain");

    if (!rawSnippet) {
      return;
    }

    try {
      const parsed = JSON.parse(rawSnippet) as {
        text?: string;
        link?: LogReference;
        timestamp?: number;
      };
      addSnippet(parsed.text ?? "", point.x, point.y, parsed.link, parsed.timestamp);
    } catch {
      addSnippet(rawSnippet, point.x, point.y);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      patchCanvas({
        offsetX: valueRef.current.offsetX - event.deltaX,
        offsetY: valueRef.current.offsetY - event.deltaY,
      });
      return;
    }

    event.preventDefault();

    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    const zoomFactor = event.deltaY < 0 ? 1.08 : 0.92;
    const nextZoom = clamp(value.zoom * zoomFactor, 0.25, 4);

    const worldX = (cursorX - value.offsetX) / value.zoom;
    const worldY = (cursorY - value.offsetY) / value.zoom;

    patchCanvas({
      zoom: nextZoom,
      offsetX: cursorX - worldX * nextZoom,
      offsetY: cursorY - worldY * nextZoom,
    });
  };

  const renderShape = (shape: CanvasShape, draft = false) => {
    const isSelected = !draft && (selection?.shapeIds.includes(shape.id) ?? false);
    const common = {
      stroke: shape.color,
      strokeWidth: shape.strokeWidth,
      className: isSelected ? "shape-selected" : "",
    };

    if (shape.type === "line" || shape.type === "arrow") {
      return (
        <g
          key={shape.id}
          onPointerDown={(event) => {
            if (draft || event.button !== 0) {
              return;
            }
            event.stopPropagation();

            if (event.metaKey || event.ctrlKey) {
              toggleSelection("shape", shape.id);
              return;
            }

            let selectionToDrag = selection;
            if (!selectionToDrag || !selectionToDrag.shapeIds.includes(shape.id)) {
              selectionToDrag = {
                itemIds: [],
                shapeIds: [shape.id],
                primary: { kind: "shape", id: shape.id },
              };
              setSelection(selectionToDrag);
            }

            beginDragSession(event, selectionToDrag);
          }}
          style={{ cursor: dragging && isSelected ? "grabbing" : "grab" }}
        >
          <line
            x1={shape.x1}
            y1={shape.y1}
            x2={shape.x2}
            y2={shape.y2}
            stroke="transparent"
            strokeWidth={shape.strokeWidth + 14}
          />
          <line
            x1={shape.x1}
            y1={shape.y1}
            x2={shape.x2}
            y2={shape.y2}
            {...common}
            fill="none"
          />
          {shape.type === "arrow" ? (
            <polygon points={arrowHeadPoints(shape)} fill={shape.color} />
          ) : null}
        </g>
      );
    }

    const rect = shapeRect(shape);

    if (shape.type === "rect") {
      return (
        <g
          key={shape.id}
          onPointerDown={(event) => {
            if (draft || event.button !== 0) {
              return;
            }
            event.stopPropagation();

            if (event.metaKey || event.ctrlKey) {
              toggleSelection("shape", shape.id);
              return;
            }

            let selectionToDrag = selection;
            if (!selectionToDrag || !selectionToDrag.shapeIds.includes(shape.id)) {
              selectionToDrag = {
                itemIds: [],
                shapeIds: [shape.id],
                primary: { kind: "shape", id: shape.id },
              };
              setSelection(selectionToDrag);
            }

            beginDragSession(event, selectionToDrag);
          }}
          style={{ cursor: dragging && isSelected ? "grabbing" : "grab" }}
        >
          <rect
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            fill="transparent"
            stroke="transparent"
            strokeWidth={shape.strokeWidth + 18}
          />
          <rect
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            fill={shape.fill ?? "transparent"}
            {...common}
          />
        </g>
      );
    }

    return (
      <g
        key={shape.id}
        onPointerDown={(event) => {
          if (draft || event.button !== 0) {
            return;
          }
          event.stopPropagation();

          if (event.metaKey || event.ctrlKey) {
            toggleSelection("shape", shape.id);
            return;
          }

          let selectionToDrag = selection;
          if (!selectionToDrag || !selectionToDrag.shapeIds.includes(shape.id)) {
            selectionToDrag = {
              itemIds: [],
              shapeIds: [shape.id],
              primary: { kind: "shape", id: shape.id },
            };
            setSelection(selectionToDrag);
          }

          beginDragSession(event, selectionToDrag);
        }}
        style={{ cursor: dragging && isSelected ? "grabbing" : "grab" }}
      >
        <ellipse
          cx={rect.left + rect.width / 2}
          cy={rect.top + rect.height / 2}
          rx={rect.width / 2}
          ry={rect.height / 2}
          fill="transparent"
          stroke="transparent"
          strokeWidth={shape.strokeWidth + 18}
        />
        <ellipse
          cx={rect.left + rect.width / 2}
          cy={rect.top + rect.height / 2}
          rx={rect.width / 2}
          ry={rect.height / 2}
          fill={shape.fill ?? "transparent"}
          {...common}
        />
      </g>
  );
  };

  const selectedEntityLabel = (() => {
    if (!selection) {
      return "未选中对象";
    }

    const itemCount = selection.itemIds.length;
    const shapeCount = selection.shapeIds.length;
    if (itemCount > 0 && shapeCount > 0) {
      return `已选 ${itemCount} 条便签/文本 + ${shapeCount} 个图形`;
    }
    if (itemCount > 0) {
      return `已选 ${itemCount} 条便签/文本`;
    }
    return `已选 ${shapeCount} 个图形`;
  })();

  return (
    <div className="canvas-wrapper">
      <div className="canvas-toolbar">
        {[
          ["select", "选择"],
          ["note", "便签"],
          ["text", "文字"],
          ["line", "画线"],
          ["rect", "矩形"],
          ["ellipse", "椭圆"],
          ["arrow", "箭头"],
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={`tool-button ${tool === key ? "active" : ""}`}
            onClick={() => setTool(key as CanvasTool)}
          >
            {label}
          </button>
        ))}

        <label className="color-picker">
          <span>颜色</span>
          <input
            type="color"
            value={value.activeColor}
            onChange={(event) => patchCanvas({ activeColor: event.target.value })}
          />
        </label>

        <label className="stroke-picker">
          <span>线宽</span>
          <input
            type="range"
            min={1}
            max={10}
            value={value.strokeWidth}
            onChange={(event) =>
              patchCanvas({ strokeWidth: Number.parseInt(event.target.value, 10) || 2 })
            }
          />
        </label>

        <button
          type="button"
          className="ghost-button"
          disabled={!selection}
          onClick={applyColorToSelection}
        >
          颜色应用到选中
        </button>

        <button
          type="button"
          className="ghost-button"
          disabled={!onUndo || !canUndo}
          onClick={onUndo}
          title="Ctrl/⌘ + Z"
        >
          撤销
        </button>

        <button
          type="button"
          className="ghost-button"
          disabled={!onRedo || !canRedo}
          onClick={onRedo}
          title="Ctrl/⌘ + Shift + Z"
        >
          重做
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={() => patchCanvas({ zoom: clamp(value.zoom - 0.1, 0.25, 4) })}
        >
          缩小
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={() => patchCanvas({ zoom: clamp(value.zoom + 0.1, 0.25, 4) })}
        >
          放大
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={() => patchCanvas({ zoom: 1, offsetX: 20, offsetY: 20 })}
        >
          重置视图
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={() => setShowClearConfirm(true)}
        >
          清空画板
        </button>
      </div>

      <p className="muted">
        {selectedEntityLabel}。Ctrl/⌘ + 滚轮缩放；滚轮平移；Space 拖拽平移；Shift 约束方向；Alt
        拖拽复制；Ctrl/⌘+Z 撤销，Shift+Z 重做；Ctrl/⌘+C/V 复制粘贴。
      </p>

      <div
        className={`canvas-viewport ${dropActive ? "drop-active" : ""}`}
        ref={viewportRef}
        tabIndex={0}
        aria-label="线索画板"
        onPointerDown={() => {
          viewportRef.current?.focus();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!dropActive) {
            setDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={handleDrop}
        onWheel={handleWheel}
      >
        <div className="canvas-board" style={boardStyle}>
          <svg
            ref={svgRef}
            className="canvas-svg"
            width={BOARD_WIDTH}
            height={BOARD_HEIGHT}
            onPointerDown={handleBoardPointerDown}
            onPointerMove={handleBoardPointerMove}
            onPointerUp={(event) => finishInteraction(event)}
            onPointerCancel={(event) => finishInteraction(event)}
          >
            <rect
              x={0}
              y={0}
              width={BOARD_WIDTH}
              height={BOARD_HEIGHT}
              fill="transparent"
              onClick={() => {
                if (tool === "select") {
                  clearSelection();
                }
              }}
            />

            <g className="timeline-lane">
              <line
                x1={34}
                y1={TIMELINE_Y}
                x2={BOARD_WIDTH - 34}
                y2={TIMELINE_Y}
                stroke={TIMELINE_STROKE}
                strokeWidth={2}
              />
              <text x={42} y={TIMELINE_Y - 10} className="timeline-lane-label">
                时间线
              </text>
              {typeof timelineLayout.minTimestamp === "number" &&
              typeof timelineLayout.maxTimestamp === "number" ? (
                <>
                  <text
                    x={TIMELINE_MARGIN_X}
                    y={TIMELINE_Y + 18}
                    className="timeline-lane-label"
                  >
                    {formatTimeLabel(timelineLayout.minTimestamp)}
                  </text>
                  <text
                    x={BOARD_WIDTH - TIMELINE_MARGIN_X}
                    y={TIMELINE_Y + 18}
                    textAnchor="end"
                    className="timeline-lane-label"
                  >
                    {formatTimeLabel(timelineLayout.maxTimestamp)}
                  </text>
                </>
              ) : null}
            </g>

            {value.items
              .filter((item) => typeof item.timestamp === "number")
              .map((item) => {
                const renderX = timelineLayout.xById.get(item.id) ?? item.x;
                const itemWidth = canvasItemWidth(item);
                const centerX = renderX + itemWidth / 2;

                return (
                  <g key={`timeline-link-${item.id}`} className="timeline-link-group">
                    <line
                      x1={centerX}
                      y1={TIMELINE_Y}
                      x2={centerX}
                      y2={item.y}
                      stroke={TIMELINE_LINK_STROKE}
                      strokeWidth={1.4}
                      strokeDasharray="6 4"
                    />
                    <text
                      x={centerX + 6}
                      y={(TIMELINE_Y + item.y) / 2 - 3}
                      className="timeline-link-label"
                    >
                      {formatTimeLabel(item.timestamp as number)}
                    </text>
                  </g>
                );
              })}

            {value.shapes.map((shape) => renderShape(shape))}
            {draftShape
              ? renderShape(
                  createShapeFromDraft(draftShape, value.activeColor, value.strokeWidth),
                  true,
                )
              : null}
            {draftTextBox ? (
              <rect
                x={shapeRect(draftTextBox).left}
                y={shapeRect(draftTextBox).top}
                width={Math.max(shapeRect(draftTextBox).width, TEXT_MIN_WIDTH)}
                height={Math.max(shapeRect(draftTextBox).height, 36)}
                fill="transparent"
                stroke={value.activeColor}
                strokeWidth={1.5}
                strokeDasharray="6 4"
              />
            ) : null}

            {snapGuides?.x !== undefined ? (
              <line
                className="snap-guide"
                x1={snapGuides.x}
                x2={snapGuides.x}
                y1={0}
                y2={BOARD_HEIGHT}
                stroke="#4f75ff"
                strokeWidth={1}
                strokeDasharray="6 6"
              />
            ) : null}
            {snapGuides?.y !== undefined ? (
              <line
                className="snap-guide"
                x1={0}
                x2={BOARD_WIDTH}
                y1={snapGuides.y}
                y2={snapGuides.y}
                stroke="#4f75ff"
                strokeWidth={1}
                strokeDasharray="6 6"
              />
            ) : null}

            {selectionBox ? (
              <rect
                className="selection-box"
                x={Math.min(selectionBox.x1, selectionBox.x2)}
                y={Math.min(selectionBox.y1, selectionBox.y2)}
                width={Math.abs(selectionBox.x2 - selectionBox.x1)}
                height={Math.abs(selectionBox.y2 - selectionBox.y1)}
                fill="#4f75ff10"
                stroke="#4f75ff"
                strokeWidth={1.25}
                strokeDasharray="6 5"
              />
            ) : null}
          </svg>

          {value.items.map((item) => {
            const isSelected = selection?.itemIds.includes(item.id) ?? false;
            const isActiveLink =
              item.link && activeLogRef ? logRefKey(item.link) === activeLogRef : false;
            const isEditingItem = editingItemId === item.id;
            const renderX = timelineLayout.xById.get(item.id) ?? item.x;
            const isTimelineLocked = typeof item.timestamp === "number";

            const className = item.kind === "text" ? "canvas-text-item" : "canvas-card";

            return (
              <div
                className={`${className} ${isSelected ? "canvas-item-selected" : ""} ${isActiveLink ? "canvas-log-active" : ""}`}
                key={item.id}
                style={{
                  left: renderX,
                  top: item.y,
                  background: item.kind === "note" ? item.color : "transparent",
                  color: item.kind === "text" ? item.textColor ?? item.color : "#23335a",
                  width:
                    item.kind === "note"
                      ? item.width ?? NOTE_WIDTH
                      : item.kind === "text"
                        ? item.width ?? TEXT_MIN_WIDTH
                        : "auto",
                  cursor:
                    isEditingItem ? "text" : dragging && isSelected ? "grabbing" : "grab",
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || isEditingItem) {
                    return;
                  }

                  event.stopPropagation();

                  if (event.metaKey || event.ctrlKey) {
                    toggleSelection("item", item.id);
                    return;
                  }

                  let selectionToDrag = selection;
                  if (!selectionToDrag || !selectionToDrag.itemIds.includes(item.id)) {
                    selectionToDrag = {
                      itemIds: [item.id],
                      shapeIds: [],
                      primary: { kind: "item", id: item.id },
                    };
                    setSelection(selectionToDrag);
                  }

                  beginDragSession(event, selectionToDrag, item.link);
                }}
                onDoubleClick={() => {
                  setEditingItemId(item.id);
                }}
              >
                <button
                  type="button"
                  className="card-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteItem(item.id);
                  }}
                >
                  ×
                </button>

                {isEditingItem ? (
                  <textarea
                    className="canvas-inline-input"
                    value={item.text}
                    autoFocus
                    placeholder={item.kind === "text" ? "输入文本..." : "编辑便签..."}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      patchCanvas({
                        items: valueRef.current.items.map((current) =>
                          current.id === item.id ? { ...current, text: nextText } : current,
                        ),
                      });
                    }}
                    onBlur={() => {
                      setEditingItemId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setEditingItemId(null);
                      }
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        setEditingItemId(null);
                      }
                    }}
                  />
                ) : (
                  <p>{item.text || (item.kind === "text" ? "双击输入文本" : "")}</p>
                )}

                {item.link ? (
                  isSelected ? (
                    <div className="canvas-comment">
                      <div className="canvas-comment-head">
                        <span className="muted">备注</span>
                        {isTimelineLocked ? (
                          <span
                            className="canvas-lock-hint"
                            title="该日志块按时间线自动排序，左右位置锁定"
                          >
                            时间线锁定
                          </span>
                        ) : null}
                      </div>
                      <textarea
                        className="canvas-comment-input"
                        value={item.comment ?? ""}
                        placeholder="给该日志块补充你的推断/结论/下一步验证..."
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const next = event.target.value;
                          patchCanvas({
                            items: valueRef.current.items.map((current) =>
                              current.id === item.id ? { ...current, comment: next } : current,
                            ),
                          });
                        }}
                      />
                    </div>
                  ) : item.comment?.trim() ? (
                    <div className="canvas-comment-preview" title={item.comment}>
                      备注：{item.comment}
                    </div>
                  ) : null
                ) : null}

                <div className="canvas-chip-row">
                  {item.link ? (
                    <button
                      type="button"
                      className="canvas-link-chip"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (onOpenLinkedLog) {
                          onOpenLinkedLog(item.link as LogReference);
                        }
                      }}
                    >
                      {item.link.sourceName}:{item.link.line}
                    </button>
                  ) : null}

                  {typeof item.timestamp === "number" ? (
                    <button
                      type="button"
                      className="canvas-link-chip canvas-time-chip"
                      title="按时间线自动排序，左右位置锁定"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {formatTimeLabel(item.timestamp)}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}

        </div>
      </div>

      {showClearConfirm ? (
        <div className="canvas-modal-backdrop">
          <div className="canvas-modal-card">
            <h4>清空画板</h4>
            <p>确认清空当前画板中的所有日志块和图形？此操作会立即保存。</p>
            <div className="canvas-modal-actions">
              <button
                type="button"
                className="ghost-button tiny"
                onClick={() => setShowClearConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button tiny"
                onClick={() => {
                  patchCanvas({
                    items: [],
                    shapes: [],
                  });
                  setSelection(null);
                  setEditingItemId(null);
                  setShowClearConfirm(false);
                }}
              >
                确认清空
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
