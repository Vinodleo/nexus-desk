import React from "react";
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

export const BottomNavBar: React.FC<BottomNavBarProps> = ({ activeTab, onTabChange, pendingQueueCount }) => (
  <nav
    aria-label="Main"
    className="fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-line pt-1 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none font-ui"
  >
    <div className="max-w-lg mx-auto grid grid-cols-5">
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
            <span className="relative">
              <Icon className="w-5 h-5" strokeWidth={1.6} />
              {badge && (
                <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-bold leading-4 text-center">
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
