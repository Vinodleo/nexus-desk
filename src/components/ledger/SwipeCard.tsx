import React, { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { prefersReducedMotion } from "./motion";

// A card you can swipe: right for one action, left for the other. A drag
// only counts once it's clearly sideways (a mostly-vertical drag scrolls the
// page as usual), and only commits past a clear distance or with a quick
// flick; anything less springs back. What's behind the card says what
// letting go will do.

/** Past this share of the card's width, letting go commits. */
export const SWIPE_COMMIT_SHARE = 0.35;
/** …but never less than this many pixels. */
export const SWIPE_COMMIT_MIN_PX = 110;
/** A flick this fast (px/ms) commits from a shorter distance… */
export const SWIPE_FLICK_SPEED = 0.6;
/** …if it has moved at least this far. */
export const SWIPE_FLICK_MIN_PX = 60;
/** How long the card takes to fly off. */
const FLY_MS = 240;
/** Movement before deciding whether a drag is sideways or a scroll. */
const DECIDE_PX = 10;

export type SwipeSide = "right" | "left";

/** What letting go does: commit to a side, or spring back (null). */
export function swipeOutcome(dx: number, width: number, speedPxPerMs: number): SwipeSide | null {
  const far = Math.abs(dx) >= Math.max(SWIPE_COMMIT_MIN_PX, width * SWIPE_COMMIT_SHARE);
  const flick = Math.abs(dx) >= SWIPE_FLICK_MIN_PX && Math.abs(speedPxPerMs) >= SWIPE_FLICK_SPEED && Math.sign(speedPxPerMs) === Math.sign(dx);
  if (!far && !flick) return null;
  return dx > 0 ? "right" : "left";
}

export const SwipeCard: React.FC<{
  /** Swiping right; off when not given (the card only moves a little that way). */
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  rightLabel?: string;
  leftLabel?: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onSwipeRight, onSwipeLeft, rightLabel = "Approve", leftLabel = "Skip", disabled, children }) => {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [flying, setFlying] = useState<SwipeSide | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; mode: "undecided" | "swipe" | "scroll"; lastX: number; lastT: number; speed: number } | null>(
    null
  );
  /** Swallows the click that follows a drag, so a swipe never also presses a button. */
  const suppressClick = useRef(false);

  const allowed = (side: SwipeSide) => (side === "right" ? Boolean(onSwipeRight) : Boolean(onSwipeLeft));

  // Once it's flying off, the action runs as the card leaves.
  const actions = useRef({ onSwipeRight, onSwipeLeft });
  actions.current = { onSwipeRight, onSwipeLeft };
  useEffect(() => {
    if (!flying) return;
    const t = setTimeout(() => (flying === "right" ? actions.current.onSwipeRight?.() : actions.current.onSwipeLeft?.()), prefersReducedMotion() ? 0 : FLY_MS);
    return () => clearTimeout(t);
  }, [flying]);

  const onPointerDown = (e: React.PointerEvent) => {
    suppressClick.current = false;
    if (disabled || flying || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: "undecided", lastX: e.clientX, lastT: e.timeStamp, speed: 0 };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (d.mode === "undecided") {
      if (Math.abs(mx) < DECIDE_PX && Math.abs(my) < DECIDE_PX) return;
      d.mode = Math.abs(mx) > Math.abs(my) * 1.5 ? "swipe" : "scroll";
      if (d.mode === "scroll") return;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {}
      setDragging(true);
    }
    if (d.mode !== "swipe") return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.speed = (e.clientX - d.lastX) / dt;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    // A side that isn't allowed only gives a little, with resistance.
    setDx(allowed(mx > 0 ? "right" : "left") ? mx : Math.sign(mx) * Math.min(40, Math.abs(mx) / 4));
  };

  const finish = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.mode !== "swipe") return;
    suppressClick.current = true;
    setDragging(false);
    const width = card.current?.offsetWidth || 320;
    const side = swipeOutcome(dx, width, d.speed);
    if (side && allowed(side)) {
      setFlying(side);
    } else {
      setDx(0);
    }
  };

  const width = card.current?.offsetWidth || 320;
  const progress = Math.min(1, Math.abs(dx) / Math.max(SWIPE_COMMIT_MIN_PX, width * SWIPE_COMMIT_SHARE));
  const showing: SwipeSide | null = flying ?? (dx > 0 && onSwipeRight ? "right" : dx < 0 && onSwipeLeft ? "left" : null);
  const transform = flying
    ? `translateX(${flying === "right" ? 130 : -130}%) rotate(${flying === "right" ? 8 : -8}deg)`
    : dx
    ? `translateX(${dx}px) rotate(${dx / 30}deg)`
    : undefined;

  return (
    <div className="relative">
      {/* What letting go will do, revealed behind the card. */}
      {showing && (
        <div
          aria-hidden="true"
          data-testid="swipe-underlay"
          className={`absolute inset-0 rounded-[18px] flex items-center px-7 text-[15px] font-semibold ${
            showing === "right" ? "justify-start bg-gain text-on-accent" : "justify-end bg-inset text-muted border border-line"
          }`}
          style={{ opacity: flying ? 1 : 0.35 + 0.65 * progress }}
        >
          <span className="flex items-center gap-2" style={{ transform: `scale(${0.85 + 0.25 * progress})` }}>
            {showing === "right" ? <Check className="w-5 h-5" strokeWidth={2.4} /> : null}
            {showing === "right" ? rightLabel : leftLabel}
            {showing === "left" ? <X className="w-5 h-5" strokeWidth={2.4} /> : null}
          </span>
        </div>
      )}
      <div
        ref={card}
        data-testid="swipe-card"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={(e) => {
          if (drag.current?.id !== e.pointerId) return;
          drag.current = null;
          setDragging(false);
          setDx(0);
        }}
        onClickCapture={(e) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
        className="relative touch-pan-y"
        style={{
          transform,
          transition: dragging ? "none" : flying ? `transform ${FLY_MS}ms ease-in, opacity ${FLY_MS}ms ease-in` : "transform 280ms cubic-bezier(0.3, 1.3, 0.5, 1)",
          opacity: flying ? 0 : 1,
        }}
      >
        {children}
      </div>
    </div>
  );
};
