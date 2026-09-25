import React from "react";
import { useSlideFrom } from "./ledger/motion";
import { LayoutGrid, AlignLeft, BookOpen, TrendingUp, FlaskConical } from "lucide-react";

export type TabType = "floor" | "queue" | "book" | "learning" | "lab";

interface BottomNavBarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  pendingQueueCount: number;
}

const TABS: { id: TabType; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { id: "floor", label: "Floor", icon: LayoutGrid },
  { id: "queue", label: "Queue", icon: AlignLeft },
  { id: "book", label: "Book", icon: BookOpen },
  { id: "learning", label: "Learning", icon: TrendingUp },
  { id: "lab", label: "Lab", icon: FlaskConical },
];

/** The tabs left to right, so a tab change can slide the right way. */
export const TAB_ORDER: TabType[] = TABS.map((t) => t.id);

/** The class that slides a newly picked tab in from the side it sits on in the bar (see useSlideFrom). */
export function useTabSlide(activeTab: TabType): string | undefined {
  return useSlideFrom(activeTab, TAB_ORDER);
}

export const BottomNavBar: React.FC<BottomNavBarProps> = ({ activeTab, onTabChange, pendingQueueCount }) => {
  const activeIndex = Math.max(0, TAB_ORDER.indexOf(activeTab));
  return (
    <nav
      aria-label="Main"
      className="fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-line pt-1 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none font-ui"
    >
      <div className="relative max-w-lg mx-auto grid grid-cols-5">
        {/* A short bar above the active tab that slides to the new one. */}
        <span
          aria-hidden="true"
          data-testid="tab-indicator"
          className="nx-tab-indicator absolute -top-1 left-0 w-1/5 h-[3px] flex justify-center pointer-events-none"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        >
          <span className="w-8 h-full rounded-b-full bg-accent" />
        </span>
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = activeTab === id;
          const badge = id === "queue" && pendingQueueCount > 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-current={isActive ? "page" : undefined}
              aria-label={badge ? `${label}, ${pendingQueueCount} waiting` : label}
              className={`relative min-h-14 flex flex-col items-center justify-center gap-1 text-[11px] cursor-pointer transition-colors ${
                isActive ? "text-accent font-bold" : "text-muted font-medium hover:text-ink"
              }`}
            >
              {/* Keyed on being active so the icon's bounce plays each time the tab is picked. */}
              <span key={isActive ? "on" : "off"} className={`relative${isActive ? " nx-tab-bounce" : ""}`}>
                <Icon className="w-5 h-5" strokeWidth={isActive ? 2 : 1.6} />
                {badge && (
                  <span
                    key={pendingQueueCount}
                    className="nx-badge-pop absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-bold leading-4 text-center"
                  >
                    {pendingQueueCount}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
